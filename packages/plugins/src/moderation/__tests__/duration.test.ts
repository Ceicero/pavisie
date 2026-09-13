import { describe, expect, it } from 'vitest';
import {
  MAX_TEMP_BAN_MS,
  MAX_TIMEOUT_MS,
  parseMuteDuration,
  parseTempBanDuration,
  parseTimeoutDuration,
} from '../duration';

describe('parseTimeoutDuration', () => {
  it('parses simple and combined durations', () => {
    expect(parseTimeoutDuration('10m')).toEqual({ ok: true, ms: 10 * 60_000 });
    expect(parseTimeoutDuration('2h')).toEqual({ ok: true, ms: 2 * 3_600_000 });
    expect(parseTimeoutDuration('1h30m')).toEqual({ ok: true, ms: 3_600_000 + 30 * 60_000 });
  });

  it('rejects garbage input', () => {
    expect(parseTimeoutDuration('banana')).toMatchObject({ ok: false });
    expect(parseTimeoutDuration('')).toMatchObject({ ok: false });
    expect(parseTimeoutDuration('10')).toMatchObject({ ok: false });
    expect(parseTimeoutDuration('-10m')).toMatchObject({ ok: false });
  });

  it('rejects durations below the minimum', () => {
    expect(parseTimeoutDuration('1s')).toMatchObject({ ok: false });
  });

  it("accepts exactly Discord's 28-day cap", () => {
    const result = parseTimeoutDuration('28d');
    expect(result).toEqual({ ok: true, ms: MAX_TIMEOUT_MS });
  });

  it('rejects anything over the 28-day cap', () => {
    expect(parseTimeoutDuration('29d')).toMatchObject({ ok: false });
    expect(parseTimeoutDuration('4w1d')).toMatchObject({ ok: false });
  });
});

describe('parseTempBanDuration', () => {
  it('parses valid durations', () => {
    expect(parseTempBanDuration('7d')).toEqual({ ok: true, ms: 7 * 86_400_000 });
    expect(parseTempBanDuration('1m')).toEqual({ ok: true, ms: 60_000 });
  });

  it('rejects below the minimum and above the 1-year cap', () => {
    expect(parseTempBanDuration('30s')).toMatchObject({ ok: false });
    expect(parseTempBanDuration('400d')).toMatchObject({ ok: false });
  });

  it('accepts exactly the 1-year cap', () => {
    expect(parseTempBanDuration('365d')).toEqual({ ok: true, ms: MAX_TEMP_BAN_MS });
  });

  it('rejects garbage input', () => {
    expect(parseTempBanDuration('forever')).toMatchObject({ ok: false });
  });
});

describe('parseMuteDuration', () => {
  it('parses valid durations, sharing the timeout floor', () => {
    expect(parseMuteDuration('10m')).toEqual({ ok: true, ms: 10 * 60_000 });
    expect(parseMuteDuration('5s')).toEqual({ ok: true, ms: 5_000 });
  });

  it('rejects below the 5-second floor', () => {
    expect(parseMuteDuration('4s')).toMatchObject({ ok: false });
  });

  it('accepts durations well past the 28-day timeout cap — MUTE has no such cap', () => {
    expect(parseMuteDuration('60d')).toEqual({ ok: true, ms: 60 * 86_400_000 });
  });

  it('accepts exactly the 1-year ceiling and rejects past it', () => {
    expect(parseMuteDuration('365d')).toEqual({ ok: true, ms: MAX_TEMP_BAN_MS });
    expect(parseMuteDuration('400d')).toMatchObject({ ok: false });
  });

  it('rejects garbage input', () => {
    expect(parseMuteDuration('forever')).toMatchObject({ ok: false });
  });
});
