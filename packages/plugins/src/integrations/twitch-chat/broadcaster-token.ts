// Broadcaster-token handling for Twitch channel-point rewards (channel-points spec v1, binding fact 2):
// `providers/oauth-tokens.ts` explicitly excludes 'twitch' — the redemption EventSub subscription needs the
// *broadcaster's own* user token (scope `channel:read:redemptions`), never the bot identity's token that
// `helix.ts` uses for chat. This module owns that separate refresh path.
//
// The token lives in `TwitchBroadcasterToken`, keyed by the Twitch chat CHANNEL (`channelId`), NOT in a
// guild-scoped `IntegrationConnection`/`OAuthToken` — so a channel set up from the creator dashboard with no
// Discord server can hold one too (ARCHITECTURE.md §19b/§19e). Migration 0016 moved every existing guild-linked
// channel's token over. Re-linking replaces the row wholesale while the `TwitchChatChannel` row (and everything
// keyed to it) stays put.
//
// Mirrors `helix.ts`'s `refreshBotIdentity`/`getBotAccessToken`/`refreshUnderLock` structure and, in
// particular, its error discipline: only a TERMINAL auth failure (400/401/403 from Twitch's token endpoint,
// or an undecryptable/missing stored refresh token) marks the token `ERROR`. A transient failure (network
// error, 5xx, some other status) must never brick the token — it just logs a warning and leaves the row
// untouched for the next attempt. For a guild-linked channel the state is also mirrored, best-effort, onto its
// `IntegrationConnection` (the Discord dashboard shows that connection's status).
import type { TwitchBroadcasterToken, TwitchChatChannel } from '@pavisie/database';
import { decryptSecret, encryptSecret, redisKey } from '@pavisie/core';
import type { PluginContext } from '../../sdk';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

/** Refresh proactively once the access token has less than this long left — same window as the bot identity's
 * own refresh (helix.ts), and the same value SPEC.md documents for "expiring within 10 minutes". */
const TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000;
/** Short — just long enough to cover one token-endpoint round trip (mirrors helix.ts's `REFRESH_LOCK_TTL_MS`). */
const REFRESH_LOCK_TTL_MS = 15_000;

/** Scope required to create/receive `channel.channel_points_custom_reward_redemption.add` events. Exported so
 * the dashboard/connect-flow authorize-URL builder (a later stage) requests exactly this string, and so
 * `manager.ts`'s reconcile can explain a missing-scope channel without hardcoding the literal twice. */
export const TWITCH_REDEMPTIONS_SCOPE = 'channel:read:redemptions';

export interface BroadcasterToken {
  accessToken: string;
}

interface HelixRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** HTTP statuses the Twitch token endpoint returns for a refresh token that can never succeed on retry (bad
 * client credentials, or a refresh token that's revoked/expired/already-used). Anything else — network errors,
 * 5xx, rate limiting — is presumed transient and must NOT brick the connection. Duplicated from helix.ts
 * (rather than imported) to keep this module free of a dependency edge back onto helix.ts, which will need to
 * import *this* module for the broadcaster-token Helix calls added alongside it. */
function isTerminalTokenStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

/** Marks the channel's token `ERROR` with a truncated message, and mirrors that onto the linked
 * `IntegrationConnection` (guild-linked channels only). Best-effort: either row may have been deleted (streamer
 * disconnected / channel unlinked mid-refresh), in which case there's nothing more to do. */
async function markTokenError(ctx: PluginContext, channel: TwitchChatChannel, message: string): Promise<void> {
  const lastError = message.slice(0, 500);
  await ctx.prisma.twitchBroadcasterToken
    .update({ where: { channelId: channel.id }, data: { status: 'ERROR', lastError } })
    .catch(() => undefined);
  if (channel.connectionId) {
    await ctx.prisma.integrationConnection
      .update({ where: { id: channel.connectionId }, data: { status: 'ERROR', lastError } })
      .catch(() => undefined);
  }
}

function toBroadcasterToken(token: TwitchBroadcasterToken): BroadcasterToken {
  return { accessToken: decryptSecret(token.accessTokenEnc) };
}

/**
 * Refreshes one channel's `TwitchBroadcasterToken` row in place. Twitch rotates refresh tokens on every use —
 * the new one MUST be persisted or the next refresh fails outright. On success, also clears any prior `ERROR`
 * status (a working refresh means the token is healthy again, even if a previous attempt had marked it errored),
 * on the linked `IntegrationConnection` too when there is one.
 */
async function refreshBroadcasterToken(
  ctx: PluginContext,
  channel: TwitchChatChannel,
  token: TwitchBroadcasterToken,
): Promise<BroadcasterToken | null> {
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  const clientSecret = ctx.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (!token.refreshTokenEnc) {
    // No refresh token was ever stored for this grant — this can never succeed on retry, same class as a
    // corrupt/undecryptable secret below.
    await markTokenError(ctx, channel, 'This Twitch connection has no refresh token; re-link is required.');
    return null;
  }

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(token.refreshTokenEnc);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markTokenError(ctx, channel, message);
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
    // Network failure reaching Twitch's token endpoint — transient, leave the connection untouched.
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(
      { err: message },
      'integrations/twitch-chat: broadcaster token refresh request threw; leaving connection untouched, will retry next tick',
    );
    return null;
  }

  if (!res.ok) {
    if (isTerminalTokenStatus(res.status)) {
      await markTokenError(ctx, channel, `Twitch broadcaster token refresh failed (status ${res.status}).`);
    } else {
      ctx.logger.warn(
        { status: res.status },
        'integrations/twitch-chat: broadcaster token refresh failed with a transient status; leaving connection untouched, will retry next tick',
      );
    }
    return null;
  }

  try {
    const json = (await res.json()) as HelixRefreshResponse;
    await ctx.prisma.twitchBroadcasterToken.update({
      where: { id: token.id },
      data: {
        accessTokenEnc: encryptSecret(json.access_token),
        refreshTokenEnc: encryptSecret(json.refresh_token),
        expiresAt: new Date(Date.now() + json.expires_in * 1000),
        rotatedAt: new Date(),
        status: 'CONNECTED',
        lastError: null,
      },
    });
    if (channel.connectionId) {
      await ctx.prisma.integrationConnection
        .update({ where: { id: channel.connectionId }, data: { status: 'CONNECTED', lastError: null } })
        .catch(() => undefined);
    }
    return { accessToken: json.access_token };
  } catch (err) {
    // Twitch already issued a new (one-time-use) refresh token by this point — it's lost either way, but a
    // parse/DB blip right after a successful exchange is still transient in nature; don't brick the row for it.
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(
      { err: message },
      'integrations/twitch-chat: broadcaster token refresh post-processing failed; leaving connection untouched, will retry next tick',
    );
    return null;
  }
}

