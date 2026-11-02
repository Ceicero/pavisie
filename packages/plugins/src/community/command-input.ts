/** Shortest giveaway or poll the commands will schedule. Shorter windows are easy to miss and hard to enter. */
export const MIN_OPEN_MS = 15_000;

/** Longest giveaway or poll the commands will schedule (28 days). */
export const MAX_OPEN_MS = 28 * 24 * 60 * 60 * 1000;

/** Clock skew allowed when deciding that a one-off time is already in the past. */
const PAST_SKEW_MS = 30_000;

const MISSING_ACCESS = 50_001;
const MISSING_PERMISSIONS = 50_013;
const UNKNOWN_CHANNEL = 10_003;
const UNKNOWN_MESSAGE = 10_008;

/** Discord `code` on an API error, accepting the number discord.js uses and the numeric string some mocks pass. */
function readErrorCode(err: unknown): number | null {
  if (!err || typeof err !== 'object' || !('code' in err)) return null;
  const code = (err as { code: unknown }).code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && /^-?\d+$/.test(code)) return Number(code);
  return null;
}

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
  const code = readErrorCode(err);
  return code === MISSING_ACCESS || code === MISSING_PERMISSIONS;
}

/** Discord 10003 — the channel was deleted (or the id never existed). */
export function isUnknownChannel(err: unknown): boolean {
  return readErrorCode(err) === UNKNOWN_CHANNEL;
}

/** Discord 10008 — the message was already deleted. */
export function isUnknownMessage(err: unknown): boolean {
  return readErrorCode(err) === UNKNOWN_MESSAGE;
}

export type ChannelPresence = 'live' | 'gone' | 'unknown';

/**
 * Whether `channelId` still exists in `guild`. `gone` only when Discord says so (null or 10003). Missing access
 * and any other failure stay `unknown` so callers don't drop config for a channel they merely can't see right now.
 * Guilds without a `channels.fetch` (tests, partial fixtures) are `unknown`.
 */
export async function channelPresence(
  guild: { channels?: { fetch?: (id: string) => Promise<unknown> } },
  channelId: string,
): Promise<ChannelPresence> {
  const channels = guild.channels;
  const fetchChannel = channels?.fetch;
  if (typeof fetchChannel !== 'function') return 'unknown';
  try {
    const channel = await fetchChannel.call(channels, channelId);
    return channel ? 'live' : 'gone';
  } catch (err) {
    if (isUnknownChannel(err)) return 'gone';
    return 'unknown';
  }
}

/**
 * `true`/`false` when `channel.permissionsFor(member)` can answer; `null` when the member or the permission
 * lookup isn't available (don't treat "couldn't check" as a denial).
 *
 * The channel is typed loosely on purpose: discord.js overloads `permissionsFor`, and a precise parameter
 * type is not assignable from those overloads.
 */
export function botHasChannelPermission(
  channel: object,
  member: unknown,
  permission: bigint,
): boolean | null {
  const lookup = (
    channel as {
      permissionsFor?: (member: unknown) => { has: (permission: bigint) => boolean } | null;
    }
  ).permissionsFor;
  if (!member || typeof lookup !== 'function') return null;
  const perms = lookup.call(channel, member);
  if (!perms) return false;
  return perms.has(permission);
}
