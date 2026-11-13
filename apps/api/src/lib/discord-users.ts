import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';
import { fetchWithBotToken } from './discord';

/**
 * Successful lookups stay fresh long enough that a public leaderboard page does not refetch every member
 * on each request. Misses and failures use a much shorter TTL so a typo or a Discord blip is not sticky.
 */
export const DISCORD_USER_CACHE_TTL_SECONDS = 600;
export const DISCORD_USER_MISS_TTL_SECONDS = 60;
export const DISCORD_USER_FAILURE_TTL_SECONDS = 15;

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

const inflight = new Map<string, Promise<PublicDiscordIdentity>>();

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

function discordErrorStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = /Discord API request failed \((\d+)\)/.exec(err.message);
  return match ? Number(match[1]) : null;
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

async function remember(
  redis: Redis,
  key: string,
  record: CachedDiscordUser,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(key, JSON.stringify(record), 'EX', ttlSeconds);
}

async function loadDiscordUser(redis: Redis, userId: string): Promise<PublicDiscordIdentity> {
  const key = cacheKey(userId);
  try {
    const user = await fetchWithBotToken<DiscordApiUser>(`/users/${encodeURIComponent(userId)}`);
    const identity: PublicDiscordIdentity = {
      username: typeof user.username === 'string' ? user.username : null,
      globalName: typeof user.global_name === 'string' ? user.global_name : null,
      avatarUrl: discordAvatarUrl(userId, user.avatar ?? null),
    };
    await remember(
      redis,
      key,
      {
        status: 'ok',
        username: identity.username,
        globalName: identity.globalName,
        avatarUrl: identity.avatarUrl ?? discordAvatarUrl(userId, null),
      },
      DISCORD_USER_CACHE_TTL_SECONDS,
    );
    return identity;
  } catch (err) {
    const miss = discordErrorStatus(err) === 404;
    await remember(
      redis,
      key,
      { status: miss ? 'miss' : 'error' },
      miss ? DISCORD_USER_MISS_TTL_SECONDS : DISCORD_USER_FAILURE_TTL_SECONDS,
    );
    return EMPTY_IDENTITY;
  }
}

/**
 * `GET /users/:id` with the bot token, cached in Redis. A failed lookup (including a missing bot token)
 * resolves to null name and avatar fields so a public leaderboard row can still be returned.
 */
export async function getCachedDiscordUser(redis: Redis, userId: string): Promise<PublicDiscordIdentity> {
  const cached = await redis.get(cacheKey(userId));
  if (cached !== null) {
    const hit = decodeCachedDiscordUser(cached);
    if (hit) return hit;
  }

  const pending = inflight.get(userId);
  if (pending) return pending;

  const promise = loadDiscordUser(redis, userId).finally(() => {
    inflight.delete(userId);
  });
  inflight.set(userId, promise);
  return promise;
}
