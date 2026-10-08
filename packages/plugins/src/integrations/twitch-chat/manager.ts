// TwitchChatManager — the process-wide (one per bot process; see `../index.ts`'s module-level singleton
// instantiation) owner of the EventSub WebSocket connection and the reconcile loop that keeps its subscriptions
// matching every enabled `TwitchChatChannel` row. The chat bot belongs to the STREAMER (ARCHITECTURE.md §19e, phase
// 4), so a channel runs on its own `enabled` flag alone, whether or not it is linked to a Discord server and whatever
// that server's `integrations` plugin state is: custom commands, timers, the built-ins, the channel's own currency
// (economy commands + chat earning, `ChannelEconomy`, §18b) and channel-point SOUND/CHAT/TTS rewards (the broadcaster
// token lives in `TwitchBroadcasterToken`, TTS runs on the channel's own OpenAI key). Only what acts INSIDE a Discord
// server (the Discord bridge, DISCORD reward actions) needs a linked server AND that server's `integrations` plugin
// on — a server admin's off switch still governs what Pavisie does in their server — and is otherwise quietly skipped.
//
// Since the channel-points extension, a channel can carry up to TWO independent EventSub subscriptions —
// `channel.chat.message` (always, on the bot identity's token) and `channel.channel_points_custom_reward_
// redemption.add` (only when `rewardsEnabled` and the broadcaster has granted `channel:read:redemptions`, on
// the BROADCASTER's own token) — so the bookkeeping below tracks them separately per channel rather than
// assuming 1:1, and `forgetSubscription`/the reconcile diff operate per subscription type: a channel can lose
// its rewards subscription (rewards turned off, scope revoked) while chat keeps running, and vice versa.
import type { ChannelEconomy, TwitchChatChannel, TwitchChatCommand, TwitchChatReward } from '@pavisie/database';
import { randomUUID } from 'node:crypto';
import { MessageFlags, WebhookClient, type Guild } from 'discord.js';
import { decryptSecret, redisKey } from '@pavisie/core';
import { resolveTextChannel, type PluginContext, type TwitchChatRuntimeStatus, type TwitchChatService } from '../../sdk';
import { creditChannel } from '../../channel-economy/ledger';
import { postAlert } from '../embeds';
import {
  EVENTSUB_WS_URL,
  EventSubSocket,
  defaultWebSocketConstructor,
  type EventSubNotification,
  type EventSubRevocation,
  type WebSocketConstructorLike,
} from './socket';
import { getBroadcasterAccessToken } from './broadcaster-token';
import {
  createChatSubscription,
  createRewardRedemptionSubscription,
  deleteEventSubSubscription,
  getBotIdentityRow,
  getChannelInfo,
  getStream,
  getUserByLogin,
  pruneSendThrottle,
  sendChatMessage,
} from './helix';
import { CommandCooldowns, handleChatMessage } from './engine';
import { handleEconomyChatCommand, type EconomyCommandResult } from './economy-commands';
import { createEconomyChatPort } from './economy-port';
import { earnCooldownKey, isExcludedChatBotLogin, reserveDailyEarnBudget } from './economy-earn';
import { RewardCooldowns, matchRewardActions, type RewardAction } from './rewards';
import { synthesizeTts } from './tts';
import { formatTwitchToDiscord, toBridgeWebhookUsername } from './bridge-format';
import { pruneBridgeDropCount, recordBridgeDrop } from './bridge-metrics';
import { pruneBridgeSendBucket, takeBridgeSendToken } from './bridge-ratelimit';
import {
  checkBridgeChannelAccess,
  clearBridgeWebhook,
  ensureBridgeWebhook,
  UNKNOWN_WEBHOOK_ERROR_CODE,
} from './bridge-webhook';

/** One WebSocket session supports up to 300 zero-cost EventSub subscriptions (SPEC.md). Each linked channel can
 * now cost up to TWO of those — a `channel.chat.message` subscription plus a `channel.channel_points_custom_
 * reward_redemption.add` subscription once rewards are enabled for it — so the channel cap is half the raw
 * subscription cap, not equal to it (worst case: every linked channel has rewards enabled). */
const MAX_CHANNELS = 150;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** Retry schedule for a STARTUP that throws (not a socket that dies — that has its own `backoffMs`): on a deploy
 * the bot can boot before the api's pre-deploy migration has finished, so the very first database read fails
 * ("column does not exist"). Retried forever, 5s doubling up to 60s, until `stop()` or one attempt succeeds. */
const START_RETRY_INITIAL_MS = 5000;
const START_RETRY_MAX_MS = 60_000;
/** Twitch's own idle-socket message. Shown to the operator instead of Twitch's raw wording. */
const NO_CHANNELS_IDLE_REASON = 'no linked Twitch channels yet';
/** Written to `TwitchChatChannel.lastError` when rewards are enabled but the broadcaster hasn't (re-)granted
 * `channel:read:redemptions` — surfaced on the creator dashboard rather than failing silently. */
const REWARDS_SCOPE_MISSING_ERROR =
  'Channel-point rewards are on, but Pavisie does not have channel-point redemption permission (channel:read:redemptions) for this channel. Authorize channel points again from the creator dashboard.';
/** How long a `getStream` liveness result is trusted for the Twitch chat-earning gate before it's re-checked —
 * keeps a busy chat from costing one Helix call per message (ARCHITECTURE.md §18b/§19a). */
const LIVENESS_CACHE_TTL_MS = 60_000;
/** How long a channel's `ChannelEconomy` row (settings + on/off) is trusted in memory. Every non-command chat
 * message needs it for the earning gate, so it is cached (negative results too) rather than read per message; a
 * streamer's change on the creator dashboard therefore takes effect within this window. */
const ECONOMY_CACHE_TTL_MS = 30_000;

type SubscriptionKind = 'chat' | 'rewards';

interface SubscriptionEntry {
  subscriptionId: string;
  broadcasterUserId: string;
}

/** A channel's live subscriptions, tracked independently — either, both, or (transiently, mid-reconcile)
 * neither may be present. An entry with neither is never left in the map (see `forgetSubscription`). */
interface ChannelSubscriptions {
  chat?: SubscriptionEntry;
  rewards?: SubscriptionEntry;
}

interface ChannelCacheEntry {
  channel: TwitchChatChannel;
  commands: TwitchChatCommand[];
  rewards: TwitchChatReward[];
}

/** The subset of a `channel.chat.message` v1 notification event this manager reads. Field names are Twitch's own
 * (snake_case), matching every other Helix/EventSub payload type in this plugin. */
interface RawChatMessageEvent {
  broadcaster_user_id: string;
  chatter_user_id: string;
  /** Chatter's Twitch LOGIN (lowercase, stable) — distinct from `chatter_user_name` (display name, which can
   * carry different casing/charset). Used only to match `EXCLUDED_CHAT_BOT_LOGINS` for the chat-earning gate
   * (`tryEconomyEarn`); never logged. */
  chatter_user_login?: string;
  chatter_user_name: string;
  message?: { text?: string };
  badges?: { set_id: string }[];
}

/** The subset of a `channel.channel_points_custom_reward_redemption.add` v1 notification event this manager
 * reads. Field names are Twitch's own (snake_case). `user_input` is absent entirely when the reward doesn't
 * require viewer text — treated the same as an empty string. NEVER logged (see `rewards.ts`'s privacy note). */
interface RawRewardRedemptionEvent {
  broadcaster_user_id: string;
  user_name: string;
  user_input?: string;
  reward: { id: string; title: string };
}

/** One SOUND/TTS action's overlay pub/sub payload — this shape is a FIXED contract the overlay's SSE route (a
 * later stage) consumes verbatim, so it must not change without updating that consumer too. */
type OverlayEventPayload =
  | { id: string; kind: 'sound'; url: string; volume: number }
  | { id: string; kind: 'tts'; audioId: string; volume: number };

