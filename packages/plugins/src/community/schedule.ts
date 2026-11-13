// Pure date/schedule parsing for the community plugin (announcements, reminders, events). No discord.js/Prisma
// imports here so this stays trivially unit-testable (ARCHITECTURE.md §13).
// `cron-parser` is a CJS module that assigns its named functions onto an object it then default-exports
// (`module.exports = CronParser`) rather than via static `exports.foo = ...`/`module.exports.foo = ...`
// assignments — cjs-module-lexer (Node's native ESM/CJS interop, used by `tsx` and any plain `node --loader`
// run) can't statically detect that pattern, so `import { parseExpression } from 'cron-parser'` resolves to
// `undefined` at runtime under Node's ESM loader (though it works under Vite/Vitest's own, more permissive
// CJS interop, and typechecks fine against the package's .d.ts — so this only breaks at actual runtime, e.g.
// `pnpm commands:export`). Importing the default and destructuring off it works under every runtime.
import cronParser from 'cron-parser';
import { DateTime } from 'luxon';
import { parseDuration } from '@pavisie/core';

export type ParsedSchedule =
  | { kind: 'cron'; cron: string; nextRunAt: Date }
  | { kind: 'at'; runAt: Date }
  | { kind: 'invalid'; reason: string };

const EXPLICIT_OFFSET = /(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/;
const CIVIL_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

interface CivilParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function timezoneIsValid(timezone: string): boolean {
  return DateTime.now().setZone(timezone).isValid;
}

function sameCivilTime(dt: DateTime, parts: CivilParts): boolean {
  return (
    dt.year === parts.year &&
    dt.month === parts.month &&
    dt.day === parts.day &&
    dt.hour === parts.hour &&
    dt.minute === parts.minute &&
    dt.second === parts.second
  );
}

/**
 * Luxon accepts a civil time that falls in a DST gap by shifting it forward an hour, and it picks one of the two
 * instants for a fall-back overlap, ignoring `disambiguation`. Either mistake schedules a reminder or event an
 * hour off. Explicit offsets are unambiguous and are kept as-is. Returns `null` when `input` is not a datetime.
 */
function parseZonedDateTime(
  input: string,
  timezone: string,
): { ok: true; date: Date } | { ok: false; reason: string } | null {
  if (EXPLICIT_OFFSET.test(input)) {
    const iso = DateTime.fromISO(input, { zone: timezone });
    if (!iso.isValid) return null;
    return { ok: true, date: iso.toJSDate() };
  }

  const match = CIVIL_TIME.exec(input);
  if (!match) {
    const iso = DateTime.fromISO(input, { zone: timezone });
    if (!iso.isValid) return null;
    return { ok: true, date: iso.toJSDate() };
  }

  if (!timezoneIsValid(timezone)) {
    return { ok: false, reason: `Unknown timezone "${timezone}".` };
  }

  const parts: CivilParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: match[4] !== undefined ? Number(match[4]) : 0,
    minute: match[5] !== undefined ? Number(match[5]) : 0,
    second: match[6] !== undefined ? Number(match[6]) : 0,
  };
  const dt = DateTime.fromObject(
    { ...parts, millisecond: 0 },
    { zone: timezone },
  );
  if (!dt.isValid) return null;
  if (!sameCivilTime(dt, parts)) {
    return {
      ok: false,
      reason: `That time doesn't exist in ${timezone} because clocks spring forward and skip it. Pick another time, or include an offset like -04:00.`,
    };
  }

  for (const deltaMin of [-120, -90, -60, -30, 30, 60, 90, 120]) {
    const other = DateTime.fromMillis(dt.toMillis() + deltaMin * 60_000, { zone: timezone });
    if (other.isValid && other.offset !== dt.offset && sameCivilTime(other, parts)) {
      return {
        ok: false,
        reason: `That time happens twice in ${timezone} when clocks fall back. Include an offset so the instant is unambiguous, for example -04:00 or -05:00.`,
      };
    }
  }

  return { ok: true, date: dt.toJSDate() };
}

/** True if `expr` validates as a cron-parser expression under `timezone`. */
export function validateCron(
  expr: string,
  timezone: string,
): { ok: true; nextRunAt: Date } | { ok: false; reason: string } {
  try {
    const interval = cronParser.parseExpression(expr, { tz: timezone });
    return { ok: true, nextRunAt: interval.next().toDate() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Invalid cron expression.' };
  }
}

/**
 * Parses a `when` string as, in order: a cron expression (5-6 whitespace-separated fields), an ISO 8601
 * date/time (interpreted in `timezone` when it carries no explicit offset), or a relative duration like
 * `10m`/`2h30m` (relative to `now`). Returns `{ kind: 'invalid' }` if none of those match.
 */
export function parseSchedule(input: string, timezone: string, now: Date = new Date()): ParsedSchedule {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      kind: 'invalid',
      reason: 'Provide a cron expression, an ISO date/time, or a duration like "10m" or "2h".',
    };
  }

  const fieldCount = trimmed.split(/\s+/).length;
  if (fieldCount === 5 || fieldCount === 6) {
    const cronResult = validateCron(trimmed, timezone);
    if (cronResult.ok) {
      return { kind: 'cron', cron: trimmed, nextRunAt: cronResult.nextRunAt };
    }
  }

  const zoned = parseZonedDateTime(trimmed, timezone);
  if (zoned) {
    if (!zoned.ok) return { kind: 'invalid', reason: zoned.reason };
    return { kind: 'at', runAt: zoned.date };
  }

  const durationMs = parseDuration(trimmed);
  if (durationMs !== null && durationMs > 0) {
    return { kind: 'at', runAt: new Date(now.getTime() + durationMs) };
  }

  return {
    kind: 'invalid',
    reason: 'Could not parse that as a cron expression, an ISO date/time, or a duration like "10m" or "2h".',
  };
}

/**
 * Parses a one-off "at" time only (no cron) — used by `/remind set` and `/event create`, which never accept a
 * cron expression for their primary time field. Accepts ISO 8601 (in `timezone`) or a relative duration.
 */
export function parseAt(
  input: string,
  timezone: string,
  now: Date = new Date(),
): { ok: true; date: Date } | { ok: false; reason: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Provide an ISO date/time or a duration like "10m" or "2h".' };
  }

  const zoned = parseZonedDateTime(trimmed, timezone);
  if (zoned) return zoned;

  const durationMs = parseDuration(trimmed);
  if (durationMs !== null && durationMs > 0) {
    return { ok: true, date: new Date(now.getTime() + durationMs) };
  }

  return { ok: false, reason: 'Could not parse that as an ISO date/time or a duration like "10m" or "2h".' };
}
