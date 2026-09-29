import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import type { FastifyReply } from 'fastify';
import { env, isProduction, redisKey } from '@pavisie/core';
import type { CreatorPlatform } from '@pavisie/types/creator';

/**
 * Creator sessions (ARCHITECTURE.md §19e). A creator signs in with their streaming-platform account; that is a
 * SEPARATE session type from the Discord dashboard session (`lib/session.ts`, cookie `sid`) — its own cookie,
 * its own Redis namespace and its own CSRF token — so the two can never be confused for one another, and a
 * browser can hold both at once. Unlike the Discord session it stores NO platform token: the sign-in token is
 * used for one "who am I" call and thrown away.
 */
const CREATOR_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days, sliding
export const CREATOR_SESSION_COOKIE_NAME = 'csid';

/** What's stored in Redis for a live creator session. */
export interface CreatorSessionData {
  /** Which streaming platform the creator signed in with. Only `twitch` exists today. */
  platform: CreatorPlatform;
  /** The platform's user id (Twitch user id) — also the broadcaster id whose channel this creator owns. */
  platformUserId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  csrfToken: string;
}

export type CreateCreatorSessionInput = Omit<CreatorSessionData, 'csrfToken'>;

function creatorSessionKey(sid: string): string {
  return redisKey('creator-session', sid);
}

/** Writes a new creator session to Redis and returns its id + data. A fresh id on every sign-in (never reused). */
export async function createCreatorSession(
  redis: Redis,
  input: CreateCreatorSessionInput,
): Promise<{ sid: string; session: CreatorSessionData }> {
  const sid = randomBytes(32).toString('hex');
  const session: CreatorSessionData = { ...input, csrfToken: randomBytes(24).toString('hex') };
  await redis.set(creatorSessionKey(sid), JSON.stringify(session), 'EX', CREATOR_SESSION_TTL_SECONDS);
  return { sid, session };
}

/** Reads a creator session by id, sliding its TTL forward on every read. `null` if missing/expired. */
export async function getCreatorSession(redis: Redis, sid: string): Promise<CreatorSessionData | null> {
  const raw = await redis.get(creatorSessionKey(sid));
  if (!raw) return null;
  await redis.expire(creatorSessionKey(sid), CREATOR_SESSION_TTL_SECONDS);
  return JSON.parse(raw) as CreatorSessionData;
}

/** Deletes a creator session (sign out). */
export async function destroyCreatorSession(redis: Redis, sid: string): Promise<void> {
  await redis.del(creatorSessionKey(sid));
}

/** Sets the signed, httpOnly `csid` cookie — same signing/sameSite/secure/domain rules as the Discord `sid`
 * cookie (`setSessionCookie`), so the two behave identically under `SESSION_COOKIE_SAMESITE`/`COOKIE_DOMAIN`. */
export function setCreatorSessionCookie(reply: FastifyReply, sid: string): void {
  const sameSite = env.SESSION_COOKIE_SAMESITE;
  reply.setCookie(CREATOR_SESSION_COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite,
    secure: sameSite === 'none' ? true : isProduction,
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
    maxAge: CREATOR_SESSION_TTL_SECONDS,
    signed: true,
  });
}

/** Clears the `csid` cookie (sign out). */
export function clearCreatorSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(CREATOR_SESSION_COOKIE_NAME, { path: '/', domain: env.COOKIE_DOMAIN || undefined });
}

interface CookieCapableRequest {
  cookies: Record<string, string | undefined>;
  unsignCookie: (v: string) => { valid: boolean; value: string | null };
}

/** Reads a signed cookie's value, or `null` if absent/tampered. */
export function readSignedCookie(request: CookieCapableRequest, name: string): string | null {
  const raw = request.cookies[name];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

/** The creator session id carried by the request's signed `csid` cookie, or `null` if absent/tampered. */
export function currentCreatorSid(request: CookieCapableRequest): string | null {
  return readSignedCookie(request, CREATOR_SESSION_COOKIE_NAME);
}
