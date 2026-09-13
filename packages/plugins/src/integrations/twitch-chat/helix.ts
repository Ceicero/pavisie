// Twitch chat bot — bot-identity token handling + Helix helpers (SPEC.md §J, docs/ARCHITECTURE.md's
// twitch-chat runtime contract). All chat reads/sends run on the ONE `TwitchBotIdentity` row's user token
// (never a broadcaster's) — see this directory's README section in packages/plugins/src/integrations/README.md.
import type { TwitchBotIdentity, TwitchChatChannel } from '@pavisie/database';
import { decryptSecret, encryptSecret, redisKey } from '@pavisie/core';
import type { PluginContext } from '../../sdk';
import type { EngineHelixResult } from './engine';
import {
  forceRefreshBroadcasterAccessToken,
  getBroadcasterAccessToken,
  type BroadcasterToken,
} from './broadcaster-token';

const HELIX_BASE = 'https://api.twitch.tv/helix';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

/** Refresh proactively once the access token has less than this long left (SPEC.md: "expiring within 10 minutes"). */
const TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000;
/** Short — just long enough to cover one token-endpoint round trip, per the repo's existing lock convention
 * (e.g. `enforcer/service.ts`'s decide lock): callers that lose the race simply use the not-yet-refreshed token
 * rather than blocking, since it's still valid for most of `TOKEN_REFRESH_WINDOW_MS`. */
const REFRESH_LOCK_TTL_MS = 15_000;
/** Client-side throttle for `sendChatMessage` — at most one send per broadcaster per second. */
const SEND_THROTTLE_MS = 1000;

export interface BotToken {
  accessToken: string;
  botUserId: string;
  botLogin: string;
}

interface HelixRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface HelixEventSubCreateResponse {
  data: { id: string }[];
}

interface HelixCustomReward {
  id: string;
  title: string;
}

interface HelixCustomRewardsResponse {
  data: HelixCustomReward[];
}

export interface CustomRewardInfo {
  id: string;
  title: string;
}

interface HelixStreamsResponse {
  data: { started_at: string }[];
}

interface HelixChannelsResponse {
  data: { title: string }[];
}

export interface StreamInfo {
  startedAt: string;
}

export interface ChannelInfo {
  title: string | null;
}

export type CreateSubscriptionResult =
  | { ok: true; subscriptionId: string }
  | { ok: false; status?: number; error: string };

/** HTTP statuses the Twitch token endpoint returns for a refresh token that can never succeed on retry (bad
 * client credentials, or a refresh token that's revoked/expired/already-used). Anything else — network errors,
 * 5xx, rate limiting — is presumed transient and must NOT brick the identity row. */
function isTerminalTokenStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

function toBotToken(identity: TwitchBotIdentity): BotToken {
  return {
    accessToken: decryptSecret(identity.accessTokenEnc),
    botUserId: identity.botUserId,
    botLogin: identity.botLogin,
  };
}

async function markIdentityError(ctx: PluginContext, id: string, message: string): Promise<void> {
  try {
    await ctx.prisma.twitchBotIdentity.update({
      where: { id },
      data: { status: 'ERROR', lastError: message.slice(0, 500) },
    });
  } catch {
    // Identity row may have been deleted (owner disconnected) mid-refresh; nothing more to do.
  }
}

/** Fetches the singleton `TwitchBotIdentity` row, or `null` if Brandon hasn't authorized the bot account yet. */
export async function getBotIdentityRow(ctx: PluginContext): Promise<TwitchBotIdentity | null> {
  return ctx.prisma.twitchBotIdentity.findFirst();
}

/**
 * Twitch rotates refresh tokens on every use — the new one MUST be persisted or the next refresh fails outright.
 *
 * Only a TERMINAL auth failure marks the identity row `ERROR` (bad credentials, or a dead refresh token — a
 * decrypt failure on the stored secret is the same class of "this will never succeed on retry"). Anything else —
 * the token endpoint being unreachable, a 5xx, or some other transient status — just logs a warning and leaves
 * the row exactly as it was, so the next `getBotAccessToken`/tick retries instead of permanently bricking a
 * working bot identity over a blip.
 */
