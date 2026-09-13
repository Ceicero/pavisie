import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter, RateLimiter } from '../src/ratelimit';

describe('MemoryRateLimiter', () => {
  it('allows requests up to the limit within a window, then blocks', async () => {
    const now = 1_000_000;
    const limiter = new MemoryRateLimiter(() => now);

    const r1 = await limiter.consume('user-1', 3, 10_000);
    const r2 = await limiter.consume('user-1', 3, 10_000);
    const r3 = await limiter.consume('user-1', 3, 10_000);
    const r4 = await limiter.consume('user-1', 3, 10_000);

    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r3.remaining).toBe(0);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  it('resets the window after resetMs elapses', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);

    await limiter.consume('user-2', 1, 5_000);
    const blocked = await limiter.consume('user-2', 1, 5_000);
    expect(blocked.allowed).toBe(false);

    now += 5_001;
    const afterReset = await limiter.consume('user-2', 1, 5_000);
    expect(afterReset.allowed).toBe(true);
  });

  it('tracks separate windows per key', async () => {
    const limiter = new MemoryRateLimiter();
    const a = await limiter.consume('a', 1, 10_000);
    const b = await limiter.consume('b', 1, 10_000);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });
});

describe('RateLimiter (Redis via ioredis-mock)', () => {
  it('allows up to the limit then blocks within the window', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const limiter = new RateLimiter(redis);

    const r1 = await limiter.consume('guild-1:cmd', 2, 60_000);
    const r2 = await limiter.consume('guild-1:cmd', 2, 60_000);
    const r3 = await limiter.consume('guild-1:cmd', 2, 60_000);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);
    expect(r3.allowed).toBe(false);
  });

  it('sets an expiry only on the first hit (subsequent hits do not reset the TTL)', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const limiter = new RateLimiter(redis);

    await limiter.consume('guild-2:cmd', 5, 60_000);
    const ttlAfterFirst = await redis.pttl('pavisie:ratelimit:guild-2:cmd');
    await limiter.consume('guild-2:cmd', 5, 60_000);
    const ttlAfterSecond = await redis.pttl('pavisie:ratelimit:guild-2:cmd');

    expect(ttlAfterFirst).toBeGreaterThan(0);
    expect(ttlAfterSecond).toBeLessThanOrEqual(ttlAfterFirst);
  });
});
