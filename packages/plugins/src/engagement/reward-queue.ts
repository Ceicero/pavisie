// Redis list the API pushes onto when a dashboard XP change or leveling reset needs the bot to
// recompute reward roles. The bot process is the only one that can edit Discord roles; the
// `reward-reconcile` job drains this list. A fresh payload is `{guildId, userId}` — the job reads the
// stored level (or treats a deleted profile as level 0). A requeued payload may also carry `attempts`
// (failures so far) and `notBefore` (epoch ms). The job uses BullMQ's exponential backoff formula
// (`delay * 2^(attemptsMade - 1)`) with a one-minute base, since this list is not a BullMQ queue.
import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';

export interface RewardReconcileEntry {
  guildId: string;
  userId: string;
  /** Failures already recorded. Absent or `0` means the next pass is the first try. */
  attempts?: number;
  /** Epoch milliseconds. The job must not try this entry again until then. */
  notBefore?: number;
}

/** Tries per entry, including the first. The third failure is logged once and dropped. */
export const REWARD_RECONCILE_MAX_ATTEMPTS = 3;

/** Base delay for BullMQ's built-in exponential backoff. Matches the job's one-minute cadence. */
export const REWARD_RECONCILE_BACKOFF_MS = 60_000;

/**
 * BullMQ exponential backoff: `round(delay * 2^(attemptsMade - 1))`.
 * `attemptsMade` is 1 after the first failure, 2 after the second.
 */
export function rewardReconcileBackoffMs(attemptsMade: number): number {
  return Math.round(REWARD_RECONCILE_BACKOFF_MS * 2 ** (attemptsMade - 1));
}

/** One list for every guild. Entries are JSON `{guildId, userId}` plus optional retry fields. */
export function rewardReconcileListKey(): string {
  return redisKey('engagement', 'reward-reconcile');
}

const ENQUEUE_CHUNK = 500;

function rewardReconcilePayload(entry: RewardReconcileEntry): string {
  const payload: RewardReconcileEntry = { guildId: entry.guildId, userId: entry.userId };
  if (typeof entry.attempts === 'number' && entry.attempts > 0) payload.attempts = entry.attempts;
  if (typeof entry.notBefore === 'number') payload.notBefore = entry.notBefore;
  return JSON.stringify(payload);
}

/** Appends entries (FIFO with `LPOP`). No-ops on an empty list so Redis is not called with zero values. */
export async function enqueueRewardReconcile(
  redis: Redis,
  entries: readonly RewardReconcileEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const key = rewardReconcileListKey();
  for (let i = 0; i < entries.length; i += ENQUEUE_CHUNK) {
    const payloads = entries.slice(i, i + ENQUEUE_CHUNK).map((entry) => rewardReconcilePayload(entry));
    await redis.rpush(key, ...payloads);
  }
}