async function refreshBotIdentity(ctx: PluginContext, identity: TwitchBotIdentity): Promise<BotToken | null> {
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  const clientSecret = ctx.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(identity.refreshTokenEnc);
  } catch (err) {
    // A corrupt/undecryptable stored secret can never succeed on retry — terminal.
    const message = err instanceof Error ? err.message : String(err);
    await markIdentityError(ctx, identity.id, message);
    return null;
  }

  let res: Response;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
  } catch (err) {
    // Network failure reaching Twitch's token endpoint — transient, leave the row untouched.
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(
      { err: message },
      'integrations/twitch-chat: token refresh request threw; leaving identity untouched, will retry next tick',
    );
    return null;
  }

  if (!res.ok) {
    if (isTerminalTokenStatus(res.status)) {
      await markIdentityError(ctx, identity.id, `Twitch token refresh failed (status ${res.status}).`);
    } else {
      ctx.logger.warn(
        { status: res.status },
        'integrations/twitch-chat: token refresh failed with a transient status; leaving identity untouched, will retry next tick',
      );
    }
    return null;
  }

  try {
    const json = (await res.json()) as HelixRefreshResponse;
    const updated = await ctx.prisma.twitchBotIdentity.update({
      where: { id: identity.id },
      data: {
        accessTokenEnc: encryptSecret(json.access_token),
        refreshTokenEnc: encryptSecret(json.refresh_token),
        expiresAt: new Date(Date.now() + json.expires_in * 1000),
        status: 'CONNECTED',
        lastError: null,
      },
    });
    return toBotToken(updated);
  } catch (err) {
    // Twitch already issued a new (one-time-use) refresh token by this point — it's lost either way, but a
    // parse/DB blip right after a successful exchange is still transient in nature; don't brick the row for it.
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(
      { err: message },
      'integrations/twitch-chat: token refresh post-processing failed; leaving identity untouched, will retry next tick',
    );
    return null;
  }
}

/**
 * Returns a valid decrypted bot-identity access token, refreshing first (under a short Redis lock, so the bot
 * and api processes don't both spend Twitch's one-time-use refresh token at once) if it's expiring within
 * `TOKEN_REFRESH_WINDOW_MS`. Returns `null` if no `TwitchBotIdentity` row exists, it's in an ERROR state, or a
 * refresh attempt just failed (which itself marks the row ERROR with `lastError`).
 */
export async function getBotAccessToken(ctx: PluginContext): Promise<BotToken | null> {
  const identity = await getBotIdentityRow(ctx);
  if (!identity || identity.status === 'ERROR') return null;

  const expiringSoon = identity.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_WINDOW_MS;
  if (!expiringSoon) return toBotToken(identity);

  return refreshUnderLock(ctx, identity);
}

/** Acquires the short cross-process refresh lock and calls `refreshBotIdentity`, or — if another process already
 * holds it — returns the token we already have rather than racing it (still valid for most of the refresh
 * window). Shared by `getBotAccessToken` (proactive, "expiring soon" refresh) and `forceRefreshBotToken`
 * (reactive, "just got a 401" refresh) so the two never spend Twitch's one-time-use refresh token at once. */
async function refreshUnderLock(ctx: PluginContext, identity: TwitchBotIdentity): Promise<BotToken | null> {
  const lockKey = redisKey('integrations', 'twitchchat', 'refreshlock');
  const acquired = await ctx.redis.set(lockKey, identity.id, 'PX', REFRESH_LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    return toBotToken(identity);
  }
  try {
    return await refreshBotIdentity(ctx, identity);
  } finally {
    await ctx.redis.del(lockKey).catch(() => undefined);
  }
}

/** Forces a refresh regardless of `expiresAt` — used after a Helix call itself returns 401, meaning the cached
 * token is bad *right now* rather than merely "expiring soon". Still goes through `refreshUnderLock`, so it never
 * races `getBotAccessToken`'s own proactive refresh. Returns `null` if there's no identity to refresh, it's
 * already `ERROR`, or the refresh attempt failed (terminal failures already mark the row `ERROR` as a side
 * effect; transient ones just leave it as-is for the next tick). */
