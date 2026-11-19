/**
 * Coverage for `apps/web/src/lib/dashboard/format.ts`.
 *
 * That module builds `Intl.DateTimeFormat` and `Intl.NumberFormat` at load time
 * with the default locale and no `timeZone`, so the process timezone at import
 * is baked in. These tests set `TZ=UTC` and dynamically import the module after
 * that (see `beforeAll`). Expected date and number strings are built with the
 * same Intl options, an explicit `timeZone: 'UTC'`, and the same default locale
 * — never hardcoded English — so they stay stable under TZ=America/Denver,
 * TZ=Asia/Tokyo, or LANG=de_DE.UTF-8 (when Node honors LANG at process start).
 *
 * Relative times that use the default `now` go through fake timers; every other
 * `formatRelativeTime` call passes an explicit `now`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const DATE_TIME_OPTIONS = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
} as const;

const DATE_OPTIONS = { year: 'numeric', month: 'short', day: 'numeric' } as const;

const COMPACT_NUMBER_OPTIONS = { notation: 'compact', maximumFractionDigits: 1 } as const;

/** Discord's documented example snowflake (API reference, Snowflake section). */
const DISCORD_DOCS_SNOWFLAKE = '175928847299117063';
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

const previousTz = process.env.TZ;
process.env.TZ = 'UTC';

type FormatModule = typeof import('../src/lib/dashboard/format');
let format: FormatModule;

beforeAll(async () => {
  process.env.TZ = 'UTC';
  vi.resetModules();
  format = await import('../src/lib/dashboard/format');
});

afterAll(() => {
  if (previousTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = previousTz;
  }
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function formatDateTimeUtc(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { ...DATE_TIME_OPTIONS, timeZone: 'UTC' }).format(date);
}

function formatDateUtc(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { ...DATE_OPTIONS, timeZone: 'UTC' }).format(date);
}

function formatNumberDefault(value: number): string {
  return new Intl.NumberFormat(undefined).format(value);
}

function formatCompactNumberDefault(value: number): string {
  return new Intl.NumberFormat(undefined, COMPACT_NUMBER_OPTIONS).format(value);
}

function formatRelativeAuto(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit);
}

