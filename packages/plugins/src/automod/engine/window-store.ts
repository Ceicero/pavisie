import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';
import type { WindowStore } from './types';

const MAX_WINDOW_MEMBERS = 500;

/**
 * Redis-backed `WindowStore` (TASK: "a WindowStore interface (Redis-backed impl for frequency/duplicates/mentions/
 * raid windows"). Uses a sorted set per key, scored by insertion time, so pruning stale entries and counting the
 * live window are both O(log n) `ZREMRANGEBYSCORE` + `ZCARD` calls instead of scanning a list.
 */
export class RedisWindowStore implements WindowStore {
  constructor(private readonly redis: Redis) {}

  private fullKey(key: string): string {
    return redisKey('automod', 'window', key);
  }

  async pushAndCount(key: string, value: string, nowMs: number, windowMs: number): Promise<number> {
    const fullKey = this.fullKey(key);
    const cutoff = nowMs - windowMs;

    // One MULTI/EXEC, so the whole prune-add-cap-expire-count sequence is a single round trip. It runs for every
    // window-backed rule on every message and join, which during a raid made five sequential round trips per
    // rule per event the busiest thing the bot did on Redis. The transaction also makes the sequence atomic: the
    // count each caller gets back now always includes exactly the entries added up to its own.
    const results = await this.redis
      .multi()
      .zremrangebyscore(fullKey, 0, cutoff)
      // Member must be unique per entry (ZADD dedupes by member) — suffix with a monotonic-ish token so repeated
      // identical `value`s (e.g. the same duplicate message content twice) each still occupy their own slot.
      .zadd(fullKey, nowMs, `${value}:${nowMs}:${Math.random().toString(36).slice(2, 8)}`)
      // Cap unbounded growth from pathological cases (e.g. a windowMs so large a burst never prunes) so one hot
      // key can't grow forever between prunes.
      .zremrangebyrank(fullKey, 0, -1 - MAX_WINDOW_MEMBERS)
      .pexpire(fullKey, windowMs)
      .zcard(fullKey)
      .exec();

    // `exec` resolves with one `[error, reply]` pair per queued command, or null if the transaction was discarded.
    if (!results) throw new Error('automod: window transaction was discarded by Redis');
    for (const [error] of results) {
      if (error) throw error;
    }
    const count = Number(results[results.length - 1]?.[1] ?? 0);

    return Math.min(count, MAX_WINDOW_MEMBERS);
  }

  async peek(key: string, nowMs: number, windowMs: number): Promise<string[]> {
    const fullKey = this.fullKey(key);
    const cutoff = nowMs - windowMs;
    await this.redis.zremrangebyscore(fullKey, 0, cutoff);
    return this.redis.zrange(fullKey, 0, -1);
  }
}

/** In-memory `WindowStore` for unit tests (TASK: "...an in-memory impl for tests") and any non-Redis test harness. */
export class MemoryWindowStore implements WindowStore {
  private readonly windows = new Map<string, { value: string; at: number }[]>();

  async pushAndCount(key: string, value: string, nowMs: number, windowMs: number): Promise<number> {
    const cutoff = nowMs - windowMs;
    const entries = (this.windows.get(key) ?? []).filter((e) => e.at > cutoff);
    entries.push({ value, at: nowMs });
    this.windows.set(key, entries);
    return entries.length;
  }

  async peek(key: string, nowMs: number, windowMs: number): Promise<string[]> {
    const cutoff = nowMs - windowMs;
    const entries = (this.windows.get(key) ?? []).filter((e) => e.at > cutoff);
    this.windows.set(key, entries);
    return entries.map((e) => e.value);
  }

  /** Test helper: clears every window. */
  clear(): void {
    this.windows.clear();
  }
}

/** Wraps `base` so every key is namespaced under `prefix` — used to give each `AutomodRule` its own isolated windows without threading a rule id through the (intentionally pure) evaluator signatures. */
export function scopedWindowStore(base: WindowStore, prefix: string): WindowStore {
  return {
    pushAndCount: (key, value, nowMs, windowMs) =>
      base.pushAndCount(`${prefix}:${key}`, value, nowMs, windowMs),
    peek: (key, nowMs, windowMs) => base.peek(`${prefix}:${key}`, nowMs, windowMs),
  };
}