async function forceRefreshBotToken(ctx: PluginContext): Promise<BotToken | null> {
  const identity = await getBotIdentityRow(ctx);
  if (!identity || identity.status === 'ERROR') return null;
  return refreshUnderLock(ctx, identity);
}

function buildHelixHeaders(clientId: string, accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' };
}

/**
 * Runs one Helix request via `makeRequest` (given the headers to send) and, if it comes back 401, forces exactly
 * one bot-identity refresh and retries the SAME request once more with the refreshed token. If the refresh fails
 * (or there's nothing to refresh), gives up and returns the original 401 response — the caller's normal
 * `!res.ok` handling takes it from there, same as any other Helix failure today.
 */
async function fetchWithReauth(
  ctx: PluginContext,
  clientId: string,
  token: BotToken,
  makeRequest: (headers: Record<string, string>) => Promise<Response>,
): Promise<Response> {
  const res = await makeRequest(buildHelixHeaders(clientId, token.accessToken));
  if (res.status !== 401) return res;

  const refreshed = await forceRefreshBotToken(ctx);
  if (!refreshed) return res;

  return makeRequest(buildHelixHeaders(clientId, refreshed.accessToken));
}

/** Same one-retry-on-401 shape as `fetchWithReauth`, but for calls authenticated with a channel's BROADCASTER
 * token (channel-points spec) rather than the bot identity's token — used by `createRewardRedemptionSubscription`
 * and `listCustomRewards`, which Twitch requires the broadcaster's own `channel:read:redemptions` grant for. */
async function fetchWithBroadcasterReauth(
  ctx: PluginContext,
  clientId: string,
  channel: TwitchChatChannel,
  token: BroadcasterToken,
  makeRequest: (headers: Record<string, string>) => Promise<Response>,
): Promise<Response> {
  const res = await makeRequest(buildHelixHeaders(clientId, token.accessToken));
  if (res.status !== 401) return res;

  const refreshed = await forceRefreshBroadcasterAccessToken(ctx, channel);
  if (!refreshed) return res;

  return makeRequest(buildHelixHeaders(clientId, refreshed.accessToken));
}

/** Client-side send throttle state: at most one message per broadcaster per second (module-singleton, matching
 * `TwitchChatManager`'s own singleton lifetime — there is exactly one bot process sending chat). */
const lastSentAtByBroadcaster = new Map<string, number>();

/** Drops `broadcasterId`'s send-throttle entry — called by `TwitchChatManager` whenever it stops tracking that
 * channel, so this module-level map doesn't grow forever across reconnects/unlinks. */
export function pruneSendThrottle(broadcasterId: string): void {
  lastSentAtByBroadcaster.delete(broadcasterId);
}

/** Sends a chat message as the bot identity (Helix "Send Chat Message"). Throttled client-side to at most one
 * send per second per broadcaster — anything beyond that is dropped (never queued) and only debug-logged, since
 * Twitch chat rate limits are itself for a reason and a queued backlog would just get progressively staler. */