/** Independently decode a Discord snowflake: `(id >> 22) + 1420070400000`. */
function snowflakeCreationDate(snowflake: string): Date {
  const ms = (BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS;
  return new Date(Number(ms));
}

function offsetBySeconds(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

describe('snowflakeToDate', () => {
  it('extracts the creation time from a known Discord snowflake', () => {
    const expected = snowflakeCreationDate(DISCORD_DOCS_SNOWFLAKE);
    expect(expected.toISOString()).toBe('2016-04-30T11:18:25.796Z');
    expect(format.snowflakeToDate(DISCORD_DOCS_SNOWFLAKE).getTime()).toBe(expected.getTime());
  });
});

describe('formatDateTime', () => {
  it('returns an em dash for an invalid string', () => {
    expect(format.formatDateTime('not-a-date')).toBe('—');
    expect(format.formatDateTime('')).toBe('—');
  });

  it('formats an ISO string and a Date in UTC', () => {
    const iso = '2026-01-05T15:04:00.000Z';
    const date = new Date(iso);
    const expected = formatDateTimeUtc(date);
    expect(format.formatDateTime(iso)).toBe(expected);
    expect(format.formatDateTime(date)).toBe(expected);
  });
});

describe('formatDate', () => {
  it('returns an em dash for an invalid string', () => {
    expect(format.formatDate('not-a-date')).toBe('—');
    expect(format.formatDate('')).toBe('—');
  });

  it('formats an ISO string and a Date in UTC', () => {
    const iso = '2026-01-05T15:04:00.000Z';
    const date = new Date(iso);
    const expected = formatDateUtc(date);
    expect(format.formatDate(iso)).toBe(expected);
    expect(format.formatDate(date)).toBe(expected);
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');

  it('returns an em dash for an invalid string', () => {
    expect(format.formatRelativeTime('not-a-date', now)).toBe('—');
    expect(format.formatRelativeTime('', now)).toBe('—');
  });

  it('uses numeric auto for a one-day offset (yesterday / tomorrow when the locale provides those)', () => {
    expect(format.formatRelativeTime(offsetBySeconds(now, -86400), now)).toBe(formatRelativeAuto(-1, 'day'));
    expect(format.formatRelativeTime(offsetBySeconds(now, 86400), now)).toBe(formatRelativeAuto(1, 'day'));
  });

  it('formats past and future offsets at each unit, including the unit boundaries', () => {
    const cases: [seconds: number, value: number, unit: Intl.RelativeTimeFormatUnit][] = [
      [0, 0, 'second'],
      [1, 1, 'second'],
      [30, 30, 'second'],
      [59, 59, 'second'],
      [60, 1, 'minute'],
      [3540, 59, 'minute'],
      [3600, 1, 'hour'],
      [82800, 23, 'hour'],
      [86400, 1, 'day'],
      [518400, 6, 'day'],
      [604800, 1, 'week'],
      [2419200, 4, 'week'],
      [2592000, 1, 'month'],
      [28512000, 11, 'month'],
      [31536000, 1, 'year'],
      [63072000, 2, 'year'],
    ];

    for (const [seconds, value, unit] of cases) {
      expect(format.formatRelativeTime(offsetBySeconds(now, seconds), now)).toBe(
        formatRelativeAuto(value, unit),
      );
      if (seconds !== 0) {
        expect(format.formatRelativeTime(offsetBySeconds(now, -seconds), now)).toBe(
          formatRelativeAuto(-value, unit),
        );
      }
    }
  });

  it('accepts an ISO string and an explicit now', () => {
    const input = '2026-06-15T10:00:00.000Z';
    expect(format.formatRelativeTime(input, now)).toBe(formatRelativeAuto(-2, 'hour'));
  });

  it('uses the system clock when now is omitted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(format.formatRelativeTime(offsetBySeconds(now, -3600))).toBe(formatRelativeAuto(-1, 'hour'));
    expect(format.formatRelativeTime(offsetBySeconds(now, 604800))).toBe(formatRelativeAuto(1, 'week'));
  });

  // formatRelativeTime picks the largest unit whose length is <= |diffSec|, then
  // Math.round(diffSec / unit). A value just shy of the next unit can round up
  // to that unit's count without switching units: ~23.6 hours (84960s) is still
  // below 1 day (86400s), so it formats as "24 hours" rather than "1 day". The
  // same crossover exists at the other unit edges (e.g. 59.6 minutes → "60
  // minutes"). Leaving this as a todo rather than locking in the current output.
  it.todo('steps up to the next unit when rounding crosses the unit boundary');
});

describe('formatNumber', () => {
  it('formats counts with the default locale grouping', () => {
    for (const value of [0, 1, 12, 12480, 1_000_000, -42, 12.5]) {
      expect(format.formatNumber(value)).toBe(formatNumberDefault(value));
    }
  });
});

describe('formatCompactNumber', () => {
  it('formats counts in compact notation with one fraction digit', () => {
    for (const value of [0, 999, 1000, 12500, 1_000_000, -12500, 12.5]) {
      expect(format.formatCompactNumber(value)).toBe(formatCompactNumberDefault(value));
    }
  });
});

describe('humanizeAction', () => {
  it('title-cases segments split on ".", "_" and "-"', () => {
    expect(format.humanizeAction('plugin.enable')).toBe('Plugin Enable');
    expect(format.humanizeAction('snake_case')).toBe('Snake Case');
    expect(format.humanizeAction('kebab-case')).toBe('Kebab Case');
    expect(format.humanizeAction('plugin.enable_foo-bar')).toBe('Plugin Enable Foo Bar');
  });

  it('keeps empty segments from consecutive or edge separators', () => {
    expect(format.humanizeAction('plugin..enable')).toBe('Plugin  Enable');
    expect(format.humanizeAction('_lead')).toBe(' Lead');
    expect(format.humanizeAction('trail-')).toBe('Trail ');
    expect(format.humanizeAction('...')).toBe('   ');
    expect(format.humanizeAction('')).toBe('');
  });
});
