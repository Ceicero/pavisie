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

  const iso = DateTime.fromISO(trimmed, { zone: timezone });
  if (iso.isValid) {
    return { kind: 'at', runAt: iso.toJSDate() };
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

  const iso = DateTime.fromISO(trimmed, { zone: timezone });
  if (iso.isValid) {
    return { ok: true, date: iso.toJSDate() };
  }

  const durationMs = parseDuration(trimmed);
  if (durationMs !== null && durationMs > 0) {
    return { ok: true, date: new Date(now.getTime() + durationMs) };
  }

  return { ok: false, reason: 'Could not parse that as an ISO date/time or a duration like "10m" or "2h".' };
}
