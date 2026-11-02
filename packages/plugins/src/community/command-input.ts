/** Shortest giveaway or poll the commands will schedule. Shorter windows are easy to miss and hard to enter. */
export const MIN_OPEN_MS = 15_000;

/** Longest giveaway or poll the commands will schedule (28 days). */
export const MAX_OPEN_MS = 28 * 24 * 60 * 60 * 1000;

/** Clock skew allowed when deciding that a one-off time is already in the past. */
const PAST_SKEW_MS = 30_000;

const MISSING_ACCESS = 50_001;
const MISSING_PERMISSIONS = 50_013;

/** `null` when `ms` is a usable duration; otherwise why it was rejected. */
export function durationIssue(ms: number | null): 'invalid' | 'range' | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return 'invalid';
  if (ms < MIN_OPEN_MS || ms > MAX_OPEN_MS) return 'range';
  return null;
}

/** True when `date` is more than a few seconds before `now`. */
export function isInThePast(date: Date, now = Date.now()): boolean {
  return date.getTime() < now - PAST_SKEW_MS;
}

/** Trimmed text, or `null` when it is empty or only whitespace. */
export function nonBlank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Labels that repeat once case is ignored, in first-seen order, including the original spelling of the first
 * copy. Empty when every label is unique.
 */
export function duplicateOptionLabels(labels: string[]): string[] {
  const firstByKey = new Map<string, string>();
  const duplicates: string[] = [];
  for (const label of labels) {
    const key = label.toLocaleLowerCase();
    const first = firstByKey.get(key);
    if (first === undefined) {
      firstByKey.set(key, label);
      continue;
    }
    if (!duplicates.includes(first)) duplicates.push(first);
    if (!duplicates.includes(label)) duplicates.push(label);
  }
  return duplicates;
}

/** Discord 50001 / 50013 — the bot cannot see or send in the target channel. */
export function isMissingChannelPermission(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('code' in err)) return false;
  const code = (err as { code: unknown }).code;
  return code === MISSING_ACCESS || code === MISSING_PERMISSIONS;
}