export class TwitchChatManager {
  private socket: EventSubSocket | null = null;
  private previousSocket: EventSubSocket | null = null;
  private sessionId: string | null = null;
  private connected = false;
  private stopped = true;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while `tryConnect` is between its first await and either opening a socket or giving up — lets
   * `reconcile` avoid firing a second, parallel connect attempt while one is already mid-flight. */
  private connecting = false;
  private lastError: string | null = null;
  /** Pending startup-retry timer and its current delay (see `START_RETRY_INITIAL_MS`). */
  private startRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private startRetryMs = START_RETRY_INITIAL_MS;
  private envConfigured = false;
  private botConfigured = false;
  /** Whether the last desired-set check found at least one channel to serve. Idle (and reported `enabled: false`)
   * whenever this is `false`, even though env + bot identity are both otherwise fine — there's simply nothing to
   * connect for yet. */
  private channelsAvailable = false;
  private idleReason: string | null = null;
  private botUserId: string | null = null;

  /** Coalesces overlapping `reconcile()` calls (minute tick, post-welcome, `reconcileNow` nudges) into a single
   * run at a time: a caller arriving while a run is already active reuses that same in-flight promise instead of
   * starting its own pass (which is what let concurrent callers race `createChatSubscription` for the same
   * channel). `reconcileQueued` records that at least one more pass is owed once the current one finishes, so
   * whatever prompted the overlapping call is still guaranteed to be picked up. */
  private reconcileInFlight: Promise<void> | null = null;
  private reconcileQueued = false;

  private readonly cooldowns = new CommandCooldowns();
  private readonly rewardCooldowns = new RewardCooldowns();
  private readonly subscriptionsByChannelId = new Map<string, ChannelSubscriptions>();
  private readonly channelIdByBroadcasterId = new Map<string, string>();
  private readonly channelCache = new Map<string, ChannelCacheEntry>();
  /** Discord <-> Twitch chat bridge: which announce-once messages have already been sent for a channel, per
   * direction independently. Module-instance-lifetime, not persisted — see `runBridgeReconcile`'s doc comment. */
  private readonly bridgeAnnounced = new Map<string, { discordToTwitch: boolean; twitchToDiscord: boolean }>();
  /** One cached `WebhookClient` per `TwitchChatChannel.id` for the Twitch -> Discord relay direction, so a busy
   * Twitch chat reuses a single discord.js rate-limit bucket instead of building (and throwing away) a fresh
   * client per message — see `relayTwitchToDiscordIfBridged`'s and `runBridgeReconcile`'s doc comments for the
   * populate/invalidate points. Module-instance-lifetime, not persisted. */
  private readonly bridgeWebhookClients = new Map<string, WebhookClient>();
  /** Twitch chat earning's liveness gate: one cached `getStream` result per broadcaster user id, refreshed at
   * most every `LIVENESS_CACHE_TTL_MS` (see `isChannelLive`) so a busy chat costs at most one Helix call per
   * minute rather than one per message. */
  private readonly livenessCache = new Map<string, { isLive: boolean; fetchedAtMs: number }>();
  /** The channel's own currency (`ChannelEconomy`), by broadcaster user id — `null` means "none, or switched off".
   * See `ECONOMY_CACHE_TTL_MS`. */
  private readonly economyCache = new Map<string, { economy: ChannelEconomy | null; fetchedAtMs: number }>();
  /** The last error text written to `TwitchChatChannel.lastError` for each channel (from send-drops, scope
   * revocations, etc.) — used to avoid redundant database writes when the error hasn't changed. Only drop-related
   * errors and subscription revocation errors are cached here; other transient errors leave this as `null` so
   * they're re-written on every occurrence. */
  private readonly lastErrorByChannelId = new Map<string, string | null>();

  constructor(private readonly wsCtor: WebSocketConstructorLike = defaultWebSocketConstructor) {}

  /** Attempts an initial connection; never throws — a missing env/bot-identity/linked-channel just leaves the
   * manager idle with a reason `status()` reports, and every later `reconcile(ctx)` tick retries (so completing
   * owner setup or linking the first channel later, with no bot restart, brings the manager up on its own). A
   * startup that THROWS (typically the database not being migrated yet on a fresh deploy) is logged and retried on
   * a capped backoff (5s doubling to 60s, forever, until `stop()`), and the minute `reconcile` tick retries the
   * connect independently as well — so a transient failure never leaves Twitch chat dead until a manual restart.
   * Must not be awaited by `onLoad` — this resolves once the *attempt* finishes, not once the socket is actually
   * connected. */
  async start(ctx: PluginContext): Promise<void> {
    this.stopped = false;
    this.clearStartRetry();
    this.startRetryMs = START_RETRY_INITIAL_MS;
    await this.attemptStart(ctx);
  }

