// Twitch chat earning — Redis-backed per-viewer cooldown key + UTC-day earn-budget math, used by
// `TwitchChatManager.tryEconomyEarn` (ARCHITECTURE.md §18b/§19a). Kept separate from `manager.ts` so the
// cap/cooldown arithmetic is unit-testable without a full EventSub notification round trip.
import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';

/** `YYYY-MM-DD` in UTC — the daily-cap counter's key component, so the cap resets at UTC midnight regardless
 * of the streamer's/viewer's local timezone. */
export function utcDateStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Milliseconds from `now` to the next UTC midnight — recomputed fresh on every call so the counter key's TTL
 * never drifts, however many times it's re-set over the course of the day. */
export function msUntilNextUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return next - now.getTime();
}

/** Per-viewer-per-guild earn cooldown key (`SET ... EX <twitchEarnCooldownSeconds> NX`). */
export function earnCooldownKey(guildId: string, viewerId: string): string {
  return redisKey('economy', 'twitchearn-cooldown', guildId, viewerId);
}

/** UTC-day earn budget counter key for one viewer in one guild. */
export function earnDailyBudgetKey(guildId: string, viewerId: string, now = new Date()): string {
  return redisKey('economy', 'twitchearn-daily', guildId, viewerId, utcDateStamp(now));
}

/**
 * Reserves up to `perMessage` of today's earn budget for one viewer, atomically (Redis `INCRBY` is atomic even
 * under concurrent callers), never letting the UTC day's credited total exceed `cap`. Returns the amount
 * actually earned this call: `perMessage` normally, a smaller "partial final credit" once the day's remaining
 * budget is less than `perMessage`, or `0` once the day's cap is already reached (or `perMessage`/`cap` is
 * non-positive).
 *
 * The counter's TTL is (re-)set to expire at the next UTC midnight on every call, and every write to the key
 * sets its value AND its TTL in one atomic Redis operation — a `MULTI` for the `INCRBY`+`PEXPIRE` pair, and a
 * single `SET ... PX` for the clamp — so a process crash between two round trips can never leave the key
 * without a TTL (which would otherwise leak it forever instead of it expiring at midnight).
 */
export async function reserveDailyEarnBudget(
  redis: Redis,
  guildId: string,
  viewerId: string,
  perMessage: number,
  cap: number,
  now = new Date(),
): Promise<number> {
  if (perMessage <= 0 || cap <= 0) return 0;

  const key = earnDailyBudgetKey(guildId, viewerId, now);
  const ttlMs = msUntilNextUtcMidnight(now);

  const results = await redis.multi().incrby(key, perMessage).pexpire(key, ttlMs).exec();
  const incrResult = results?.[0];
  if (!incrResult) throw new Error('reserveDailyEarnBudget: redis MULTI returned no results (was it WATCHed?)');
  const [incrErr, incrValue] = incrResult;
  if (incrErr) throw incrErr;
  const newTotal = Number(incrValue);

  if (newTotal <= cap) return perMessage;

  const overage = newTotal - cap;
  const credited = Math.max(0, perMessage - overage);
  // Clamp the stored counter back down to the cap so a long run of blocked messages doesn't grow it unbounded.
  // `SET ... PX` sets the value and TTL in a single atomic command, same reasoning as the MULTI above.
  await redis.set(key, String(cap), 'PX', ttlMs);
  return credited;
}

/** Well-known third-party Twitch chat bot logins (Nightbot, StreamElements, StreamLabs, etc.) — these post
 * automated timer/alert messages continuously throughout a stream, so without this exclusion they'd max the
 * daily earn cap every stream and dominate the `!top` leaderboard. Comparison is case-insensitive against the
 * EventSub event's `chatter_user_login` (not the display name, which can differ in casing/charset). This list
 * only affects earning — every chat bot can still run economy commands like any other viewer. Not exhaustive;
 * an admin-configurable exclusion list is a possible future enhancement. */
export const EXCLUDED_CHAT_BOT_LOGINS = [
  'nightbot',
  'streamelements',
  'streamlabs',
  'moobot',
  'fossabot',
  'wizebot',
  'soundalerts',
  'sery_bot',
  'botrixoficial',
  'kofistreambot',
  'own3d',
  'pokemoncommunitygame',
  'commanderroot',
] as const;

const EXCLUDED_CHAT_BOT_LOGIN_SET: ReadonlySet<string> = new Set(EXCLUDED_CHAT_BOT_LOGINS);

/** True when `login` (case-insensitive) is a well-known third-party chat bot excluded from earning. An empty
 * or missing login (the EventSub event didn't carry one) is never excluded by this check — it's not one of the
 * listed logins. */
export function isExcludedChatBotLogin(login: string): boolean {
  return EXCLUDED_CHAT_BOT_LOGIN_SET.has(login.toLowerCase());
}
