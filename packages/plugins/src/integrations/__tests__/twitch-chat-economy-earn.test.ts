import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXCLUDED_CHAT_BOT_LOGINS,
  earnCooldownKey,
  earnDailyBudgetKey,
  isExcludedChatBotLogin,
  msUntilNextUtcMidnight,
  reserveDailyEarnBudget,
  utcDateStamp,
} from '../twitch-chat/economy-earn';

const GUILD_ID = 'guild-1';
const VIEWER_ID = 'viewer-1';
const NOON_UTC = new Date('2026-01-01T12:00:00.000Z');

describe('economy-earn — pure helpers', () => {
  it('utcDateStamp formats YYYY-MM-DD in UTC', () => {
    expect(utcDateStamp(new Date('2026-01-01T23:59:59.999Z'))).toBe('2026-01-01');
    expect(utcDateStamp(new Date('2026-01-02T00:00:00.000Z'))).toBe('2026-01-02');
  });

  it('msUntilNextUtcMidnight computes the exact remaining time', () => {
    expect(msUntilNextUtcMidnight(NOON_UTC)).toBe(12 * 60 * 60 * 1000);
    expect(msUntilNextUtcMidnight(new Date('2026-01-01T23:59:59.000Z'))).toBe(1000);
  });

  it('cooldown and daily-budget keys are namespaced per guild/viewer(/date)', () => {
    expect(earnCooldownKey(GUILD_ID, VIEWER_ID)).toContain(GUILD_ID);
    expect(earnCooldownKey(GUILD_ID, VIEWER_ID)).toContain(VIEWER_ID);
    expect(earnDailyBudgetKey(GUILD_ID, VIEWER_ID, NOON_UTC)).toContain('2026-01-01');
    expect(earnDailyBudgetKey(GUILD_ID, VIEWER_ID, new Date('2026-01-02T00:00:00.000Z'))).toContain('2026-01-02');
  });
});

describe('reserveDailyEarnBudget', () => {
  // ioredis-mock instances share one process-wide in-memory store by default (see ai/__tests__/budget.test.ts).
  beforeEach(async () => {
    await new RedisMock().flushall();
  });

  function redis(): Redis {
    return new RedisMock() as unknown as Redis;
  }

  it('credits the full perMessage amount when far under the cap', async () => {
    const credited = await reserveDailyEarnBudget(redis(), GUILD_ID, VIEWER_ID, 5, 200, NOON_UTC);
    expect(credited).toBe(5);
  });

  it('never lets the day total exceed the cap, crediting a smaller partial amount on the final message', async () => {
    const r = redis();
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const credited = await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 5, 22, NOON_UTC);
      total += credited;
    }
    expect(total).toBe(22); // 4 full credits of 5 (20) + one partial credit of 2, then zero forever after
  });

  it('credits exactly 0 once the cap is already reached', async () => {
    const r = redis();
    await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 10, 10, NOON_UTC); // hits the cap exactly
    const credited = await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 10, 10, NOON_UTC);
    expect(credited).toBe(0);
  });

  it('is per-viewer and per-guild independent', async () => {
    const r = redis();
    const a = await reserveDailyEarnBudget(r, GUILD_ID, 'viewer-a', 5, 10, NOON_UTC);
    const b = await reserveDailyEarnBudget(r, GUILD_ID, 'viewer-b', 5, 10, NOON_UTC);
    const otherGuild = await reserveDailyEarnBudget(r, 'guild-2', 'viewer-a', 5, 10, NOON_UTC);
    expect([a, b, otherGuild]).toEqual([5, 5, 5]);
  });

  it('resets on a new UTC day (different date-scoped key)', async () => {
    const r = redis();
    await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 10, 10, NOON_UTC); // hits the cap for day 1
    const day2 = await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 10, 10, new Date('2026-01-02T00:00:01.000Z'));
    expect(day2).toBe(10);
  });

  it('returns 0 without touching Redis state when perMessage or cap is non-positive', async () => {
    const r = redis();
    expect(await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 0, 200, NOON_UTC)).toBe(0);
    expect(await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 5, 0, NOON_UTC)).toBe(0);
    const key = earnDailyBudgetKey(GUILD_ID, VIEWER_ID, NOON_UTC);
    expect(await r.get(key)).toBeNull();
  });

  it('sets a TTL on the daily counter so it expires at UTC midnight', async () => {
    const r = redis();
    await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 5, 200, NOON_UTC);
    const key = earnDailyBudgetKey(GUILD_ID, VIEWER_ID, NOON_UTC);
    const ttlMs = await r.pttl(key);
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(12 * 60 * 60 * 1000);
  });

  it('still carries a TTL on the clamp path (partial-final-credit / over-cap), never a persistent key', async () => {
    const r = redis();
    const key = earnDailyBudgetKey(GUILD_ID, VIEWER_ID, NOON_UTC);

    // Drive the counter past the cap so the clamp (`SET ... PX`) branch runs.
    await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 10, 10, NOON_UTC); // exactly hits the cap
    let ttlMs = await r.pttl(key);
    expect(ttlMs).toBeGreaterThan(0);

    await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 10, 10, NOON_UTC); // over cap -> clamp branch
    ttlMs = await r.pttl(key);
    expect(ttlMs).toBeGreaterThan(0); // never -1 (no TTL) or -2 (missing)
    expect(ttlMs).toBeLessThanOrEqual(12 * 60 * 60 * 1000);
    expect(await r.get(key)).toBe('10'); // clamped back to the cap, not left inflated
  });

  it('the INCRBY+PEXPIRE pair is a single atomic write (the key is never observably valueless with no TTL)', async () => {
    // Not a true crash-injection test (this module doesn't expose a seam for that), but asserts the
    // MULTI-based implementation: immediately after the call, the key has BOTH a value and a TTL — the two
    // writes that used to be separate round trips are indistinguishable from one atomic operation here.
    const r = redis();
    const key = earnDailyBudgetKey(GUILD_ID, VIEWER_ID, NOON_UTC);
    await reserveDailyEarnBudget(r, GUILD_ID, VIEWER_ID, 5, 200, NOON_UTC);
    expect(await r.get(key)).toBe('5');
    expect(await r.pttl(key)).toBeGreaterThan(0);
  });
});

describe('isExcludedChatBotLogin', () => {
  it('excludes every listed third-party bot login, case-insensitively', () => {
    for (const login of EXCLUDED_CHAT_BOT_LOGINS) {
      expect(isExcludedChatBotLogin(login)).toBe(true);
      expect(isExcludedChatBotLogin(login.toUpperCase())).toBe(true);
      expect(isExcludedChatBotLogin(login[0]!.toUpperCase() + login.slice(1))).toBe(true);
    }
  });

  it('does not exclude a normal viewer login or an empty/missing login', () => {
    expect(isExcludedChatBotLogin('a_regular_viewer')).toBe(false);
    expect(isExcludedChatBotLogin('')).toBe(false);
  });

  it('covers the exact required list', () => {
    expect([...EXCLUDED_CHAT_BOT_LOGINS].sort()).toEqual(
      [
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
      ].sort(),
    );
  });
});