  private async attemptStart(ctx: PluginContext): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tryConnect(ctx);
      // Whether it connected or went cleanly idle, the startup problem (if any) is over.
      this.clearStartRetry();
      this.startRetryMs = START_RETRY_INITIAL_MS;
    } catch (err) {
      const delayMs = this.startRetryMs;
      this.startRetryMs = Math.min(this.startRetryMs * 2, START_RETRY_MAX_MS);
      ctx.logger.error(
        { err, retryInMs: delayMs },
        'integrations/twitch-chat: manager failed to start; will retry',
      );
      if (this.stopped || this.startRetryTimer) return;
      this.startRetryTimer = setTimeout(() => {
        this.startRetryTimer = null;
        void this.attemptStart(ctx);
      }, delayMs);
    }
  }

  private clearStartRetry(): void {
    if (this.startRetryTimer) {
      clearTimeout(this.startRetryTimer);
      this.startRetryTimer = null;
    }
  }

  /** Closes the socket (and any in-flight reconnect-follow socket) and stops scheduling reconnects. Safe to call
   * even if never successfully connected. Does not clear channel/command cache — `start()` can be called again
   * later (not currently done anywhere, but keeps the class honest about what "stop" means). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearStartRetry();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.previousSocket?.close();
    this.previousSocket = null;
    this.connected = false;
    this.sessionId = null;
  }

  /** Channel ids the manager currently has a live `channel.chat.message` subscription for — `timers.ts` only
   * fires a timer message into a channel whose CHAT delivery is actually connected (a channel with only a
   * rewards subscription live, e.g. while chat is mid-reconnect, can't receive a chat-sent timer message). */
  connectedChannelIds(): string[] {
    return [...this.subscriptionsByChannelId.entries()]
      .filter(([, subs]) => Boolean(subs.chat))
      .map(([channelId]) => channelId);
  }

  status(): TwitchChatRuntimeStatus {
    if (!this.envConfigured || !this.botConfigured || !this.channelsAvailable) {
      return {
        enabled: false,
        reason: this.idleReason ?? 'Twitch chat is not configured on this deployment.',
        connected: false,
        sessionId: null,
        joinedChannels: 0,
        lastError: this.lastError,
      };
    }
    return {
      enabled: true,
      reason: this.connected ? undefined : (this.lastError ?? 'Reconnecting to Twitch EventSub…'),
      connected: this.connected,
      sessionId: this.sessionId,
      joinedChannels: this.subscriptionsByChannelId.size,
      lastError: this.lastError,
    };
  }

  /** Every enabled `TwitchChatChannel` row, uncapped. There is deliberately NO per-guild plugin gate here (removed in
   * creator-dashboard phase 4): the chat bot belongs to the streamer, so turning the `integrations` plugin off in a
   * linked Discord server must not stop it. The guild's plugin state is instead consulted at each point that acts
   * inside that server (`isGuildIntegrationsOn`).
   * Shared by `tryConnect` (which only needs to know whether this is empty, to decide whether opening a socket is
   * even worthwhile) and `reconcile` (which needs the full list to diff against). */
  private async computeDesiredChannels(ctx: PluginContext): Promise<TwitchChatChannel[]> {
    return ctx.prisma.twitchChatChannel.findMany({ where: { enabled: true } });
  }

  /** Whether a Discord-server-side feature may act for this channel: it needs a linked server AND that server's
   * `integrations` plugin on (`ctx.isEnabled`, the same per-guild enablement contract every other plugin uses). Never
   * throws — a lookup failure counts as "not enabled" so a Discord-side action is skipped rather than guessed. */
  private async isGuildIntegrationsOn(ctx: PluginContext, guildId: string | null): Promise<boolean> {
    if (!guildId) return false;
    try {
      return await ctx.isEnabled(guildId);
    } catch {
      return false;
    }
  }

  /**
   * Reconciles desired vs. actual EventSub subscriptions. Safe to call even when idle/disconnected (no-ops until
   * a session exists) — called every minute from the `twitch-chat-tick` job, on every `session_welcome`, and on
   * an owner-action `reconcileNow` nudge, which is also how the manager notices it can come out of idle
   * (env/bot-identity/first-channel configured later) or needs to be nudged back online, without a bot restart.
   *
   * Overlapping calls are coalesced (see `reconcileInFlight`/`reconcileQueued`) rather than each running its own
   * independent pass — the old direct-recursion approach let two callers race `createChatSubscription` for the
   * same channel, producing duplicate subscriptions, orphaned subscription ids, and false `ERROR` statuses on
   * channels that were actually working fine.
   */
  async reconcile(ctx: PluginContext): Promise<void> {
    if (this.reconcileInFlight) {
      this.reconcileQueued = true;
      return this.reconcileInFlight;
    }
    this.reconcileInFlight = this.runReconcileLoop(ctx);
    return this.reconcileInFlight;
  }

  private async runReconcileLoop(ctx: PluginContext): Promise<void> {
    try {
      do {
        this.reconcileQueued = false;
        await this.runReconcileOnce(ctx);
      } while (this.reconcileQueued);
    } finally {
      this.reconcileInFlight = null;
    }
  }

  private async runReconcileOnce(ctx: PluginContext): Promise<void> {
    if (!this.socket && !this.stopped && !this.connecting && this.reconnectTimer === null) {
      await this.tryConnect(ctx).catch((err: unknown) => {
        ctx.logger.error({ err }, 'integrations/twitch-chat: connect attempt failed');
      });
    }
    if (!this.sessionId) return; // idle, mid-handshake, or mid-backoff — nothing to reconcile against right now

    // The bot identity can disappear (owner disconnected it) or turn ERROR (a terminal refresh failure) while
    // we're happily connected — neither is caught by anything else once the socket is already up, since
    // `tryConnect` only runs before a session exists. Re-check it on every pass instead.
    const identity = await getBotIdentityRow(ctx).catch(() => null);
    if (!identity || identity.status === 'ERROR') {
      this.botConfigured = false;
      this.idleReason = !identity
        ? "Pavisie's Twitch bot account has not been connected yet (owner setup pending)."
        : 'Twitch bot identity needs to be reconnected (owner re-auth required).';
      this.closeSocketAndGoIdle();
      return;
    }

    const desired = await this.computeDesiredChannels(ctx);
    if (desired.length > MAX_CHANNELS) {
      ctx.logger.warn(
        { count: desired.length, max: MAX_CHANNELS },
        'integrations/twitch-chat: more linked channels than the EventSub session cap; the excess are left unsubscribed',
      );
    }
    const capped = desired.slice(0, MAX_CHANNELS);
    this.channelsAvailable = capped.length > 0;
    const desiredIds = new Set(capped.map((c) => c.id));

    // Pass 0: channels no longer desired at all (disabled/removed/guild disabled) — tear down BOTH subscription
    // kinds for them, whichever are actually live.
    for (const [channelId, subs] of [...this.subscriptionsByChannelId.entries()]) {
      if (desiredIds.has(channelId)) continue;
      if (subs.chat) {
        await deleteEventSubSubscription(ctx, subs.chat.subscriptionId).catch(() => undefined);
        this.forgetSubscription(channelId, subs.chat.broadcasterUserId, 'chat');
      }
      if (subs.rewards) {
        await deleteEventSubSubscription(ctx, subs.rewards.subscriptionId).catch(() => undefined);
        this.forgetSubscription(channelId, subs.rewards.broadcasterUserId, 'rewards');
      }
    }

    if (capped.length === 0) {
      // The desired set just went to zero while we were connected — every subscription was already removed by
      // the loop above. Rather than leave a live, zero-subscription EventSub session running (which Twitch may
      // kill on its own anyway), close it proactively and go idle; the next tick reconnects the moment a channel
      // reappears.
      this.idleReason = NO_CHANNELS_IDLE_REASON;
      this.closeSocketAndGoIdle();
      return;
    }

    // Pass 1: chat subscriptions — unchanged in spirit from the pre-channel-points single-subscription loop,
    // just scoped to `.chat` on the per-channel entry.
    for (const channel of capped) {
      const existing = this.subscriptionsByChannelId.get(channel.id);
      if (existing?.chat) {
        await this.refreshChannelCache(ctx, channel);
        continue;
      }

      const sessionId = this.sessionId;
      if (!sessionId) break; // socket died partway through this loop; the next tick picks up where we left off

      const result = await createChatSubscription(ctx, sessionId, channel.broadcasterUserId);
      if (result.ok) {
        this.setSubscription(channel.id, 'chat', {
          subscriptionId: result.subscriptionId,
          broadcasterUserId: channel.broadcasterUserId,
        });
        await this.refreshChannelCache(ctx, channel);
        await ctx.prisma.twitchChatChannel
          .update({
            where: { id: channel.id },
            data: { status: 'CONNECTED', lastError: null, lastConnectedAt: new Date() },
          })
          .catch(() => undefined);
      } else {
        await ctx.prisma.twitchChatChannel
          .update({ where: { id: channel.id }, data: { status: 'ERROR', lastError: result.error.slice(0, 500) } })
          .catch(() => undefined);
      }
    }

    // Pass 2: reward-redemption subscriptions — fully independent of pass 1's outcome (a channel can have
    // rewards working while chat is down, or vice versa). Only attempted for channels with `rewardsEnabled`
    // AND a broadcaster token carrying `channel:read:redemptions`; the missing-scope case is surfaced via
    // `lastError`, never silently skipped.
    for (const channel of capped) {
      const existing = this.subscriptionsByChannelId.get(channel.id);

      if (!channel.rewardsEnabled) {
        if (existing?.rewards) {
          await deleteEventSubSubscription(ctx, existing.rewards.subscriptionId).catch(() => undefined);
          this.forgetSubscription(channel.id, existing.rewards.broadcasterUserId, 'rewards');
        }
        continue;
      }

      // The broadcaster's token/scope is re-checked BEFORE the already-subscribed short-circuit below, and
      // that ordering is load-bearing: a broadcaster can revoke `channel:read:redemptions` (or re-link
      // without it) long after the subscription was created. Checking only on creation would leave a
      // silently dead rewards subscription behind a stale `lastError`, with nothing on the creator
      // dashboard telling the streamer why redemptions stopped firing. Costs one cached-token read per
      // rewards-enabled channel per tick, which is the right trade for not failing silently.
      const token = await getBroadcasterAccessToken(ctx, channel);
      if (!token) {
        if (existing?.rewards) {
          await deleteEventSubSubscription(ctx, existing.rewards.subscriptionId).catch(() => undefined);
          this.forgetSubscription(channel.id, existing.rewards.broadcasterUserId, 'rewards');
        }
        await ctx.prisma.twitchChatChannel
          .update({ where: { id: channel.id }, data: { lastError: REWARDS_SCOPE_MISSING_ERROR } })
          .catch(() => undefined);
        continue;
      }

      if (existing?.rewards) continue; // already subscribed and the scope still checks out

      const sessionId = this.sessionId;
      if (!sessionId) break; // socket died partway through this loop; the next tick picks up where we left off

      const result = await createRewardRedemptionSubscription(ctx, sessionId, channel);
      if (result.ok) {
        this.setSubscription(channel.id, 'rewards', {
          subscriptionId: result.subscriptionId,
          broadcasterUserId: channel.broadcasterUserId,
        });
        await this.refreshChannelCache(ctx, channel);
        await ctx.prisma.twitchChatChannel
          .update({ where: { id: channel.id }, data: { lastError: null } })
          .catch(() => undefined);
      } else {
        await ctx.prisma.twitchChatChannel
          .update({ where: { id: channel.id }, data: { lastError: result.error.slice(0, 500) } })
          .catch(() => undefined);
      }
    }

    // Pass 3: Discord <-> Twitch chat bridge — fully independent of passes 1/2 (a channel's bridge can be
    // configured whether or not chat/rewards subscriptions are currently healthy, though the Twitch->Discord
    // relay itself only ever fires from `handleChatMessageNotification`, which needs the chat subscription).
    await this.runBridgeReconcile(ctx, capped);
  }

  /**
   * Discord <-> Twitch chat bridge reconcile pass: checks Discord-side channel access, provisions the bridge
   * webhook (Twitch -> Discord direction) on first enable, refreshes the channel cache so a freshly-created
   * webhook is visible to `relayTwitchToDiscordIfBridged` on the very next incoming chat message, and sends the
   * one-time "this is now bridged" announcement per direction.
   */
  private async runBridgeReconcile(ctx: PluginContext, capped: TwitchChatChannel[]): Promise<void> {
    for (const channel of capped) {
      // Fast path closing the race between a bridge Discord channel change (which nulls `bridgeWebhookId`/
      // `bridgeWebhookTokenEnc` in the DB immediately, in the API route/slash command) and this reconcile tick
      // picking it up (nudged right after that mutation, but not necessarily instant): if the freshly-read row
      // already has no stored webhook id but we're still holding a cached client for it, drop the cache entry
      // now rather than waiting for the "bridge fully off" branch below (which wouldn't even run if the bridge
      // is still on, just pointed at a different Discord channel).
      if (!channel.bridgeWebhookId && this.bridgeWebhookClients.has(channel.id)) {
        this.bridgeWebhookClients.delete(channel.id);
      }

      // A guildless channel (creator-dashboard-only) has no Discord server to bridge to: treated exactly like
      // "bridge fully off", whatever stray bridge fields the row might carry.
      const guildId = channel.guildId;
      if (
        !guildId ||
        !channel.bridgeDiscordChannelId ||
        (!channel.bridgeDiscordToTwitch && !channel.bridgeTwitchToDiscord)
      ) {
        this.bridgeAnnounced.delete(channel.id);
        pruneBridgeDropCount(channel.id);
        pruneBridgeSendBucket(channel.id);
        this.bridgeWebhookClients.delete(channel.id);
        continue;
      }

      // The server's admin has the `integrations` plugin switched off: leave the bridge alone this pass (no webhook
      // provisioning, no announcements, no access checks) — it resumes on its own the moment the plugin is back on.
      if (!(await this.isGuildIntegrationsOn(ctx, guildId))) continue;

      const guild =
        ctx.client.guilds.cache.get(guildId) ?? (await ctx.client.guilds.fetch(guildId).catch(() => null));
      if (!guild) continue;

      const access = await checkBridgeChannelAccess(guild, channel.bridgeDiscordChannelId);
      if (!access.ok) {
        await ctx.prisma.twitchChatChannel
          .update({ where: { id: channel.id }, data: { bridgeLastError: access.error } })
          .catch(() => undefined);
        continue; // skip webhook/announce work for this channel this pass
      }
      if (channel.bridgeLastError) {
        await ctx.prisma.twitchChatChannel
          .update({ where: { id: channel.id }, data: { bridgeLastError: null } })
          .catch(() => undefined);
      }

      if (channel.bridgeTwitchToDiscord && (!channel.bridgeWebhookId || !channel.bridgeWebhookTokenEnc)) {
        const webhookResult = await ensureBridgeWebhook(ctx, guild, channel);
        if (!webhookResult.ok) {
          await ctx.prisma.twitchChatChannel
            .update({ where: { id: channel.id }, data: { bridgeLastError: webhookResult.error } })
            .catch(() => undefined);
          continue; // skip announce this pass — better luck next tick
        }
        // Keep the cache fresh on every reconcile pass that actually touches the webhook (whether it just
        // created a new one or decrypted/reused an existing stored credential) — this also populates the cache
        // proactively so a Twitch chat message arriving right after enable/reconcile already has a warm client,
        // rather than `relayTwitchToDiscordIfBridged` having to lazily build one on the first message.
        this.bridgeWebhookClients.set(channel.id, webhookResult.client);
      }

      // Refresh the channel cache for this channel if it currently has a live chat subscription. Pass 1 (which
      // normally refreshes the cache) already ran earlier in this same `runReconcileOnce` call, BEFORE this
      // webhook was (possibly just) created — without this extra refresh, the very first Twitch chat message
      // after enabling the bridge would silently find no webhook in the cache until the next reconcile tick.
      if (this.subscriptionsByChannelId.get(channel.id)?.chat) {
        const freshRow = await ctx.prisma.twitchChatChannel.findUnique({ where: { id: channel.id } });
        if (freshRow) await this.refreshChannelCache(ctx, freshRow);
      }

      await this.announceBridgeIfNeeded(ctx, guild, channel);
    }
  }

  /** Sends the one-time "this is now bridged" announcement for each direction that just turned on, and resets
   * a direction's announced flag once it's turned back off (so re-enabling it later re-announces). Never
   * throws — an announcement failing must never block the rest of reconcile. */
  private async announceBridgeIfNeeded(ctx: PluginContext, guild: Guild, channel: TwitchChatChannel): Promise<void> {
    const entry = this.bridgeAnnounced.get(channel.id) ?? { discordToTwitch: false, twitchToDiscord: false };

    if (channel.bridgeDiscordToTwitch && !entry.discordToTwitch) {
      try {
        if (channel.bridgeDiscordChannelId) {
          const textChannel = await resolveTextChannel(guild, channel.bridgeDiscordChannelId);
          await textChannel?.send({
            content:
              'This channel is now bridged to Twitch chat — messages posted here will be shown there as "[Discord] name: text".',
            allowedMentions: { parse: [] },
          });
        }
        const sendResult = await sendChatMessage(
          ctx,
          channel.broadcasterUserId,
          'This chat now shows messages posted in the linked Discord channel.',
        );
        if (!sendResult.ok && sendResult.dropCode) {
          const errorMsg = this.dropCodeToUserMessage(sendResult.dropCode, sendResult.error);
          ctx.logger.warn(
            { channelId: channel.id, dropCode: sendResult.dropCode },
            'integrations/twitch-chat: bridge announce dropped by Twitch',
          );
          await this.updateChannelLastErrorIfChanged(ctx, channel.id, errorMsg);
        }
      } catch (err) {
        ctx.logger.warn(
          { err, channelId: channel.id },
          'integrations/twitch-chat: bridge discordToTwitch announce failed',
        );
      }
      entry.discordToTwitch = true;
    } else if (!channel.bridgeDiscordToTwitch) {
      entry.discordToTwitch = false;
    }

    if (channel.bridgeTwitchToDiscord && !entry.twitchToDiscord) {
      try {
        if (channel.bridgeDiscordChannelId) {
          const textChannel = await resolveTextChannel(guild, channel.bridgeDiscordChannelId);
          await textChannel?.send({
            content: 'This channel now shows messages posted in the linked Twitch chat.',
            allowedMentions: { parse: [] },
          });
        }
        const sendResult = await sendChatMessage(
          ctx,
          channel.broadcasterUserId,
          'This chat is now bridged to Discord — messages here will be shown there.',
        );
        if (!sendResult.ok && sendResult.dropCode) {
          const errorMsg = this.dropCodeToUserMessage(sendResult.dropCode, sendResult.error);
          ctx.logger.warn(
            { channelId: channel.id, dropCode: sendResult.dropCode },
            'integrations/twitch-chat: bridge announce dropped by Twitch',
          );
          await this.updateChannelLastErrorIfChanged(ctx, channel.id, errorMsg);
        }
      } catch (err) {
        ctx.logger.warn(
          { err, channelId: channel.id },
          'integrations/twitch-chat: bridge twitchToDiscord announce failed',
        );
      }
      entry.twitchToDiscord = true;
    } else if (!channel.bridgeTwitchToDiscord) {
      entry.twitchToDiscord = false;
    }

    this.bridgeAnnounced.set(channel.id, entry);
  }

  private async refreshChannelCache(ctx: PluginContext, channel: TwitchChatChannel): Promise<void> {
    const [commands, rewards] = await Promise.all([
      ctx.prisma.twitchChatCommand.findMany({ where: { channelId: channel.id, enabled: true } }),
      ctx.prisma.twitchChatReward.findMany({ where: { channelId: channel.id, enabled: true } }),
    ]);
    this.channelCache.set(channel.id, { channel, commands, rewards });
  }

  private setSubscription(channelId: string, kind: SubscriptionKind, entry: SubscriptionEntry): void {
    const existing = this.subscriptionsByChannelId.get(channelId) ?? {};
    existing[kind] = entry;
    this.subscriptionsByChannelId.set(channelId, existing);
    this.channelIdByBroadcasterId.set(entry.broadcasterUserId, channelId);
  }

  /** Stops tracking one channel's `kind` subscription. Drops just that subscription entry and its own cooldown
   * bookkeeping (chat's `CommandCooldowns`/send-throttle, or rewards' `RewardCooldowns`); the broadcaster-id
   * reverse lookup and cached commands/rewards are only cleared once BOTH subscription kinds are gone for that
   * channel — a channel can lose one kind (rewards turned off, a chat revocation) while the other keeps running,
   * and the still-live kind still needs the broadcaster-id lookup and its cache entry. */
  private forgetSubscription(channelId: string, broadcasterUserId: string, kind: SubscriptionKind): void {
    const entry = this.subscriptionsByChannelId.get(channelId);
    if (!entry) return;
    delete entry[kind];

    if (kind === 'chat') {
      this.cooldowns.pruneChannel(channelId);
      pruneSendThrottle(broadcasterUserId);
      this.livenessCache.delete(broadcasterUserId);
    } else {
      this.rewardCooldowns.pruneChannel(channelId);
    }

    if (!entry.chat && !entry.rewards) {
      this.subscriptionsByChannelId.delete(channelId);
      this.channelIdByBroadcasterId.delete(broadcasterUserId);
      this.channelCache.delete(channelId);
      // Also drops the bridge announce-once flags — can cause a harmless one-time re-announcement after a full
      // manager idle->reconnect cycle (rare, acceptable; not worth solving fully here).
      this.bridgeAnnounced.delete(channelId);
      this.lastErrorByChannelId.delete(channelId);
    }
  }

  /** Stops tracking a channel entirely — both subscription kinds, whichever are live. Used by whole-session
   * resets (`closeSocketAndGoIdle`, a brand-new `session_welcome` that isn't a reconnect-follow) where every
   * subscription is invalidated at once, unlike the per-type teardown in `runReconcileOnce`'s diff passes. */
  private forgetChannel(channelId: string, subs: ChannelSubscriptions): void {
    if (subs.chat) this.forgetSubscription(channelId, subs.chat.broadcasterUserId, 'chat');
    if (subs.rewards) this.forgetSubscription(channelId, subs.rewards.broadcasterUserId, 'rewards');
    this.lastErrorByChannelId.delete(channelId);
  }

  /** Converts a Twitch drop-reason code to a user-friendly message for the creator dashboard. For known codes,
   * gives a concrete fix suggestion; for others, falls back to Twitch's own message. */
  private dropCodeToUserMessage(code: string, twitchMessage: string): string {
    switch (code) {
      case 'verified_phone_number':
        return "Twitch won't let pavisiebot chat here (it needs a verified phone number). Fix: type /mod pavisiebot in your chat.";
      case 'verified_email':
        return "Twitch won't let pavisiebot chat here (it needs a verified email). Fix: type /mod pavisiebot in your chat.";
      case 'follower_only':
        return "Twitch won't let pavisiebot chat in follower-only mode. Fix: type /mod pavisiebot in your chat or disable follower-only mode.";
      case 'slow_mode':
        return "Twitch slow mode is preventing messages. Fix: type /mod pavisiebot in your chat or reduce the slow mode duration.";
      case 'channel_suspended':
        return 'Your channel is suspended and cannot send or receive messages.';
      case 'emote_only':
        return "Twitch won't let pavisiebot chat in emote-only mode. Fix: type /mod pavisiebot in your chat or disable emote-only mode.";
      case 'subsonly':
        return "Twitch won't let pavisiebot chat in subscribers-only mode. Fix: type /mod pavisiebot in your chat or disable subscribers-only mode.";
      default:
        return twitchMessage || `Twitch refused this message (${code}). Try again later or check your channel settings.`;
    }
  }

  /** Updates `TwitchChatChannel.lastError` only when the new text differs from what is currently cached for this
   * channel. Avoids redundant database writes when the same error is repeated. When `newError` is `null` (clearing
   * a prior error), it's only written if the cached value is not already `null`. */
  private async updateChannelLastErrorIfChanged(
    ctx: PluginContext,
    channelId: string,
    newError: string | null,
  ): Promise<void> {
    const cached = this.lastErrorByChannelId.get(channelId);
    if (cached === newError) return; // No change, skip the write
    this.lastErrorByChannelId.set(channelId, newError);
    await ctx.prisma.twitchChatChannel
      .update({ where: { id: channelId }, data: { lastError: newError } })
      .catch(() => undefined);
  }

  /** Closes the current (and any retiring) socket without going through the normal `onClosed`→backoff path —
   * used when the manager itself decides to go idle (desired set emptied, or the bot identity disappeared/went
   * ERROR) rather than the socket dying on its own. Clears every bit of live-session state, including whatever
   * subscriptions are still tracked (normally already empty by the time this runs, since both call sites clear
   * them first, but harmless either way). */
  private closeSocketAndGoIdle(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(); // suppressed onClosed — we're handling this transition ourselves, not reconnecting
    this.socket = null;
    this.previousSocket?.close();
    this.previousSocket = null;
    this.connected = false;
    this.sessionId = null;
    this.backoffMs = INITIAL_BACKOFF_MS;
    for (const [channelId, subs] of [...this.subscriptionsByChannelId.entries()]) {
      this.forgetChannel(channelId, subs);
    }
  }

  private async tryConnect(ctx: PluginContext): Promise<void> {
    if (this.stopped || this.socket || this.connecting) return;
    this.connecting = true;
    try {
      const clientId = ctx.env.TWITCH_CLIENT_ID;
      const clientSecret = ctx.env.TWITCH_CLIENT_SECRET;
      this.envConfigured = Boolean(clientId && clientSecret);
      if (!this.envConfigured) {
        this.idleReason = 'TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET are not configured on this deployment.';
        return;
      }

      // A failing lookup (database not migrated yet, transient outage) must THROW so the startup retry engages —
      // swallowing it into `null` reported a healthy deployment as "owner setup pending" and never retried.
      const identity = await getBotIdentityRow(ctx);
      if (this.stopped || this.socket) return; // stop()/another connect raced us while we were awaiting
      this.botConfigured = Boolean(identity);
      if (!identity) {
        this.idleReason = "Pavisie's Twitch bot account has not been connected yet (owner setup pending).";
        return;
      }

      const desired = await this.computeDesiredChannels(ctx);
      if (this.stopped || this.socket) return; // same race guard after the second await
      this.channelsAvailable = desired.length > 0;
      if (!this.channelsAvailable) {
        // Opening a socket with nothing to subscribe is worse than not opening one at all: Twitch closes an
        // EventSub session that creates no subscription within 10s of welcome (code 4003), and the resulting
        // reconnect resets backoff — a deployment with zero linked channels would otherwise reconnect forever,
        // every ~11s. Every reconcile tick re-checks this and connects the moment a channel is linked.
        this.idleReason = NO_CHANNELS_IDLE_REASON;
        return;
      }

      this.idleReason = null;
      this.botUserId = identity.botUserId;
      this.connectSocket(ctx, EVENTSUB_WS_URL, { isReconnectFollow: false });
    } finally {
      this.connecting = false;
    }
  }

  private connectSocket(ctx: PluginContext, url: string, opts: { isReconnectFollow: boolean }): void {
    const socket: EventSubSocket = new EventSubSocket(
      url,
      {
        onWelcome: (sessionId) => {
          if (this.socket !== socket) return; // superseded before it even welcomed (e.g. stop() raced this)
          this.sessionId = sessionId;
          this.connected = true;
          this.lastError = null;
          this.backoffMs = INITIAL_BACKOFF_MS;

          if (this.previousSocket) {
            this.previousSocket.close();
            this.previousSocket = null;
          }
          if (!opts.isReconnectFollow) {
            // A brand-new session invalidates every previous subscription — they die with the old session and
            // must be recreated. A `session_reconnect`-follow session instead carries them over automatically.
            for (const [channelId, subs] of [...this.subscriptionsByChannelId.entries()]) {
              this.forgetChannel(channelId, subs);
            }
          }
          void this.reconcile(ctx).catch((err: unknown) => {
            ctx.logger.error({ err }, 'integrations/twitch-chat: post-welcome reconcile failed');
          });
        },
        onReconnect: (reconnectUrl) => {
          if (this.socket !== socket) return;
          this.previousSocket = socket;
          this.connectSocket(ctx, reconnectUrl, { isReconnectFollow: true });
        },
        onNotification: (message) => {
          if (this.socket !== socket && this.previousSocket !== socket) return;
          void this.handleNotification(ctx, message);
        },
        onRevocation: (message) => {
          if (this.socket !== socket) return;
          void this.handleRevocation(ctx, message);
        },
        onClosed: (reason) => {
          if (this.socket !== socket) return; // a stale/already-superseded socket dying isn't "the" socket dying
          this.socket = null;
          this.connected = false;
          this.sessionId = null;
          this.lastError = reason;
          if (!this.stopped) this.scheduleReconnect(ctx);
        },
      },
      this.wsCtor,
    );
    this.socket = socket;
  }

  private scheduleReconnect(ctx: PluginContext): void {
    if (this.stopped || this.reconnectTimer) return;
    const jitterMs = Math.floor(Math.random() * Math.min(1000, this.backoffMs));
    const delayMs = this.backoffMs + jitterMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryConnect(ctx).catch((err: unknown) => {
        ctx.logger.error({ err }, 'integrations/twitch-chat: reconnect attempt failed');
      });
    }, delayMs);
  }

  /** Dispatches one EventSub notification by subscription type. A handler exception must never kill the socket
   * loop — one bad/unexpected message (from either subscription type) is logged and swallowed, same discipline
   * the chat path always had. */
  private async handleNotification(ctx: PluginContext, message: EventSubNotification): Promise<void> {
    try {
      switch (message.subscription.type) {
        case 'channel.chat.message':
          await this.handleChatMessageNotification(ctx, message);
          return;
        case 'channel.channel_points_custom_reward_redemption.add':
          await this.handleRewardRedemptionNotification(ctx, message);
          return;
        default:
          return;
      }
    } catch (err) {
      ctx.logger.error({ err }, 'integrations/twitch-chat: notification handler threw');
    }
  }

  private async handleChatMessageNotification(ctx: PluginContext, message: EventSubNotification): Promise<void> {
    const event = message.event as RawChatMessageEvent;
    const channelId = this.channelIdByBroadcasterId.get(event.broadcaster_user_id);
    if (!channelId) return;
    const cached = this.channelCache.get(channelId);
    if (!cached) return;

    const chatEvent = {
      chatterUserId: event.chatter_user_id,
      chatterDisplayName: event.chatter_user_name,
      messageText: event.message?.text ?? '',
    };

    // Self-ignore, centralized: neither economy commands, economy earning, nor the custom-command engine ever
    // run against the bot's own messages (the engine also self-checks internally, but economy handling lives
    // entirely outside it, so this guard is the one place that covers all three).
    if (chatEvent.chatterUserId !== this.botUserId) {
      const prefix = cached.channel.commandPrefix;
      const isCommandAttempt = Boolean(prefix) && chatEvent.messageText.startsWith(prefix);

      let reply: string | null = null;
      if (isCommandAttempt) {
        // Economy commands are tried FIRST, before the engine — see `tryEconomyCommand`'s doc comment for the
        // precedence rules (an existing custom command with a reserved name always wins).
        const economyResult = await this.tryEconomyCommand(ctx, cached, chatEvent).catch((err: unknown) => {
          ctx.logger.warn({ err }, 'integrations/twitch-chat: economy command handling threw');
          return { handled: false } as const;
        });

        if (economyResult.handled) {
          reply = economyResult.reply;
        } else {
          reply = await handleChatMessage({
            botUserId: this.botUserId ?? '',
            channel: {
              id: cached.channel.id,
              commandPrefix: cached.channel.commandPrefix,
              broadcasterLogin: cached.channel.broadcasterLogin,
              broadcasterUserId: cached.channel.broadcasterUserId,
            },
            commands: cached.commands,
            event: { ...chatEvent, badgeSetIds: (event.badges ?? []).map((b) => b.set_id) },
            cooldowns: this.cooldowns,
            helix: {
              getStream: (id) => getStream(ctx, id),
              getChannelInfo: (id) => getChannelInfo(ctx, id),
            },
          });
        }
      } else {
        // Only a genuine (non-command) chat message can earn currency. `chatterLogin` is carried separately
        // from `chatEvent` (rather than added to it) so it never leaks into the engine call above, which is
        // typed against `ChatMessageEvent` and has no such field.
        await this.tryEconomyEarn(ctx, cached, { ...chatEvent, chatterLogin: event.chatter_user_login ?? '' }).catch(
          (err: unknown) => {
            ctx.logger.error({ err }, 'integrations/twitch-chat: economy earn handling threw');
          },
        );
      }

      if (reply) {
        const sendResult = await sendChatMessage(ctx, cached.channel.broadcasterUserId, reply);
        if (!sendResult.ok) {
          if (sendResult.dropCode) {
            // Twitch refused the message (verified_phone_number, follower-only, etc.) —
            // log once per channel and surface to the creator dashboard
            const errorMsg = this.dropCodeToUserMessage(sendResult.dropCode, sendResult.error);
            ctx.logger.warn(
              { channelId: cached.channel.id, dropCode: sendResult.dropCode },
              'integrations/twitch-chat: message dropped by Twitch',
            );
            await this.updateChannelLastErrorIfChanged(ctx, cached.channel.id, errorMsg);
          }
        } else {
          // Send succeeded — if there was a prior drop error, clear it
          const cached_error = this.lastErrorByChannelId.get(cached.channel.id) ?? cached.channel.lastError;
          // Only clear if the cached error looks like a drop error (starts with our drop message patterns)
          if (cached_error && (cached_error.includes("Twitch won't let") || cached_error.includes('Twitch slow mode'))) {
            await this.updateChannelLastErrorIfChanged(ctx, cached.channel.id, null);
          }
        }
      }
    }

    // The method itself already catches its own errors internally (see its doc comment) — this outer catch is
    // just the same defensive belt-and-suspenders style already used elsewhere in this file (e.g.
    // `handleNotification`'s dispatch): a relay failure must never affect the command-reply path above, or
    // vice versa.
    await this.relayTwitchToDiscordIfBridged(ctx, cached.channel, chatEvent).catch((err: unknown) => {
      ctx.logger.error({ err }, 'integrations/twitch-chat: bridge relay threw');
    });
  }

  /** The channel's own currency (ARCHITECTURE.md §18b/§19e), or `null` when it has none or it is switched off.
   * Independent of any Discord server: a guildless channel has one just like a guild-linked one. Cached for
   * `ECONOMY_CACHE_TTL_MS`; a failed read throws (and is never cached) so the caller's own catch logs it. */
  private async loadEnabledChannelEconomy(
    ctx: PluginContext,
    broadcasterUserId: string,
    now: number,
  ): Promise<ChannelEconomy | null> {
    const cached = this.economyCache.get(broadcasterUserId);
    if (cached && now - cached.fetchedAtMs < ECONOMY_CACHE_TTL_MS) return cached.economy;

    const row = await ctx.prisma.channelEconomy.findUnique({
      where: { platform_channelUserId: { platform: 'TWITCH', channelUserId: broadcasterUserId } },
    });
    const economy = row && row.enabled ? row : null;
    this.economyCache.set(broadcasterUserId, { economy, fetchedAtMs: now });
    return economy;
  }

  /** Routes one Twitch chat message to a reserved economy command (!balance/!bal/!daily/!give/!top), if
   * eligible. Delegates all parsing/gating/dispatch to the pure `handleEconomyChatCommand`
   * (economy-commands.ts) — this method's only job is supplying the channel-backed dependencies that function
   * needs: this channel's currently-enabled custom command names (so an existing custom command with a reserved
   * name still wins) and a lazy loader for the channel's own currency (`ChannelEconomy`), which only runs once the
   * message is known to be an economy command. Returns `{ handled: false }` whenever the channel has no enabled
   * currency, so the caller always falls through to the engine in that case. Works for guildless channels too. */
  private async tryEconomyCommand(
    ctx: PluginContext,
    cached: ChannelCacheEntry,
    event: { chatterUserId: string; chatterDisplayName: string; messageText: string },
  ): Promise<EconomyCommandResult> {
    const broadcasterUserId = cached.channel.broadcasterUserId;

    // `cached.commands` is already filtered to `enabled: true` rows (see `refreshChannelCache`'s query).
    const customCommandNames = new Set(cached.commands.map((c) => c.name));

    return handleEconomyChatCommand({
      event,
      commandPrefix: cached.channel.commandPrefix,
      channelId: cached.channel.id,
      customCommandNames,
      loadEconomy: async () => {
        const economy = await this.loadEnabledChannelEconomy(ctx, broadcasterUserId, Date.now());
        return economy ? createEconomyChatPort(ctx.prisma, economy, this.botUserId) : null;
      },
      botTwitchUserId: this.botUserId,
      helix: { getUserByLogin: (login) => getUserByLogin(ctx, login) },
      cooldowns: this.cooldowns,
    });
  }

  /** Twitch chat earning (ARCHITECTURE.md §18b/§19a/§19e): credits the channel's `earnPerMessage` (capped by the
   * viewer's remaining daily budget) to a viewer's wallet in THIS channel's currency for one eligible non-command
   * chat message while the channel is live — silently (no chat reply), never logged, and never throws into the
   * caller (the caller's own `.catch` is the last line of defense). Guild-linked or not, the same rules apply. */
  private async tryEconomyEarn(
    ctx: PluginContext,
    cached: ChannelCacheEntry,
    event: { chatterUserId: string; chatterDisplayName: string; chatterLogin: string },
  ): Promise<void> {
    // The broadcaster farming currency from their own channel, and well-known third-party chat bots (Nightbot,
    // StreamElements, etc. — they post automated messages continuously all stream, which would otherwise max
    // the daily cap every stream and dominate the leaderboard) never earn. Commands stay usable by everyone —
    // this check is earning-only, checked first (cheap, synchronous) before any async/Redis work.
    if (event.chatterUserId === cached.channel.broadcasterUserId) return;
    if (isExcludedChatBotLogin(event.chatterLogin)) return;

    const now = Date.now();
    const economy = await this.loadEnabledChannelEconomy(ctx, cached.channel.broadcasterUserId, now);
    if (!economy || !economy.earnEnabled || economy.earnDailyCap <= 0) return;

    const isLive = await this.isChannelLive(ctx, cached.channel.broadcasterUserId, now);
    if (!isLive) return;

    const cooldownAcquired = await ctx.redis
      .set(earnCooldownKey(economy.id, event.chatterUserId), '1', 'EX', economy.earnCooldownSeconds, 'NX')
      .catch(() => null);
    if (cooldownAcquired !== 'OK') return;

    const creditAmount = await reserveDailyEarnBudget(
      ctx.redis,
      economy.id,
      event.chatterUserId,
      economy.earnPerMessage,
      economy.earnDailyCap,
    );
    if (creditAmount <= 0) return;

    await creditChannel(
      ctx.prisma,
      { economyId: economy.id, viewerUserId: event.chatterUserId },
      creditAmount,
      'twitch_chat_earn',
      { displayName: event.chatterDisplayName },
    );
  }

  /** Whether `broadcasterUserId` is currently live, per a `getStream` lookup cached for `LIVENESS_CACHE_TTL_MS`
   * — a busy chat costs at most one Helix call per minute, not one per message. A failed lookup is cached and
   * treated as "not live" (same "don't assert something that might be false" discipline `getStream`'s own doc
   * comment describes), so a Helix outage doesn't cost one call per message either. */
  private async isChannelLive(ctx: PluginContext, broadcasterUserId: string, now: number): Promise<boolean> {
    const cached = this.livenessCache.get(broadcasterUserId);
    if (cached && now - cached.fetchedAtMs < LIVENESS_CACHE_TTL_MS) return cached.isLive;

    const result = await getStream(ctx, broadcasterUserId);
    const isLive = result.ok && result.value !== null;
    this.livenessCache.set(broadcasterUserId, { isLive, fetchedAtMs: now });
    return isLive;
  }

  /** Discord <-> Twitch chat bridge, Twitch -> Discord direction: relays one chat message into the bridge
   * Discord channel's webhook, if the bridge is configured and this message isn't excluded by a safety rule.
   * NEVER logs `event.messageText`/`event.chatterDisplayName` — only the channel id and a Discord error code on
   * failure. */
  private async relayTwitchToDiscordIfBridged(
    ctx: PluginContext,
    channel: TwitchChatChannel,
    event: { chatterUserId: string; chatterDisplayName: string; messageText: string },
  ): Promise<void> {
    if (!channel.guildId) return; // guildless channel: no Discord server to relay into
    if (!channel.bridgeTwitchToDiscord) return;
    if (!channel.bridgeDiscordChannelId) return;
    if (event.chatterUserId === this.botUserId) return; // self-ignore (safety rule 1) — never bounce our own relayed messages back
    if (event.messageText.startsWith(channel.commandPrefix)) return; // safety rule 3
    if (!channel.bridgeWebhookId || !channel.bridgeWebhookTokenEnc) return; // not provisioned yet; do nothing rather than guess
    if (!(await this.isGuildIntegrationsOn(ctx, channel.guildId))) return; // the server's admin switched the plugin off

    // Spend a token only for a message that was actually going to be relayed — everything above this line is a
    // cheap early-out, so gating here (rather than at the top of the method) never wastes bucket capacity on a
    // message that wouldn't have been sent anyway. A drop is recorded (channel id only, never message content)
    // and the message is silently not relayed — same drop-and-count discipline `sendChatMessage`'s own Discord
    // -> Twitch throttle already uses.
    if (!takeBridgeSendToken(channel.id)) {
      recordBridgeDrop(channel.id);
      return;
    }

    try {
      // Cached-first: reuse the single `WebhookClient` `runBridgeReconcile` already warmed for this channel, so
      // a busy Twitch chat shares one discord.js rate-limit bucket instead of a fresh client (and no shared
      // throttling) per message. Fall back to lazily building one — e.g. right after a bot restart, before the
      // next reconcile tick has run — and cache it too, so every message after this one reuses it as well.
      let client = this.bridgeWebhookClients.get(channel.id);
      if (!client) {
        const token = decryptSecret(channel.bridgeWebhookTokenEnc);
        client = new WebhookClient({ id: channel.bridgeWebhookId, token });
        this.bridgeWebhookClients.set(channel.id, client);
      }
      const formatted = formatTwitchToDiscord(event.messageText);
      const username = toBridgeWebhookUsername(event.chatterDisplayName);
      await client.send({
        username,
        content: formatted,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      });
    } catch (err) {
      const code = (err as { code?: number } | undefined)?.code;
      if (code === UNKNOWN_WEBHOOK_ERROR_CODE) {
        // The webhook was deleted from Discord's side — self-heal by clearing the stored credential so the
        // next reconcile recreates it, and drop the dead client from the cache so it isn't reused. Note: if the
        // `channel` object passed into this call (read from the possibly-not-yet-refreshed cache) still carries
        // the same dead `bridgeWebhookId`/token, the very next message could rebuild and cache that same dead
        // client again, failing the same way until the next reconcile tick refreshes the row — an accepted,
        // short-lived limitation (reconcile is nudged, not a new issue introduced by the cache).
        await clearBridgeWebhook(ctx, channel.id);
        this.bridgeWebhookClients.delete(channel.id);
      }
      ctx.logger.warn({ channelId: channel.id, code }, 'integrations/twitch-chat: bridge relay to Discord failed');
    }
  }

  /** Matches a redemption event against the channel's cached reward rows (`rewards.ts`) and runs every action
   * that comes back. NEVER logs `event.userInput`/`event.userDisplayName` (nor passes them anywhere but into
   * `matchRewardActions`, which itself never logs) — only the reward title and action kind are safe to log,
   * same privacy stance as chat message handling. */
  private async handleRewardRedemptionNotification(ctx: PluginContext, message: EventSubNotification): Promise<void> {
    const event = message.event as RawRewardRedemptionEvent;
    const channelId = this.channelIdByBroadcasterId.get(event.broadcaster_user_id);
    if (!channelId) return;
    const cached = this.channelCache.get(channelId);
    if (!cached) return;

    const actions = matchRewardActions(
      channelId,
      cached.rewards,
      {
        rewardId: event.reward.id,
        rewardTitle: event.reward.title,
        userInput: event.user_input ?? '',
        userDisplayName: event.user_name,
      },
      this.rewardCooldowns,
    );

    for (const action of actions) {
      await this.runRewardAction(ctx, cached.channel, action);
    }
  }

  /** Runs one matched reward action. Each action is independently try/caught — one action failing (a bad
   * Discord channel id, a publish error, TTS being unavailable) must never stop the others configured for the
   * same redemption. Logs only the reward's title/id and action kind, never the templated text. */
  private async runRewardAction(ctx: PluginContext, channel: TwitchChatChannel, action: RewardAction): Promise<void> {
    try {
      switch (action.kind) {
        case 'CHAT': {
          const sendResult = await sendChatMessage(ctx, channel.broadcasterUserId, action.text);
          if (!sendResult.ok && sendResult.dropCode) {
            const errorMsg = this.dropCodeToUserMessage(sendResult.dropCode, sendResult.error);
            ctx.logger.warn(
              { channelId: channel.id, dropCode: sendResult.dropCode, rewardId: action.reward.id },
              'integrations/twitch-chat: reward CHAT action dropped by Twitch',
            );
            await this.updateChannelLastErrorIfChanged(ctx, channel.id, errorMsg);
          }
          return;
        }
        case 'DISCORD':
          // A Discord post needs a guild; a guildless channel treats the action as unavailable (skipped
          // quietly, never an error into Twitch chat).
          if (!channel.guildId) {
            ctx.logger.debug(
              { rewardId: action.reward.id },
              'integrations/twitch-chat: DISCORD reward action skipped (channel has no linked Discord server)',
            );
            return;
          }
          if (!(await this.isGuildIntegrationsOn(ctx, channel.guildId))) {
            ctx.logger.debug(
              { rewardId: action.reward.id },
              'integrations/twitch-chat: DISCORD reward action skipped (the linked server has the integrations plugin off)',
            );
            return;
          }
          await postAlert(ctx, { guildId: channel.guildId, channelId: action.discordChannelId }, {
            title: `Channel point redeemed: ${action.reward.rewardTitle}`,
            description: action.text,
          });
          return;
        case 'SOUND':
          await this.publishOverlayEvent(ctx, channel.id, {
            id: randomUUID(),
            kind: 'sound',
            url: action.soundUrl,
            volume: action.volume,
          });
          return;
        case 'TTS': {
          // TTS is bring-your-own-key: the channel's own OpenAI key (set on the creator dashboard) if it has
          // one, else — only for a channel linked to a Discord server — that guild's own key. A channel with
          // neither has no TTS (skipped quietly below, never an error into Twitch chat).
          const synthesized = await synthesizeTts(ctx, channel, action.text);
          if (!synthesized) {
            ctx.logger.warn(
              { rewardId: action.reward.id, rewardTitle: action.reward.rewardTitle },
              'integrations/twitch-chat: TTS unavailable for this channel (no OpenAI key); skipping the TTS reward action',
            );
            return;
          }
          await this.publishOverlayEvent(ctx, channel.id, {
            id: randomUUID(),
            kind: 'tts',
            audioId: synthesized.audioId,
            volume: action.volume,
          });
          return;
        }
      }
    } catch (err) {
      ctx.logger.error(
        { err, rewardId: action.reward.id, action: action.kind },
        'integrations/twitch-chat: reward action failed',
      );
    }
  }

  /** Publishes a SOUND/TTS overlay event over Redis pub/sub (channel-points spec: bot → API → browser). Uses the
   * bot's existing `ctx.redis` client (a plain publish, not a subscriber — no need for a second connection on
   * this side). Never throws: a failed publish just means the overlay misses this one cue, which is far better
   * than taking down redemption handling for it. */
  private async publishOverlayEvent(
    ctx: PluginContext,
    twitchChatChannelId: string,
    payload: OverlayEventPayload,
  ): Promise<void> {
    try {
      await ctx.redis.publish(redisKey('overlay', twitchChatChannelId), JSON.stringify(payload));
    } catch (err) {
      ctx.logger.warn({ err, twitchChatChannelId }, 'integrations/twitch-chat: overlay event publish failed');
    }
  }

  private async handleRevocation(ctx: PluginContext, message: EventSubRevocation): Promise<void> {
    try {
      let found: { channelId: string; kind: SubscriptionKind; broadcasterUserId: string } | null = null;
      for (const [channelId, subs] of this.subscriptionsByChannelId.entries()) {
        if (subs.chat?.subscriptionId === message.subscription.id) {
          found = { channelId, kind: 'chat', broadcasterUserId: subs.chat.broadcasterUserId };
          break;
        }
        if (subs.rewards?.subscriptionId === message.subscription.id) {
          found = { channelId, kind: 'rewards', broadcasterUserId: subs.rewards.broadcasterUserId };
          break;
        }
      }
      if (!found) return;

      this.forgetSubscription(found.channelId, found.broadcasterUserId, found.kind);
      if (found.kind === 'chat') {
        await ctx.prisma.twitchChatChannel
          .update({
            where: { id: found.channelId },
            data: {
              status: 'ERROR',
              lastError: `Twitch revoked the chat subscription (${message.subscription.status}). Reconnect the channel from the dashboard.`,
            },
          })
          .catch(() => undefined);
      } else {
        // A rewards-subscription revocation doesn't mean chat is broken too — only surface it via `lastError`,
        // never flip the whole channel's `status` to ERROR for what might be a chat-unaffected scope change.
        await ctx.prisma.twitchChatChannel
          .update({
            where: { id: found.channelId },
            data: {
              lastError: `Twitch revoked the channel-point redemption subscription (${message.subscription.status}). Re-link the channel to restore channel-point rewards.`,
            },
          })
          .catch(() => undefined);
      }
    } catch (err) {
      ctx.logger.error({ err }, 'integrations/twitch-chat: revocation handler threw');
    }
  }
}

/** Builds the `ServiceMap.twitchChat` implementation, closing over the already-built `ctx` (same pattern as
 * `createIntegrationsService`) so the parameterless `ServiceMap` methods still have a context to work with. */
export function createTwitchChatService(ctx: PluginContext, manager: TwitchChatManager): TwitchChatService {
  return {
    status: () => manager.status(),
    reconcileNow: () => manager.reconcile(ctx),
    stop: () => manager.stop(),
  };
}
