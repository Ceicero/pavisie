import { describe, expect, it } from 'vitest';
import { parseAt, parseSchedule, validateCron } from '../schedule';

describe('parseSchedule', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('parses a valid cron expression', () => {
    const result = parseSchedule('0 12 * * *', 'UTC', now);
    expect(result.kind).toBe('cron');
    if (result.kind === 'cron') {
      expect(result.cron).toBe('0 12 * * *');
      expect(result.nextRunAt.getUTCHours()).toBe(12);
    }
  });

  it('parses an ISO date/time in the given timezone', () => {
    const result = parseSchedule('2026-06-01T10:00:00', 'UTC', now);
    expect(result.kind).toBe('at');
    if (result.kind === 'at') {
      expect(result.runAt.toISOString()).toBe('2026-06-01T10:00:00.000Z');
    }
  });

  it('parses a relative duration relative to `now`', () => {
    const result = parseSchedule('30m', 'UTC', now);
    expect(result.kind).toBe('at');
    if (result.kind === 'at') {
      expect(result.runAt.getTime()).toBe(now.getTime() + 30 * 60_000);
    }
  });

  it('rejects garbage input', () => {
    const result = parseSchedule('not a real schedule', 'UTC', now);
    expect(result.kind).toBe('invalid');
  });

  it('rejects an empty string', () => {
    expect(parseSchedule('   ', 'UTC', now).kind).toBe('invalid');
  });

  it('a duration-shaped six-field string never masquerades as a valid cron', () => {
    // Six space-separated fields, but not a real cron expression — should fall through to duration/ISO parsing (and fail both, since it's neither).
    const result = parseSchedule('a b c d e f', 'UTC', now);
    expect(result.kind).toBe('invalid');
  });
});

describe('validateCron', () => {
  it('accepts a standard 5-field cron expression', () => {
    expect(validateCron('*/15 * * * *', 'UTC').ok).toBe(true);
  });

  it('rejects an invalid cron expression', () => {
    expect(validateCron('not a cron', 'UTC').ok).toBe(false);
  });
});

describe('parseAt', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('parses an ISO date/time', () => {
    const result = parseAt('2026-03-15T09:30:00Z', 'UTC', now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.date.toISOString()).toBe('2026-03-15T09:30:00.000Z');
  });

  it('parses a relative duration', () => {
    const result = parseAt('2h', 'UTC', now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.date.getTime()).toBe(now.getTime() + 2 * 60 * 60_000);
  });

  it('never accepts a cron expression', () => {
    const result = parseAt('0 12 * * *', 'UTC', now);
    expect(result.ok).toBe(false);
  });

  it('rejects garbage input', () => {
    expect(parseAt('whenever', 'UTC', now).ok).toBe(false);
  });

  it('interprets a zone-less ISO time in the guild timezone', () => {
    const result = parseAt('2026-06-01T10:00:00', 'America/New_York', now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.date.toISOString()).toBe('2026-06-01T14:00:00.000Z');
  });

  it('keeps an explicit offset instead of reinterpreting it in the guild timezone', () => {
    const result = parseAt('2026-11-01T01:30:00-04:00', 'America/New_York', now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.date.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('rejects a local time that clocks skip on a spring-forward day', () => {
    const result = parseAt('2026-03-08T02:30:00', 'America/New_York', now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.toLowerCase()).toContain('spring');
  });

  it('rejects an ambiguous local time on a fall-back day', () => {
    const result = parseSchedule('2026-11-01T01:30:00', 'America/New_York', now);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason.toLowerCase()).toContain('fall back');
  });

  it('still accepts the first valid local time after a spring-forward gap', () => {
    const result = parseAt('2026-03-08T03:30:00', 'America/New_York', now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.date.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
});
