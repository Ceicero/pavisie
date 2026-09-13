import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { beforeEach, describe, expect, it } from 'vitest';
import { reserveBudget, releaseReservation, readUsage, recordUsage, reconcileUsage } from '../budget';

const DAY_1 = new Date('2026-01-01T12:00:00.000Z');

describe('ai budget reservation — atomic atomicity and race prevention', () => {
  beforeEach(async () => {
    // RedisMock shares state across instances by default; flush the global store before each test.
    const flusher = new RedisMock();
    await flusher.flushall();
    await flusher.quit();
  });

  it('reserves against the budget before a provider call and succeeds when budgets have room', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const result = await reserveBudget(redis, 'guild-1', 'user-1', 10000, 1000, 500, DAY_1);
    expect(result.ok).toBe(true);
  });

  it('reserves tokens atomically: after a successful reserve, the budget counters are incremented', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const before = await readUsage(redis, 'guild-1', 'user-1', DAY_1);
    expect(before.guildUsed).toBe(0);

    const result = await reserveBudget(redis, 'guild-1', 'user-1', 10000, 1000, 500, DAY_1);
    expect(result.ok).toBe(true);

    const after = await readUsage(redis, 'guild-1', 'user-1', DAY_1);
    expect(after.guildUsed).toBe(500);
    expect(after.userUsed).toBe(500);
  });

  it('rejects a reservation when guild budget would be exceeded', async () => {
    const redis = new RedisMock() as unknown as Redis;
    // Pre-populate guild budget to near limit
    await recordUsage(redis, 'guild-1', 'user-1', 9500, DAY_1);
    const result = await reserveBudget(redis, 'guild-1', 'user-1', 10000, 5000, 1000, DAY_1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.scope).toBe('guild');
      expect(result.used).toBe(9500);
      expect(result.limit).toBe(10000);
    }
    // The claim is rolled back, so a refusal costs the guild nothing.
    expect((await readUsage(redis, 'guild-1', 'user-1', DAY_1)).guildUsed).toBe(9500);
  });

  it('rejects a reservation when per-user budget would be exceeded', async () => {
    const redis = new RedisMock() as unknown as Redis;
    // Pre-populate user budget to near limit
    await recordUsage(redis, 'guild-1', 'user-1', 950, DAY_1);
    const result = await reserveBudget(redis, 'guild-1', 'user-1', 10000, 1000, 200, DAY_1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.scope).toBe('user');
      expect(result.used).toBe(950);
      expect(result.limit).toBe(1000);
    }
    // Same rollback for a per-user refusal: neither counter keeps the rejected claim.
    const after = await readUsage(redis, 'guild-1', 'user-1', DAY_1);
    expect(after.userUsed).toBe(950);
    expect(after.guildUsed).toBe(950);
  });

  it('prevents concurrent requests from collectively exceeding guild budget', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const guildLimit = 1000;
    const perUserLimit = 1000;
    const estimatedTokens = 600;

    // First request reserves 600, leaving 400.
    const first = await reserveBudget(redis, 'guild-1', 'user-1', guildLimit, perUserLimit, estimatedTokens, DAY_1);
    expect(first.ok).toBe(true);

    // Second request should fail because 600 + 600 > 1000 (guild budget).
    const second = await reserveBudget(redis, 'guild-1', 'user-2', guildLimit, perUserLimit, estimatedTokens, DAY_1);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.scope).toBe('guild');
    }
  });

  it('allows concurrent requests when total stays under guild budget', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const guildLimit = 2000;
    const perUserLimit = 1500;
    const estimatedTokens = 400;

    const first = await reserveBudget(redis, 'guild-1', 'user-1', guildLimit, perUserLimit, estimatedTokens, DAY_1);
    expect(first.ok).toBe(true);

    const second = await reserveBudget(redis, 'guild-1', 'user-2', guildLimit, perUserLimit, estimatedTokens, DAY_1);
    expect(second.ok).toBe(true);

    // Verify both are counted
    const usage = await readUsage(redis, 'guild-1', 'user-1', DAY_1);
    expect(usage.guildUsed).toBe(800); // 400 + 400
  });

  it('releases (refunds) a failed reservation back to the budget', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const estimatedTokens = 500;

    // Reserve 500 tokens
    const reserve = await reserveBudget(redis, 'guild-1', 'user-1', 10000, 1000, estimatedTokens, DAY_1);
    expect(reserve.ok).toBe(true);

    let usage = await readUsage(redis, 'guild-1', 'user-1', DAY_1);
    expect(usage.guildUsed).toBe(500);

    // Provider call fails; release the reservation
    await releaseReservation(redis, 'guild-1', 'user-1', estimatedTokens, DAY_1);

    usage = await readUsage(redis, 'guild-1', 'user-1', DAY_1);
    expect(usage.guildUsed).toBe(0);
    expect(usage.userUsed).toBe(0);
  });

  it('a failed provider call does not permanently consume reserved budget', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const guildLimit = 1000;
    const perUserLimit = 1000;
    const estimatedTokens = 600;

    // First request reserves tokens.
    const first = await reserveBudget(redis, 'guild-1', 'user-1', guildLimit, perUserLimit, estimatedTokens, DAY_1);
    expect(first.ok).toBe(true);

    // Provider fails; we release the reservation.
    await releaseReservation(redis, 'guild-1', 'user-1', estimatedTokens, DAY_1);

    // Second request from a different user should now succeed (budget is available again).
    const second = await reserveBudget(redis, 'guild-1', 'user-2', guildLimit, perUserLimit, estimatedTokens, DAY_1);
    expect(second.ok).toBe(true);
  });

  it('reconciles reserved tokens with actual usage: debit excess, refund surplus', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const estimated = 500;
    const actual = 300; // Actual usage is less than estimated
    const adjustment = actual - estimated; // -200

    // Reserve 500
    await reserveBudget(redis, 'guild-1', 'user-1', 10000, 1000, estimated, DAY_1);

    // Reconcile: adjust by the difference to fine-tune the reserved estimate
    await reconcileUsage(redis, 'guild-1', 'user-1', adjustment, DAY_1);

    const usage = await readUsage(redis, 'guild-1', 'user-1', DAY_1);
    expect(usage.guildUsed).toBe(actual);
    expect(usage.userUsed).toBe(actual);
  });

  it('tracks separate guilds and users independently during reservation', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const estimatedTokens = 400;

    // Guild 1, User 1 reserves
    const g1u1 = await reserveBudget(redis, 'guild-1', 'user-1', 1000, 1000, estimatedTokens, DAY_1);
    expect(g1u1.ok).toBe(true);

    // Guild 1, User 2 reserves (same guild, different user)
    const g1u2 = await reserveBudget(redis, 'guild-1', 'user-2', 1000, 1000, estimatedTokens, DAY_1);
    expect(g1u2.ok).toBe(true);

    // Guild 2, User 1 reserves (different guild, same user)
    const g2u1 = await reserveBudget(redis, 'guild-2', 'user-1', 1000, 1000, estimatedTokens, DAY_1);
    expect(g2u1.ok).toBe(true);

    // Verify isolation
    const g1Usage = await readUsage(redis, 'guild-1', 'user-1', DAY_1);
    expect(g1Usage.guildUsed).toBe(800); // Both users in guild-1 reserved
    expect(g1Usage.userUsed).toBe(400); // Only user-1's share

    const g2Usage = await readUsage(redis, 'guild-2', 'user-1', DAY_1);
    expect(g2Usage.guildUsed).toBe(400); // Only user-1's reservation in guild-2
  });
});
