import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { Cooldowns } from '@pavisie/core';
import { MemoryWindowStore, RedisWindowStore, scopedWindowStore } from '../engine/window-store';

describe('RedisWindowStore (ioredis-mock)', () => {
  // ioredis-mock instances share one underlying in-memory dataset by default (it simulates a single server, not
  // per-instance isolation) — each test uses its own key so tests can't see each other's entries.

  it('counts entries within the window', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = new RedisWindowStore(redis);
    const now = Date.now();

    expect(await store.pushAndCount('counts', 'a', now, 10_000)).toBe(1);
    expect(await store.pushAndCount('counts', 'b', now + 1000, 10_000)).toBe(2);
    expect(await store.pushAndCount('counts', 'c', now + 2000, 10_000)).toBe(3);
  });

  it('prunes entries older than the window', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = new RedisWindowStore(redis);
    const now = Date.now();

    await store.pushAndCount('prunes', 'a', now, 1000);
    const count = await store.pushAndCount('prunes', 'b', now + 5000, 1000);
    expect(count).toBe(1);
  });

  it('does the whole push-and-count in one round trip', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = new RedisWindowStore(redis);
    const multi = vi.spyOn(redis, 'multi');
    const direct = [
      vi.spyOn(redis, 'zremrangebyscore'),
      vi.spyOn(redis, 'zadd'),
      vi.spyOn(redis, 'zremrangebyrank'),
      vi.spyOn(redis, 'pexpire'),
      vi.spyOn(redis, 'zcard'),
    ];

    expect(await store.pushAndCount('one-trip', 'a', Date.now(), 10_000)).toBe(1);

    // Everything goes through a single transaction; nothing is sent as its own command.
    expect(multi).toHaveBeenCalledTimes(1);
    for (const spy of direct) expect(spy).not.toHaveBeenCalled();
  });

  it('gives simultaneous pushes consecutive counts', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = new RedisWindowStore(redis);
    const now = Date.now();

    const counts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.pushAndCount('simultaneous', `m${i}`, now, 10_000)),
    );

    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('peek does not add an entry', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = new RedisWindowStore(redis);
    const now = Date.now();

    await store.pushAndCount('peek-test', 'a', now, 10_000);
    const peeked = await store.peek('peek-test', now, 10_000);
    expect(peeked.length).toBe(1);
    const countAfterPeek = await store.pushAndCount('peek-test', 'b', now, 10_000);
    expect(countAfterPeek).toBe(2);
  });
});

describe('MemoryWindowStore', () => {
  it('matches RedisWindowStore semantics for counting and pruning', async () => {
    const store = new MemoryWindowStore();
    const now = Date.now();
    expect(await store.pushAndCount('k', 'a', now, 1000)).toBe(1);
    expect(await store.pushAndCount('k', 'b', now + 500, 1000)).toBe(2);
    expect(await store.pushAndCount('k', 'c', now + 2000, 1000)).toBe(1);
  });
});

describe('scopedWindowStore', () => {
  it('isolates two rules sharing the same base store', async () => {
    const base = new MemoryWindowStore();
    const ruleA = scopedWindowStore(base, 'ruleA');
    const ruleB = scopedWindowStore(base, 'ruleB');
    const now = Date.now();

    await ruleA.pushAndCount('freq:u1', 'm1', now, 10_000);
    await ruleA.pushAndCount('freq:u1', 'm2', now, 10_000);
    const countB = await ruleB.pushAndCount('freq:u1', 'm1', now, 10_000);

    expect(countB).toBe(1);
  });
});

describe('Cooldowns (ioredis-mock) — per-rule per-user cooldown', () => {
  it('allows the first take and blocks a second within the window', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const cooldowns = new Cooldowns(redis);

    const first = await cooldowns.take('automod:rule1:user1', 60);
    expect(first.ok).toBe(true);

    const second = await cooldowns.take('automod:rule1:user1', 60);
    expect(second.ok).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it('is independent per rule and per user', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const cooldowns = new Cooldowns(redis);

    await cooldowns.take('automod:rule1:user1', 60);
    const differentUser = await cooldowns.take('automod:rule1:user2', 60);
    const differentRule = await cooldowns.take('automod:rule2:user1', 60);

    expect(differentUser.ok).toBe(true);
    expect(differentRule.ok).toBe(true);
  });
});
