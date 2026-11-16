import type Redis from 'ioredis';
import { env, redisKey } from '@pavisie/core';
import { hasBotToken } from './discord';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * Successful lookups stay fresh long enough that a public leaderboard page does not refetch every member
 * on each request. Misses and failures use a much shorter TTL so a typo or a Discord blip is not sticky.
 */
export const DISCORD_USER_CACHE_TTL_SECONDS = 600;
export const DISCORD_USER_MISS_TTL_SECONDS = 60;
export const DISCORD_USER_FAILURE_TTL_SECONDS = 15;

/** Shared Redis budget for public leaderboard lookups, across every API replica. */
export const PUBLIC_DISCORD_LOOKUP_LIMIT = 5;
export const PUBLIC_DISCORD_LOOKUP_WINDOW_MS = 1000;
/** A hung Discord call must not hold a concurrency slot indefinitely. */
export const PUBLIC_DISCORD_LOOKUP_TIMEOUT_MS = 3000;
/** In-process cap so one page cannot open more than this many Discord user requests at once. */
export const PUBLIC_DISCORD_LOOKUP_CONCURRENCY = 5;

const PUBLIC_LOOKUP_BUDGET_KEY = 'engagement:public-discord-user';

/** The only Discord profile fields the public leaderboard is allowed to return. */
export interface PublicDiscordIdentity {
  username: string | null;
  globalName: string | null;
  avatarUrl: string | null;
}

const EMPTY_IDENTITY: PublicDiscordIdentity = { username: null, globalName: null, avatarUrl: null };

interface DiscordApiUser {
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
}

type CachedDiscordUser =
  | { status: 'ok'; username: string | null; globalName: string | null; avatarUrl: string }
  | { status: 'miss' }
  | { status: 'error' };

type FetchOutcome = { kind: 'ok'; user: DiscordApiUser } | { kind: 'miss' } | { kind: 'error' };

const inflight = new Map<string, Promise<PublicDiscordIdentity>>();

let activeLookups = 0;
const lookupWaiters: Array<() => void> = [];

function acquireLookupSlot(): Promise<void> {
  if (activeLookups < PUBLIC_DISCORD_LOOKUP_CONCURRENCY) {
    activeLookups += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    lookupWaiters.push(resolve);
  });
}

function releaseLookupSlot(): void {
  const next = lookupWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeLookups -= 1;
}

/** Runs `task` with at most {@link PUBLIC_DISCORD_LOOKUP_CONCURRENCY} lookups in flight in this process. */
export async function withPublicDiscordLookupConcurrency<T>(task: () => Promise<T>): Promise<T> {
  await acquireLookupSlot();
  try {
    return await task();
  } finally {
    releaseLookupSlot();
  }
}

