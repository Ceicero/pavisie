import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import {
  ExternalServiceError,
  PermissionError,
  ValidationError,
  env,
  isProduction,
  redisKey,
} from '@pavisie/core';
import type { ZodFastifyInstance } from '../http';
import { UnauthenticatedError } from '../guild-access';
import {
  buildProviderAuthorizeUrl,
  exchangeProviderCode,
  identifyTwitchUser,
  isOAuthProviderConfigured,
  revokeTwitchToken,
  type ExchangedProviderToken,
} from '../integrations/providers';
import { nudgeTwitchChatReconcile } from '../integrations/twitch-chat-reconcile';
import { TWITCH_REDEMPTIONS_SCOPE, storeBroadcasterToken } from './broadcaster-token';
import {
  createCreatorSession,
  currentCreatorSid,
  destroyCreatorSession,
  readSignedCookie,
  setCreatorSessionCookie,
} from './session';

/**
 * Creator (streamer) sign-in with Twitch + the "connect the bot to my chat" authorization (ARCHITECTURE.md §19e).
 *
 * BOTH flows deliberately land on the SAME, already-registered Twitch redirect URI
 * (`${API_BASE_URL}/integrations/twitch/callback`) — the operator does not have to register anything new in the
 * Twitch console. `routes/oauth-integrations.ts` looks the returned `state` up in the creator namespaces below
 * first (`detectCreatorCallback`); a hit runs the creator completion here, a miss falls through to the original
 * guild-scoped flows completely unchanged.
 */

const CREATOR_STATE_TTL_SECONDS = 600;

/** Signed, httpOnly pre-login cookie binding a creator-login `state` to the browser that started it (RFC 6749
 * section 10.12 login-CSRF protection) — same reasoning and `sameSite: 'lax'` requirement as auth.ts's
 * `oauth_state`: the callback is a top-level GET redirect from Twitch, which Lax cookies ride along on but
 * Strict ones do not. */
export const CREATOR_LOGIN_STATE_COOKIE_NAME = 'creator_login_state';

/** Scopes requested when a creator connects the bot to their chat: `channel:bot` alone - it is what lets the bot
 * act in that chat. The broadcaster's token from this grant is discarded. */
export const TWITCH_CREATOR_CONNECT_SCOPES = 'channel:bot';

/** Scopes requested by "enable channel points" (creator dashboard phase 2b): `channel:bot` (the bot in chat, for
 * CHAT reward actions and everything else) plus `channel:read:redemptions`, which the channel-point EventSub
 * subscription needs and ONLY the broadcaster's own token can carry. This grant's token IS kept (encrypted, per
 * channel, in `TwitchBroadcasterToken`) until the streamer disconnects channel points. */
export const TWITCH_CREATOR_CHANNEL_POINTS_SCOPES = `channel:bot ${TWITCH_REDEMPTIONS_SCOPE}`;

/** What a creator-connect state authorizes: the chat bot alone, or the chat bot plus channel points. */
export type CreatorConnectPurpose = 'chat' | 'channel-points';

/** Where the browser lands after a creator-side OAuth round trip: the creator dashboard on the public web app. */
export function creatorDashboardUrl(query?: Record<string, string>): string {
  const base = env.WEB_URL ?? env.DASHBOARD_URL ?? '';
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  return `${base}/creator${qs}`;
}

export function creatorLoginStateKey(state: string): string {
  return redisKey('creator-login-state', state);
}

export function creatorConnectStateKey(state: string): string {
  return redisKey('creator-connect-state', state);
}

function twitchRedirectUri(): string {
  // The reused, already-registered URI — same string the guild flows build.
  return `${env.API_BASE_URL ?? ''}/integrations/twitch/callback`;
}

function setLoginStateCookie(reply: FastifyReply, state: string): void {
  reply.setCookie(CREATOR_LOGIN_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: CREATOR_STATE_TTL_SECONDS,
    signed: true,
  });
}

function clearLoginStateCookie(reply: FastifyReply): void {
  reply.clearCookie(CREATOR_LOGIN_STATE_COOKIE_NAME, { path: '/' });
}

/** `GET /creator/auth/twitch/login`: stores a fresh single-use state, binds it to this browser, and returns the
 * Twitch authorize URL. Identity only — no scopes (Helix "Get Users" works with a scope-less user token). */
export async function startTwitchCreatorLogin(app: ZodFastifyInstance, reply: FastifyReply): Promise<string> {
  if (!isOAuthProviderConfigured('twitch')) {
    throw new ExternalServiceError('Twitch is not configured on this server.');
  }
  const state = randomBytes(24).toString('hex');
  await app.redis.set(creatorLoginStateKey(state), '1', 'EX', CREATOR_STATE_TTL_SECONDS);
  setLoginStateCookie(reply, state);
  return buildProviderAuthorizeUrl('twitch', state, twitchRedirectUri(), '');
}

