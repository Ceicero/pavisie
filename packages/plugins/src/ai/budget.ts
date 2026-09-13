import type Redis from 'ioredis';
import { redisKey } from '@entrophy/core';

const KEY_TTL_SECONDS = 2 * 24 * 60 * 60; // 2 days — comfortably covers the current UTC day plus clock skew.

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function guildBudgetKey(guildId: string, now: Date): string {
  return redisKey('ai', 'budget', 'guild', guildId, dayKey(now));
}

function userBudgetKey(guildId: string, userId: string, now: Date): string {
  return redisKey('ai', 'budget', 'user', guildId, userId, dayKey(now));
}

async function readCount(redis: Redis, key: string): Promise<number> {
  const raw = await redis.get(key);
  return raw ? Number(raw) : 0;
}

export type BudgetCheckResult =
  { ok: true } | { ok: false; scope: 'guild' | 'user'; used: number; limit: number };

/**
 * Preemptively checks today's (UTC) usage against `dailyBudget`/`perUserBudget` before spending on a provider
 * call. Two-phase with `recordUsage`: this only checks already-recorded usage, so it can't account for the
 * request about to be made — `recordUsage` afterwards adds the real (provider-reported) token count.
 */
export async function checkBudget(
  redis: Redis,
  guildId: string,
  userId: string,
  dailyBudget: number,
  perUserBudget: number,
  now: Date = new Date(),
): Promise<BudgetCheckResult> {
  const [guildUsed, userUsed] = await Promise.all([
    readCount(redis, guildBudgetKey(guildId, now)),
    readCount(redis, userBudgetKey(guildId, userId, now)),
  ]);

  if (guildUsed >= dailyBudget) return { ok: false, scope: 'guild', used: guildUsed, limit: dailyBudget };
  if (userUsed >= perUserBudget) return { ok: false, scope: 'user', used: userUsed, limit: perUserBudget };
  return { ok: true };
}

/**
 * Claims `estimatedTokens` against today's (UTC) budgets before a provider call, so concurrent requests cannot
 * all pass a check that none of them has spent against yet.
 *
 * The increment happens first and the verdict comes from its result: `INCRBY` returns the post-increment total,
 * so two racing reservations read two different totals and only one of them can be under the cap. A read-then-
 * check would hand both the same pre-spend total and let both through. Whoever overshoots rolls its own claim
 * back before returning, leaving the counters as if it had never run. Reconcile to real usage with
 * `reconcileUsage` once the provider answers, or refund with `releaseReservation` if it throws.
 */
export async function reserveBudget(
  redis: Redis,
  guildId: string,
  userId: string,
  dailyBudget: number,
  perUserBudget: number,
  estimatedTokens: number,
  now: Date = new Date(),
): Promise<BudgetCheckResult> {
  const gKey = guildBudgetKey(guildId, now);
  const uKey = userBudgetKey(guildId, userId, now);

  const multi = redis.multi();
  multi.incrby(gKey, estimatedTokens);
  multi.expire(gKey, KEY_TTL_SECONDS);
  multi.incrby(uKey, estimatedTokens);
  multi.expire(uKey, KEY_TTL_SECONDS);
  const replies = await multi.exec();

  const guildAfter = Number(replies?.[0]?.[1] ?? 0);
  const userAfter = Number(replies?.[2]?.[1] ?? 0);

  if (guildAfter > dailyBudget) {
    await releaseReservation(redis, guildId, userId, estimatedTokens, now);
    return { ok: false, scope: 'guild', used: guildAfter - estimatedTokens, limit: dailyBudget };
  }
  if (userAfter > perUserBudget) {
    await releaseReservation(redis, guildId, userId, estimatedTokens, now);
    return { ok: false, scope: 'user', used: userAfter - estimatedTokens, limit: perUserBudget };
  }

  return { ok: true };
}

/**
 * Refunds a failed reservation: subtracts the estimated tokens back from both the guild and user counters.
 * Only called if `reserveBudget` succeeded but the provider call subsequently failed.
 */
export async function releaseReservation(
  redis: Redis,
  guildId: string,
  userId: string,
  estimatedTokens: number,
  now: Date = new Date(),
): Promise<void> {
  const gKey = guildBudgetKey(guildId, now);
  const uKey = userBudgetKey(guildId, userId, now);
  const multi = redis.multi();
  multi.decrby(gKey, estimatedTokens);
  multi.decrby(uKey, estimatedTokens);
  await multi.exec();
}

/** Records `tokens` spent against both the guild's and the user's daily counters (UTC day of `now`). */
export async function recordUsage(
  redis: Redis,
  guildId: string,
  userId: string,
  tokens: number,
  now: Date = new Date(),
): Promise<void> {
  if (tokens <= 0) return;
  const gKey = guildBudgetKey(guildId, now);
  const uKey = userBudgetKey(guildId, userId, now);
  const multi = redis.multi();
  multi.incrby(gKey, tokens);
  multi.expire(gKey, KEY_TTL_SECONDS);
  multi.incrby(uKey, tokens);
  multi.expire(uKey, KEY_TTL_SECONDS);
  await multi.exec();
}

/**
 * Reconciles reserved tokens with actual usage by adjusting the budget counters by the delta.
 * Used after a provider call succeeds to fine-tune the reserved estimate to the real usage.
 * Delta can be positive (actual exceeded estimate) or negative (estimate exceeded actual).
 */
export async function reconcileUsage(
  redis: Redis,
  guildId: string,
  userId: string,
  delta: number,
  now: Date = new Date(),
): Promise<void> {
  if (delta === 0) return;
  const gKey = guildBudgetKey(guildId, now);
  const uKey = userBudgetKey(guildId, userId, now);
  const multi = redis.multi();
  if (delta > 0) {
    multi.incrby(gKey, delta);
    multi.incrby(uKey, delta);
  } else {
    multi.decrby(gKey, Math.abs(delta));
    multi.decrby(uKey, Math.abs(delta));
  }
  await multi.exec();
}

/** Current (UTC-day) usage totals, for display purposes (e.g. `/ai config view`). */
export async function readUsage(
  redis: Redis,
  guildId: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ guildUsed: number; userUsed: number }> {
  const [guildUsed, userUsed] = await Promise.all([
    readCount(redis, guildBudgetKey(guildId, now)),
    readCount(redis, userBudgetKey(guildId, userId, now)),
  ]);
  return { guildUsed, userUsed };
}
