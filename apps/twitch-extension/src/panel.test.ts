import { describe, expect, it } from 'vitest';
import { formatAmount, formatCountdown, msUntil } from './panel';

describe('formatCountdown', () => {
  it('formats a claimable-now (<=0) remainder as 0:00', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5000)).toBe('0:00');
  });

  it('formats under an hour as M:SS', () => {
    expect(formatCountdown(5000)).toBe('0:05');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(59 * 60_000 + 59_000)).toBe('59:59');
  });

  it('formats an hour or more as H:MM:SS', () => {
    expect(formatCountdown(60 * 60_000)).toBe('1:00:00');
    expect(formatCountdown(3 * 60 * 60_000 + 5 * 60_000 + 9_000)).toBe('3:05:09');
  });

  it('rounds up to the next whole second so the display never shows 0:00 while time truly remains', () => {
    expect(formatCountdown(500)).toBe('0:01');
  });
});

describe('formatAmount', () => {
  it('adds thousands separators to a decimal-integer string', () => {
    expect(formatAmount('1234567')).toBe('1,234,567');
    expect(formatAmount('0')).toBe('0');
    expect(formatAmount('42')).toBe('42');
  });

  it('falls back to the raw string on unparsable input rather than throwing', () => {
    expect(formatAmount('not-a-number')).toBe('not-a-number');
  });
});

describe('msUntil', () => {
  it('returns 0 for a null timestamp (claimable now)', () => {
    expect(msUntil(null, Date.now())).toBe(0);
  });

  it('returns the positive delta for a future timestamp', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const future = '2026-01-01T00:05:00.000Z';
    expect(msUntil(future, now)).toBe(5 * 60_000);
  });

  it('clamps to 0 for a past timestamp', () => {
    const now = Date.parse('2026-01-01T00:05:00.000Z');
    const past = '2026-01-01T00:00:00.000Z';
    expect(msUntil(past, now)).toBe(0);
  });

  it('returns 0 for an unparsable timestamp rather than NaN', () => {
    expect(msUntil('not-a-date', Date.now())).toBe(0);
  });
});