/** Acquires a short per-channel cross-process refresh lock and calls `refreshBroadcasterToken`, or — if
 * another process already holds it — returns the token already on hand rather than racing it (still valid for
 * most of the refresh window). Keyed by the channel id (not a single fixed key like the bot identity's lock)
 * since there are many broadcaster tokens, one per channel, refreshing independently. */
async function refreshUnderLock(
  ctx: PluginContext,
  channel: TwitchChatChannel,
  token: TwitchBroadcasterToken,
): Promise<BroadcasterToken | null> {
  const lockKey = redisKey('integrations', 'twitchchat', 'broadcasterrefreshlock', channel.id);
  const acquired = await ctx.redis.set(lockKey, token.id, 'PX', REFRESH_LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    return toBroadcasterToken(token);
  }
  try {
    return await refreshBroadcasterToken(ctx, channel, token);
  } finally {
    await ctx.redis.del(lockKey).catch(() => undefined);
  }
}

async function loadScopedToken(
  ctx: PluginContext,
  channel: TwitchChatChannel,
): Promise<TwitchBroadcasterToken | null> {
  const token = await ctx.prisma.twitchBroadcasterToken.findUnique({ where: { channelId: channel.id } });
  if (!token) return null;
  if (!token.scopes.includes(TWITCH_REDEMPTIONS_SCOPE)) return null;
  return token;
}

/**
 * Returns a valid decrypted broadcaster access token for `channel`, refreshing first (under a short Redis
 * lock, so the bot and api processes don't both spend Twitch's one-time-use refresh token at once) if it's
 * expiring within `TOKEN_REFRESH_WINDOW_MS`. Returns `null` when: the channel has no `TwitchBroadcasterToken`
 * row (never authorized channel points, or disconnected them); the stored token's scopes don't include
 * `channel:read:redemptions`; or a refresh attempt just failed (which itself marks the token `ERROR` only when
 * the failure was terminal).
 */
export async function getBroadcasterAccessToken(
  ctx: PluginContext,
  channel: TwitchChatChannel,
): Promise<BroadcasterToken | null> {
  const token = await loadScopedToken(ctx, channel);
  if (!token) return null;

  const expiringSoon = token.expiresAt ? token.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_WINDOW_MS : false;
  if (!expiringSoon) return toBroadcasterToken(token);

  return refreshUnderLock(ctx, channel, token);
}

/** Forces a refresh regardless of `expiresAt` — used after a Helix call itself returns 401, meaning the cached
 * token is bad *right now* rather than merely "expiring soon". Still goes through `refreshUnderLock`, so it
 * never races `getBroadcasterAccessToken`'s own proactive refresh for the same connection. */
export async function forceRefreshBroadcasterAccessToken(
  ctx: PluginContext,
  channel: TwitchChatChannel,
): Promise<BroadcasterToken | null> {
  const token = await loadScopedToken(ctx, channel);
  if (!token) return null;
  return refreshUnderLock(ctx, channel, token);
}