/** `POST /creator/twitch/channel/connect` (purpose `chat`) and `POST /creator/twitch/rewards/authorize` (purpose
 * `channel-points`): a state marking this as a creator connect (no guild), tied to the signed-in creator and to what
 * it may authorize, plus the authorize URL for the matching scopes. */
export async function startTwitchCreatorConnect(
  redis: Redis,
  creator: { platformUserId: string },
  purpose: CreatorConnectPurpose = 'chat',
): Promise<string> {
  if (!isOAuthProviderConfigured('twitch')) {
    throw new ExternalServiceError('Twitch is not configured on this server.');
  }
  const state = randomBytes(24).toString('hex');
  await redis.set(
    creatorConnectStateKey(state),
    JSON.stringify({ platform: 'twitch', platformUserId: creator.platformUserId, purpose }),
    'EX',
    CREATOR_STATE_TTL_SECONDS,
  );
  const scopes = purpose === 'channel-points' ? TWITCH_CREATOR_CHANNEL_POINTS_SCOPES : TWITCH_CREATOR_CONNECT_SCOPES;
  return buildProviderAuthorizeUrl('twitch', state, twitchRedirectUri(), scopes);
}

export type CreatorCallbackKind = 'login' | 'connect';

/**
 * Is this callback `state` one of ours? Checked BEFORE the guild flows' Discord-session gate so a creator (who has
 * no Discord session) is not bounced with a 401. A creator-login state also counts when only the browser's signed
 * pre-login cookie matches it (state already used/expired in Redis) — that lets the completion answer with the
 * proper "expired or already used" message rather than falling through to a confusing Discord-login 401.
 */
export async function detectCreatorCallback(
  redis: Redis,
  request: FastifyRequest,
  state: string,
): Promise<CreatorCallbackKind | null> {
  if (await redis.exists(creatorLoginStateKey(state))) return 'login';
  if (await redis.exists(creatorConnectStateKey(state))) return 'connect';
  if (readSignedCookie(request, CREATOR_LOGIN_STATE_COOKIE_NAME) === state) return 'login';
  return null;
}

/**
 * Creator sign-in completion. Order matters and mirrors auth.ts's Discord callback: browser binding first (the
 * state is NOT consumed by a wrong browser), then the single-use Redis state, then the code exchange. The Twitch
 * token is used for exactly one Helix call and discarded (never stored); revoking it is best-effort.
 */
export async function completeTwitchCreatorLogin(
  app: ZodFastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  input: { code: string; state: string },
): Promise<void> {
  const { code, state } = input;

  const cookieState = readSignedCookie(request, CREATOR_LOGIN_STATE_COOKIE_NAME);
  if (!cookieState || cookieState !== state) {
    throw new ValidationError(
      'This login link does not match the browser that started it. Please try signing in again.',
    );
  }
  clearLoginStateCookie(reply);

  const stateKey = creatorLoginStateKey(state);
  const stateOk = await app.redis.get(stateKey);
  if (!stateOk) {
    throw new ValidationError('This login link has expired or was already used. Please try signing in again.');
  }
  await app.redis.del(stateKey);

  const token = await exchangeProviderCode('twitch', code, twitchRedirectUri());
  let user;
  try {
    user = await identifyTwitchUser(token.accessToken);
  } finally {
    await revokeTwitchToken(token.accessToken);
  }

  // A fresh session id on every sign-in; retire whatever creator session this browser already had.
  const previousSid = currentCreatorSid(request);
  if (previousSid) await destroyCreatorSession(app.redis, previousSid);

  const { sid } = await createCreatorSession(app.redis, {
    platform: 'twitch',
    platformUserId: user.id,
    login: user.login,
    displayName: user.displayName,
    avatarUrl: user.profileImageUrl,
  });
  setCreatorSessionCookie(reply, sid);
  reply.redirect(creatorDashboardUrl());
}

interface CreatorConnectStatePayload {
  platform: string;
  platformUserId: string;
  /** Absent on a state issued before channel points existed - that was always a plain chat connect. */
  purpose?: CreatorConnectPurpose;
}

/**
 * Creator "connect the bot" completion. Requires the creator session (the `csid` cookie rides the top-level GET
 * from Twitch), the state to have been issued to THIS creator, and — the load-bearing check — the Twitch account
 * that just authorized to BE the signed-in creator: otherwise a creator could hand out their authorize URL and
 * have a different channel's owner attach that channel to Pavisie under the wrong dashboard (or vice versa).
 * For a plain chat connect the broadcaster's token is discarded, not stored. For an "enable channel points" connect
 * (`purpose: 'channel-points'`) it is stored encrypted, per channel (`storeBroadcasterToken`) - but only when it
 * really carries `channel:read:redemptions`; otherwise nothing is written and the creator is sent back with an
 * error.
 */
