import { parseDuration } from '@entrophy/core';

/** Discord's hard limit on member timeout duration (28 days). */
export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const MIN_TIMEOUT_MS = 5_000;

/** A generous ceiling for temp-ban durations (1 year) — long enough to be effectively "no practical limit", short enough to reject typos. */
export const MAX_TEMP_BAN_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_TEMP_BAN_MS = 60_000;

export type DurationParseResult = { ok: true; ms: number } | { ok: false; error: string };

/** Parses and range-checks a `/mod timeout` duration string (e.g. `10m`, `1h30m`), enforcing Discord's 28-day cap. */
export function parseTimeoutDuration(input: string): DurationParseResult {
  const ms = parseDuration(input);
  if (ms === null || ms <= 0) {
    return {
      ok: false,
      error: `"${input}" isn't a valid duration. Use a combination like \`10m\`, \`2h\`, or \`1h30m\`.`,
    };
  }
  if (ms < MIN_TIMEOUT_MS) {
    return { ok: false, error: 'Timeout duration must be at least 5 seconds.' };
  }
  if (ms > MAX_TIMEOUT_MS) {
    return {
      ok: false,
      error:
        'Timeouts cannot exceed 28 days — Discord enforces this limit. Use `/mod ban` with a duration for longer removals.',
    };
  }
  return { ok: true, ms };
}

const MIN_MUTE_MS = 5_000;

/**
 * Parses and range-checks the Enforcer decision modal's MUTE duration (`enforcer/components/decide.ts`). A
 * MUTE is a role-add with a locally tracked expiry, not a Discord API timeout, so it has no 28-day cap — but an
 * unbounded string is still a typo trap, so this borrows the same 5-second floor as a timeout and the same
 * generous long-duration ceiling as a temp ban.
 */
export function parseMuteDuration(input: string): DurationParseResult {
  const ms = parseDuration(input);
  if (ms === null || ms <= 0) {
    return {
      ok: false,
      error: `"${input}" isn't a valid duration. Use a combination like \`10m\`, \`2h\`, or \`1h30m\`.`,
    };
  }
  if (ms < MIN_MUTE_MS) {
    return { ok: false, error: 'Mute duration must be at least 5 seconds.' };
  }
  if (ms > MAX_TEMP_BAN_MS) {
    return {
      ok: false,
      error: 'Mute duration cannot exceed 1 year. Leave the duration off for an indefinite mute.',
    };
  }
  return { ok: true, ms };
}

/** Parses and range-checks an optional `/mod ban duration` (temp ban) string. */
export function parseTempBanDuration(input: string): DurationParseResult {
  const ms = parseDuration(input);
  if (ms === null || ms <= 0) {
    return {
      ok: false,
      error: `"${input}" isn't a valid duration. Use a combination like \`1d\`, \`2w\`, or \`30d\`.`,
    };
  }
  if (ms < MIN_TEMP_BAN_MS) {
    return { ok: false, error: 'Temporary ban duration must be at least 1 minute.' };
  }
  if (ms > MAX_TEMP_BAN_MS) {
    return {
      ok: false,
      error: 'Temporary ban duration cannot exceed 1 year. Leave the duration off for a permanent ban.',
    };
  }
  return { ok: true, ms };
}
