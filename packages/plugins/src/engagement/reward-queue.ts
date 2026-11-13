// Redis list the API pushes onto when a dashboard XP change or leveling reset needs the bot to
// recompute reward roles. The bot process is the only one that can edit Discord roles; the
// `reward-reconcile` job drains this list. Payload is exactly `{guildId, userId}` — the job reads the
// stored level (or treats a deleted profile as level 0).
import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';

export interface RewardReconcileEntry {
  guildId: string;
  userId: string;
}

/** One list for every guild. Entries are JSON `{guildId, userId}`. */
export function rewardReconcileListKey(): string {
  return redisKey('engagement', 'reward-reconcile');
}

const ENQUEUE_CHUNK = 500;

/** Appends entries (FIFO with `LPOP`). No-ops on an empty list so Redis is not called with zero values. */
export async function enqueueRewardReconcile(
  redis: Redis,
  entries: readonly RewardReconcileEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const key = rewardReconcileListKey();
  for (let i = 0; i < entries.length; i += ENQUEUE_CHUNK) {
    const payloads = entries
      .slice(i, i + ENQUEUE_CHUNK)
      .map((entry) => JSON.stringify({ guildId: entry.guildId, userId: entry.userId }));
    await redis.rpush(key, ...payloads);
  }
}
