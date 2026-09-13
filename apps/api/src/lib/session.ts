import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import type { FastifyReply } from 'fastify';
import { decryptSecret, encryptSecret, env, isProduction, redisKey } from '@pavisie/core';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days, sliding
export const SESSION_COOKIE_NAME = 'sid';

/** What's stored in Redis for a live dashboard session (ARCHITECTURE.md §10). */
export interface SessionData {
  userId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  /** Epoch ms the Discord access token expires at. */
  expiresAt: number;
  csrfToken: string;
}

export interface CreateSessionInput {
  userId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

function sessionKey(sid: string): string {
  return redisKey('session', sid);
}

/** Encrypts the OAuth tokens, writes a new session row to Redis, and returns its id + decrypted-in-memory view. */
export async function createSession(
  redis: Redis,
  input: CreateSessionInput,
): Promise<{ sid: string; session: SessionData }> {
  const sid = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(24).toString('hex');
  const session: SessionData = {
    userId: input.userId,
    username: input.username,
    globalName: input.globalName,
    avatarUrl: input.avatarUrl,
    accessTokenEnc: encryptSecret(input.accessToken),
    refreshTokenEnc: encryptSecret(input.refreshToken),
    expiresAt: Date.now() + input.expiresInSec * 1000,
    csrfToken,
  };
  await redis.set(sessionKey(sid), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
  return { sid, session };
}

/** Reads a session by id, sliding its TTL forward on every read. Returns `null` if it doesn't exist/expired. */
export async function getSession(redis: Redis, sid: string): Promise<SessionData | null> {
  const raw = await redis.get(sessionKey(sid));
  if (!raw) return null;
  await redis.expire(sessionKey(sid), SESSION_TTL_SECONDS);
  return JSON.parse(raw) as SessionData;
}

/** Overwrites a session's stored data in place (e.g. after a token refresh), preserving its TTL. */
export async function updateSession(
  redis: Redis,
  sid: string,
  patch: Partial<SessionData>,
): Promise<SessionData | null> {
  const existing = await getSession(redis, sid);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  await redis.set(sessionKey(sid), JSON.stringify(next), 'EX', SESSION_TTL_SECONDS);
  return next;
}

/** Deletes a session (logout). */
export async function destroySession(redis: Redis, sid: string): Promise<void> {
  await redis.del(sessionKey(sid));
}

/** Decrypts the session's stored Discord access token. */
export function decryptAccessToken(session: SessionData): string {
  return decryptSecret(session.accessTokenEnc);
}

/** Decrypts the session's stored Discord refresh token. */
export function decryptRefreshToken(session: SessionData): string {
  return decryptSecret(session.refreshTokenEnc);
}

/**
 * Sets the signed, httpOnly `sid` cookie for a newly created session. `sameSite`/`secure` follow
 * `env.SESSION_COOKIE_SAMESITE` (ARCHITECTURE.md §21): `none` forces `secure: true` regardless of `NODE_ENV`
 * (required for cross-site cookies to be accepted at all) — `app.ts` refuses to start in that mode unless
 * `API_BASE_URL` looks like https, so this is never reached over plain http when `sameSite` is `none`.
 */
export function setSessionCookie(reply: FastifyReply, sid: string): void {
  const sameSite = env.SESSION_COOKIE_SAMESITE;
  reply.setCookie(SESSION_COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite,
    secure: sameSite === 'none' ? true : isProduction,
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
    signed: true,
  });
}

/** Clears the `sid` cookie (logout). */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/', domain: env.COOKIE_DOMAIN || undefined });
}
