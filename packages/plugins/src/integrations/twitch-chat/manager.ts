// TwitchChatManager — the process-wide (one per bot process; see `../index.ts`'s module-level singleton
// instantiation) owner of the EventSub WebSocket connection and the reconcile loop that keeps its subscriptions
// matching every enabled `TwitchChatChannel` row whose guild has the `integrations` plugin enabled.
//
// Since the channel-points extension, a channel can carry up to TWO independent EventSub subscriptions —
// `channel.chat.message` (always, on the bot identity's token) and `channel.channel_points_custom_reward_
// redemption.add` (only when `rewardsEnabled` and the broadcaster has granted `channel:read:redemptions`, on
// the BROADCASTER's own token) — so the bookkeeping below tracks them separately per channel rather than
// assuming 1:1, and `forgetSubscription`/the reconcile diff operate per subscription type: a channel can lose
// its rewards subscription (rewards turned off, scope revoked) while chat keeps running, and vice versa.
import type { TwitchChatChannel, TwitchChatCommand, TwitchChatReward } from '@pavisie/database';
import { randomUUID } from 'node:crypto';
import { redisKey } from '@pavisie/core';
import type { PluginContext, TwitchChatRuntimeStatus, TwitchChatService } from '../../sdk';
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
  pruneSendThrottle,
  sendChatMessage,
} from './helix';
import { CommandCooldowns, handleChatMessage } from './engine';
import { RewardCooldowns, matchRewardActions, type RewardAction } from './rewards';
import { synthesizeTts } from './tts';

/** One WebSocket session supports up to 300 zero-cost EventSub subscriptions (SPEC.md). Each linked channel can
 * now cost up to TWO of those — a `channel.chat.message` subscription plus a `channel.channel_points_custom_
 * reward_redemption.add` subscription once rewards are enabled for it — so the channel cap is half the raw
 * subscription cap, not equal to it (worst case: every linked channel has rewards enabled). */
const MAX_CHANNELS = 150;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** Twitch's own idle-socket message. Shown to the operator instead of Twitch's raw wording. */
const NO_CHANNELS_IDLE_REASON = 'no linked Twitch channels yet';
/** Written to `TwitchChatChannel.lastError` when rewards are enabled but the broadcaster hasn't (re-)granted
 * `channel:read:redemptions` — surfaced in the dashboard and `/twitch status` rather than failing silently. */
const REWARDS_SCOPE_MISSING_ERROR =
  'Channel-point rewards are on, but this channel needs to be re-linked to grant channel-point redemption permission (channel:read:redemptions).';

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

  constructor(private readonly wsCtor: WebSocketConstructorLike = defaultWebSocketConstructor) {}

  /** Attempts an initial connection; never throws — a missing env/bot-identity/linked-channel just leaves the
   * manager idle with a reason `status()` reports, and every later `reconcile(ctx)` tick retries (so completing
   * owner setup or linking the first channel later, with no bot restart, brings the manager up on its own). Must
   * not be awaited by `onLoad` — this resolves once the *attempt* finishes, not once the socket is actually
   * connected. */
  async start(ctx: PluginContext): Promise<void> {
    this.stopped = false;
    await this.tryConnect(ctx);
  }

  /** Closes the socket (and any in-flight reconnect-follow socket) and stops scheduling reconnects. Safe to call
   * even if never successfully connected. Does not clear channel/command cache — `start()` can be called again
   * later (not currently done anywhere, but keeps the class honest about what "stop" means). */
  async stop(): Promise<void> {
    this.stopped = true;
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

  /** Every enabled `TwitchChatChannel` row whose guild currently has the `integrations` plugin enabled
   * (`ctx.isEnabled`, same per-guild-enablement contract every other plugin job uses — e.g.
   * `community/jobs/stats-refresh.ts`), uncapped. Shared by `tryConnect` (which only needs to know whether this
   * is empty, to decide whether opening a socket is even worthwhile) and `reconcile` (which needs the full list
   * to diff against). */
  private async computeDesiredChannels(ctx: PluginContext): Promise<TwitchChatChannel[]> {
    const rows = await ctx.prisma.twitchChatChannel.findMany({ where: { enabled: true } });
    const desired: TwitchChatChannel[] = [];
    for (const row of rows) {
      if (await ctx.isEnabled(row.guildId)) desired.push(row);
    }
    return desired;
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
      // silently dead rewards subscription behind a stale `lastError`, with nothing in `/twitch status` or
      // the dashboard telling the admin why redemptions stopped firing. Costs one cached-token read per
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
    } else {
      this.rewardCooldowns.pruneChannel(channelId);
    }

    if (!entry.chat && !entry.rewards) {
      this.subscriptionsByChannelId.delete(channelId);
      this.channelIdByBroadcasterId.delete(broadcasterUserId);
      this.channelCache.delete(channelId);
    }
  }

  /** Stops tracking a channel entirely — both subscription kinds, whichever are live. Used by whole-session
   * resets (`closeSocketAndGoIdle`, a brand-new `session_welcome` that isn't a reconnect-follow) where every
   * subscription is invalidated at once, unlike the per-type teardown in `runReconcileOnce`'s diff passes. */
  private forgetChannel(channelId: string, subs: ChannelSubscriptions): void {
    if (subs.chat) this.forgetSubscription(channelId, subs.chat.broadcasterUserId, 'chat');
    if (subs.rewards) this.forgetSubscription(channelId, subs.rewards.broadcasterUserId, 'rewards');
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

      const identity = await getBotIdentityRow(ctx).catch(() => null);
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

    const reply = await handleChatMessage({
      botUserId: this.botUserId ?? '',
      channel: {
        id: cached.channel.id,
        commandPrefix: cached.channel.commandPrefix,
        broadcasterLogin: cached.channel.broadcasterLogin,
        broadcasterUserId: cached.channel.broadcasterUserId,
      },
      commands: cached.commands,
      event: {
        chatterUserId: event.chatter_user_id,
        chatterDisplayName: event.chatter_user_name,
        messageText: event.message?.text ?? '',
        badgeSetIds: (event.badges ?? []).map((b) => b.set_id),
      },
      cooldowns: this.cooldowns,
      helix: {
        getStream: (id) => getStream(ctx, id),
        getChannelInfo: (id) => getChannelInfo(ctx, id),
      },
    });

    if (reply) {
      await sendChatMessage(ctx, cached.channel.broadcasterUserId, reply);
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
        case 'CHAT':
          await sendChatMessage(ctx, channel.broadcasterUserId, action.text);
          return;
        case 'DISCORD':
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
          const synthesized = await synthesizeTts(ctx, channel.guildId, channel.id, action.text);
          if (!synthesized) {
            ctx.logger.warn(
              { rewardId: action.reward.id, rewardTitle: action.reward.rewardTitle },
              'integrations/twitch-chat: TTS unavailable for this guild; skipping the TTS reward action',
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