/** CDN avatar URL. A null hash uses Discord's default embed avatar (`(user_id >> 22) % 6`). */
export function discordAvatarUrl(userId: string, avatarHash: string | null | undefined): string {
  if (!avatarHash) {
    let index = 0;
    try {
      index = Number((BigInt(userId) >> 22n) % 6n);
    } catch {
      index = 0;
    }
    if (!Number.isInteger(index) || index < 0 || index > 5) index = 0;
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}`;
}

function cacheKey(userId: string): string {
  return redisKey('discorduser', userId);
}

function decodeCachedDiscordUser(raw: string): PublicDiscordIdentity | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CachedDiscordUser>;
    if (parsed.status === 'miss' || parsed.status === 'error') return EMPTY_IDENTITY;
    if (parsed.status !== 'ok' || typeof parsed.avatarUrl !== 'string') return null;
    return {
      username: typeof parsed.username === 'string' ? parsed.username : null,
      globalName: typeof parsed.globalName === 'string' ? parsed.globalName : null,
      avatarUrl: parsed.avatarUrl,
    };
  } catch {
    return null;
  }
}

async function readCachedIdentity(redis: Redis, userId: string): Promise<PublicDiscordIdentity | null> {
  const cached = await redis.get(cacheKey(userId));
  if (cached === null) return null;
  return decodeCachedDiscordUser(cached);
}

/** Cache writes must not fail the request. A missed write just means the next call fetches again. */
async function remember(
  redis: Redis,
  userId: string,
  record: CachedDiscordUser,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redis.set(cacheKey(userId), JSON.stringify(record), 'EX', ttlSeconds);
  } catch {
    // The identity is still returned to the caller.
  }
}

/**
 * One `GET /users/:id` with the bot token. A 429 is cached as a failure and is not retried.
 * `fetchWithBotToken` retries 429s, so this path does not use it.
 */
async function fetchDiscordUserOnce(userId: string): Promise<FetchOutcome> {
  if (!hasBotToken() || !env.DISCORD_TOKEN) return { kind: 'error' };
  let res: Response;
  try {
    res = await fetch(`${DISCORD_API_BASE}/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
      signal: AbortSignal.timeout(PUBLIC_DISCORD_LOOKUP_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'error' };
  }
  if (res.status === 404) return { kind: 'miss' };
  if (res.status === 429 || !res.ok) return { kind: 'error' };
  try {
    const user = (await res.json()) as DiscordApiUser;
    return { kind: 'ok', user };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * Opens the one-second window with `SET key 0 PX window NX` (count and expiry in one command), then
 * `INCR`. If the key is already there with no TTL, `PEXPIRE` puts the expiry back. A Redis error
 * refuses the lookup.
 */
async function takePublicLookupBudget(redis: Redis): Promise<boolean> {
  const key = redisKey('ratelimit', PUBLIC_LOOKUP_BUDGET_KEY);
  try {
    await redis.set(key, '0', 'PX', PUBLIC_DISCORD_LOOKUP_WINDOW_MS, 'NX');
    const count = await redis.incr(key);
    const ttl = await redis.pttl(key);
    if (ttl < 0) {
      await redis.pexpire(key, PUBLIC_DISCORD_LOOKUP_WINDOW_MS);
    }
    return count <= PUBLIC_DISCORD_LOOKUP_LIMIT;
  } catch {
    return false;
  }
}

async function loadPublicDiscordUser(redis: Redis, userId: string): Promise<PublicDiscordIdentity> {
  const cached = await readCachedIdentity(redis, userId);
  if (cached) return cached;

  const allowed = await takePublicLookupBudget(redis);
  if (!allowed) return EMPTY_IDENTITY;

  return withPublicDiscordLookupConcurrency(async () => {
    const again = await readCachedIdentity(redis, userId);
    if (again) return again;

    const fetched = await fetchDiscordUserOnce(userId);
    if (fetched.kind === 'miss') {
      await remember(redis, userId, { status: 'miss' }, DISCORD_USER_MISS_TTL_SECONDS);
      return EMPTY_IDENTITY;
    }
    if (fetched.kind === 'error') {
      await remember(redis, userId, { status: 'error' }, DISCORD_USER_FAILURE_TTL_SECONDS);
      return EMPTY_IDENTITY;
    }

    const identity: PublicDiscordIdentity = {
      username: typeof fetched.user.username === 'string' ? fetched.user.username : null,
      globalName: typeof fetched.user.global_name === 'string' ? fetched.user.global_name : null,
      avatarUrl: discordAvatarUrl(userId, fetched.user.avatar ?? null),
    };
    await remember(
      redis,
      userId,
      {
        status: 'ok',
        username: identity.username,
        globalName: identity.globalName,
        avatarUrl: identity.avatarUrl ?? discordAvatarUrl(userId, null),
      },
      DISCORD_USER_CACHE_TTL_SECONDS,
    );
    return identity;
  });
}

/**
 * `GET /users/:id` with the bot token, cached in Redis. A failed lookup, a 429, or an exhausted shared
 * budget resolves to null name and avatar fields and does not call Discord again for that outcome
 * (a budget miss is not cached, so a later request can try once the window moves).
 */
export async function getCachedDiscordUser(redis: Redis, userId: string): Promise<PublicDiscordIdentity> {
  const cached = await readCachedIdentity(redis, userId);
  if (cached) return cached;

  const pending = inflight.get(userId);
  if (pending) return pending;

  const promise = loadPublicDiscordUser(redis, userId).finally(() => {
    inflight.delete(userId);
  });
  inflight.set(userId, promise);
  return promise;
}
