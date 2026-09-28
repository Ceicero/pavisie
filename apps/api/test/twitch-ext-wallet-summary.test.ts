import { describe, expect, it } from 'vitest';
import { computeWalletSummary } from '../src/lib/twitch-ext/wallet-summary';

describe('computeWalletSummary', () => {
  it('returns a zero-balance summary for no account at all (never-viewed wallet)', () => {
    const result = computeWalletSummary(null, null, new Date());
    expect(result).toEqual({ balance: 0n, dailyAvailableAt: null, streak: 0 });
  });

  it('reports dailyAvailableAt as null (claimable now) when the cooldown has already elapsed', () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const lastDailyAt = new Date('2026-01-01T00:00:00.000Z'); // 24h ago, cooldown is 20h
    const result = computeWalletSummary({ balance: 10n, lastDailyAt }, JSON.stringify({ streak: 3 }), now);
    expect(result.dailyAvailableAt).toBeNull();
  });

  it('reports a future dailyAvailableAt while still inside the cooldown window', () => {
    const now = new Date('2026-01-01T10:00:00.000Z');
    const lastDailyAt = new Date('2026-01-01T00:00:00.000Z'); // 10h ago, cooldown is 20h -> 10h left
    const result = computeWalletSummary({ balance: 10n, lastDailyAt }, null, now);
    expect(result.dailyAvailableAt).toEqual(new Date('2026-01-01T20:00:00.000Z'));
  });

  it('keeps the streak alive within the 48h grace window', () => {
    const now = new Date('2026-01-01T20:00:00.000Z');
    const lastDailyAt = new Date('2026-01-01T00:00:00.000Z'); // 20h ago, well within 48h
    const result = computeWalletSummary({ balance: 500n, lastDailyAt }, JSON.stringify({ streak: 7 }), now);
    expect(result.streak).toBe(7);
  });

  it('resets the displayed streak to 0 once the 48h grace window has passed', () => {
    const now = new Date('2026-01-05T00:00:00.000Z');
    const lastDailyAt = new Date('2026-01-01T00:00:00.000Z'); // 96h ago, past the 48h grace window
    const result = computeWalletSummary({ balance: 500n, lastDailyAt }, JSON.stringify({ streak: 7 }), now);
    expect(result.streak).toBe(0);
  });

  it('carries the real balance through unchanged', () => {
    const result = computeWalletSummary({ balance: 123456789n, lastDailyAt: null }, null, new Date());
    expect(result.balance).toBe(123456789n);
  });
});
