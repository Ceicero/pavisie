import type Redis from 'ioredis';
import { redisKey, shortId } from '@pavisie/core';

const DEFAULT_TTL_SECONDS = 120;

/**
 * Short-lived Redis-backed store for payloads too large to fit in a component custom id
 * (ARCHITECTURE.md §7.7: `pavisie:pending:<uuid>` TTL 120s).
 */
export class PendingStore {
  constructor(private readonly redis: Redis) {}

  private key(id: string): string {
    return redisKey('pending', id);
  }

  /** Stores `payload` (JSON-serialized) under a new short id, expiring after `ttlSec` seconds. Returns the id. */
  async put(payload: unknown, ttlSec = DEFAULT_TTL_SECONDS): Promise<string> {
    const id = shortId(12);
    await this.redis.set(this.key(id), JSON.stringify(payload), 'EX', ttlSec);
    return id;
  }

  /** Reads and deletes the payload for `id` (single-use). Returns `null` if it doesn't exist or has expired. */
  async take<T = unknown>(id: string): Promise<T | null> {
    const key = this.key(id);
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    await this.redis.del(key);
    return JSON.parse(raw) as T;
  }

  /** Reads the payload for `id` without deleting it. Returns `null` if it doesn't exist or has expired. */
  async peek<T = unknown>(id: string): Promise<T | null> {
    const raw = await this.redis.get(this.key(id));
    return raw === null ? null : (JSON.parse(raw) as T);
  }
}