export async function sendChatMessage(
  ctx: PluginContext,
  broadcasterId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  const last = lastSentAtByBroadcaster.get(broadcasterId) ?? 0;
  if (now - last < SEND_THROTTLE_MS) {
    ctx.logger.debug({ broadcasterId }, 'integrations/twitch-chat: send throttled, dropping message');
    return { ok: false, error: 'throttled' };
  }

  const token = await getBotAccessToken(ctx);
  if (!token) return { ok: false, error: 'Twitch bot identity is not available.' };
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return { ok: false, error: 'TWITCH_CLIENT_ID is not configured.' };

  lastSentAtByBroadcaster.set(broadcasterId, now);

  try {
    const res = await fetchWithReauth(ctx, clientId, token, (headers) =>
      fetch(`${HELIX_BASE}/chat/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: token.botUserId, message: text }),
      }),
    );
    if (!res.ok) {
      ctx.logger.warn({ status: res.status }, 'integrations/twitch-chat: send chat message failed');
      return { ok: false, error: `Helix returned status ${res.status}.` };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: message }, 'integrations/twitch-chat: send chat message request threw');
    return { ok: false, error: message };
  }
}

/** Creates the `channel.chat.message` v1 EventSub subscription (websocket transport) for one channel, using the
 * bot identity's token. Requires the broadcaster's `channel:bot` grant (obtained by the dashboard connect flow)
 * or the bot being a moderator in that channel. */
export async function createChatSubscription(
  ctx: PluginContext,
  sessionId: string,
  broadcasterUserId: string,
): Promise<CreateSubscriptionResult> {
  const token = await getBotAccessToken(ctx);
  if (!token) return { ok: false, error: 'Twitch bot identity is not available.' };
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return { ok: false, error: 'TWITCH_CLIENT_ID is not configured.' };

  try {
    const res = await fetchWithReauth(ctx, clientId, token, (headers) =>
      fetch(`${HELIX_BASE}/eventsub/subscriptions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'channel.chat.message',
          version: '1',
          condition: { broadcaster_user_id: broadcasterUserId, user_id: token.botUserId },
          transport: { method: 'websocket', session_id: sessionId },
        }),
      }),
    );
    if (!res.ok) {
      let detail = `status ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) detail = body.message;
      } catch {
        // Non-JSON error body; the status-only message above is fine.
      }
      return { ok: false, status: res.status, error: detail };
    }
    const json = (await res.json()) as HelixEventSubCreateResponse;
    const subscriptionId = json.data[0]?.id;
    if (!subscriptionId) return { ok: false, error: 'Twitch did not return a subscription id.' };
    return { ok: true, subscriptionId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Creates the `channel.channel_points_custom_reward_redemption.add` v1 EventSub subscription (websocket
 * transport) for one channel, using the BROADCASTER's own token (channel-points spec, binding fact 1 — Twitch
 * requires this exact grant; the bot identity's token cannot create it). Deliberately omits `reward_id` from
 * the condition — ONE unfiltered subscription per channel, filtered to configured rewards in application code
 * (rewards.ts), never one-subscription-per-reward (binding fact 3: that would blow the 300 EventSub cap). The
 * subscription still attaches to the bot's existing EventSub WebSocket session via `sessionId` — Twitch only
 * requires the creating token share the session's client_id, not the same user. */
export async function createRewardRedemptionSubscription(
  ctx: PluginContext,
  sessionId: string,
  channel: TwitchChatChannel,
): Promise<CreateSubscriptionResult> {
  const token = await getBroadcasterAccessToken(ctx, channel);
  if (!token) {
    return {
      ok: false,
      error: "Broadcaster token unavailable for channel point redemptions (re-link may be required).",
    };
  }
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return { ok: false, error: 'TWITCH_CLIENT_ID is not configured.' };

  try {
    const res = await fetchWithBroadcasterReauth(ctx, clientId, channel, token, (headers) =>
      fetch(`${HELIX_BASE}/eventsub/subscriptions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'channel.channel_points_custom_reward_redemption.add',
          version: '1',
          condition: { broadcaster_user_id: channel.broadcasterUserId },
          transport: { method: 'websocket', session_id: sessionId },
        }),
      }),
    );
    if (!res.ok) {
      let detail = `status ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) detail = body.message;
      } catch {
        // Non-JSON error body; the status-only message above is fine.
      }
      return { ok: false, status: res.status, error: detail };
    }
    const json = (await res.json()) as HelixEventSubCreateResponse;
    const subscriptionId = json.data[0]?.id;
    if (!subscriptionId) return { ok: false, error: 'Twitch did not return a subscription id.' };
    return { ok: true, subscriptionId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Lists a channel's custom rewards (id + title only — used by the dashboard's reward picker so admins select
 * from a dropdown instead of typing titles by hand). Requires the broadcaster token, same as
 * `createRewardRedemptionSubscription`. Same `{ ok: false }` vs `{ ok: true, value }` distinction as
 * `getStream`/`getChannelInfo` — a failed lookup is not the same as "this channel has no custom rewards". */
export async function listCustomRewards(
  ctx: PluginContext,
  channel: TwitchChatChannel,
): Promise<EngineHelixResult<CustomRewardInfo[]>> {
  const token = await getBroadcasterAccessToken(ctx, channel);
  if (!token) return { ok: false };
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return { ok: false };

  try {
    const res = await fetchWithBroadcasterReauth(ctx, clientId, channel, token, (headers) =>
      fetch(
        `${HELIX_BASE}/channel_points/custom_rewards?broadcaster_id=${encodeURIComponent(channel.broadcasterUserId)}`,
        { headers },
      ),
    );
    if (!res.ok) {
      ctx.logger.warn({ status: res.status }, 'integrations/twitch-chat: list custom rewards failed');
      return { ok: false };
    }
    const json = (await res.json()) as HelixCustomRewardsResponse;
    return { ok: true, value: json.data.map((reward) => ({ id: reward.id, title: reward.title })) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: message }, 'integrations/twitch-chat: list custom rewards request threw');
    return { ok: false };
  }
}

/** Deletes an EventSub subscription (best-effort — a channel being removed shouldn't fail just because Twitch's
 * side of the cleanup errors; the subscription dies with the socket session anyway). */
export async function deleteEventSubSubscription(ctx: PluginContext, subscriptionId: string): Promise<boolean> {
  const token = await getBotAccessToken(ctx);
  if (!token) return false;
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return false;

  try {
    const res = await fetchWithReauth(ctx, clientId, token, (headers) =>
      fetch(`${HELIX_BASE}/eventsub/subscriptions?id=${encodeURIComponent(subscriptionId)}`, {
        method: 'DELETE',
        headers,
      }),
    );
    return res.ok;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: message }, 'integrations/twitch-chat: delete EventSub subscription failed');
    return false;
  }
}

/** Currently-live stream info for the `!uptime` built-in. `{ ok: false }` means the Helix lookup itself failed
 * (no bot identity, misconfiguration, network/HTTP error) — distinct from `{ ok: true, value: null }`, which
 * means the lookup succeeded and the channel is simply offline. Callers must not conflate the two. */
export async function getStream(ctx: PluginContext, broadcasterId: string): Promise<EngineHelixResult<StreamInfo | null>> {
  const token = await getBotAccessToken(ctx);
  if (!token) return { ok: false };
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return { ok: false };

  try {
    const res = await fetchWithReauth(ctx, clientId, token, (headers) =>
      fetch(`${HELIX_BASE}/streams?user_id=${encodeURIComponent(broadcasterId)}`, { headers }),
    );
    if (!res.ok) return { ok: false };
    const json = (await res.json()) as HelixStreamsResponse;
    const stream = json.data[0];
    return { ok: true, value: stream ? { startedAt: stream.started_at } : null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: message }, 'integrations/twitch-chat: get stream failed');
    return { ok: false };
  }
}

/** Current channel info (stream title) for the `!title` built-in. Same `{ ok: false }` vs `{ ok: true, value }`
 * distinction as `getStream` — a failed lookup is not the same as "no title is set". */
export async function getChannelInfo(ctx: PluginContext, broadcasterId: string): Promise<EngineHelixResult<ChannelInfo | null>> {
  const token = await getBotAccessToken(ctx);
  if (!token) return { ok: false };
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return { ok: false };

  try {
    const res = await fetchWithReauth(ctx, clientId, token, (headers) =>
      fetch(`${HELIX_BASE}/channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`, { headers }),
    );
    if (!res.ok) return { ok: false };
    const json = (await res.json()) as HelixChannelsResponse;
    const channel = json.data[0];
    return { ok: true, value: channel ? { title: channel.title || null } : null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: message }, 'integrations/twitch-chat: get channel info failed');
    return { ok: false };
  }
}