export async function completeTwitchCreatorConnect(
  app: ZodFastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  input: { code: string; state: string },
): Promise<void> {
  const creator = request.creator;
  if (!creator) throw new UnauthenticatedError();

  const stateKey = creatorConnectStateKey(input.state);
  const raw = await app.redis.get(stateKey);
  if (!raw) {
    throw new ValidationError(
      'This connect link has expired or was already used. Please try again from the creator dashboard.',
    );
  }
  const payload = JSON.parse(raw) as CreatorConnectStatePayload;
  if (payload.platform !== 'twitch' || payload.platformUserId !== creator.platformUserId) {
    throw new PermissionError(
      'This connect link was started from a different account. Start it again while signed in as the account that will connect.',
    );
  }
  await app.redis.del(stateKey);

  const purpose: CreatorConnectPurpose = payload.purpose ?? 'chat';
  const token = await exchangeProviderCode('twitch', input.code, twitchRedirectUri());
  let twitchUser;
  try {
    twitchUser = await identifyTwitchUser(token.accessToken);
  } catch (err) {
    // Whatever we were about to keep, we cannot vouch for whose it is - do not leave it live.
    await revokeTwitchToken(token.accessToken);
    throw err;
  }

  if (twitchUser.id !== creator.platformUserId) {
    // Writes nothing. Twitch remembers whichever account the browser is logged into, so this is an easy slip -
    // send the creator back to their dashboard with a message rather than a raw JSON error. The wrong account's
    // token is revoked (best-effort) so it does not linger.
    await revokeTwitchToken(token.accessToken);
    reply.redirect(creatorDashboardUrl({ error: 'twitch-account-mismatch' }));
    return;
  }

  if (purpose === 'channel-points') {
    // The token is kept (or revoked, on a bad grant) inside - never revoked up front here.
    await completeChannelPointsConnect(app, reply, creator, twitchUser, token);
    return;
  }

  // A chat-only token is never needed again.
  await revokeTwitchToken(token.accessToken);

  // One Pavisie chat-bot config per Twitch channel (`broadcasterUserId` is globally unique). An existing row -
  // guild-linked or not - is re-armed in place and KEEPS its guildId, connection and settings; only a brand-new
  // channel is created, without a guild.
  await app.prisma.twitchChatChannel.upsert({
    where: { broadcasterUserId: twitchUser.id },
    create: {
      broadcasterUserId: twitchUser.id,
      broadcasterLogin: twitchUser.login,
      status: 'PENDING',
      createdBy: creator.platformUserId,
    },
    update: {
      broadcasterLogin: twitchUser.login,
      enabled: true,
      status: 'PENDING',
      lastError: null,
    },
  });

  nudgeTwitchChatReconcile(app, '');
  reply.redirect(creatorDashboardUrl({ connected: 'twitch-chat' }));
}

/**
 * The tail of an "enable channel points" connect, once the authorizing Twitch account has been verified to be the
 * signed-in creator: keep the broadcaster token (encrypted, per channel) and make sure the channel row exists. A
 * brand-new channel is created guildless like a chat connect does; an EXISTING row keeps `enabled`/`status` and
 * everything else as it is - authorizing channel points must not silently switch a bot the creator turned off back
 * on, so only the login is refreshed. Rewards stay off until the creator flips the switch (`rewardsEnabled`).
 */
async function completeChannelPointsConnect(
  app: ZodFastifyInstance,
  reply: FastifyReply,
  creator: { platformUserId: string },
  twitchUser: { id: string; login: string },
  token: ExchangedProviderToken,
): Promise<void> {
  if (!token.scopes.includes(TWITCH_REDEMPTIONS_SCOPE) || !token.refreshToken || !token.expiresIn) {
    // Nothing usable came back (Twitch grants all requested scopes or none, so this is unexpected): store
    // nothing and say so rather than pretending channel points are ready.
    await revokeTwitchToken(token.accessToken);
    reply.redirect(creatorDashboardUrl({ error: 'channel-points-scope-missing' }));
    return;
  }

  const channel = await app.prisma.twitchChatChannel.upsert({
    where: { broadcasterUserId: twitchUser.id },
    create: {
      broadcasterUserId: twitchUser.id,
      broadcasterLogin: twitchUser.login,
      status: 'PENDING',
      createdBy: creator.platformUserId,
    },
    update: { broadcasterLogin: twitchUser.login },
  });
  await storeBroadcasterToken(app.prisma, channel.id, token);

  nudgeTwitchChatReconcile(app, '');
  reply.redirect(creatorDashboardUrl({ connected: 'channel-points' }));
}
