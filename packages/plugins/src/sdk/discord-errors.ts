/** Discord REST codes callers must treat as "this action can never succeed", not as a transient failure. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_GUILD = 10004;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_USER = 10013;
const MISSING_ACCESS = 50001;
const CANNOT_DM = 50007;
const MISSING_PERMISSIONS = 50013;

export type DiscordFailure =
  | 'unknown_channel'
  | 'unknown_guild'
  | 'unknown_message'
  | 'unknown_user'
  | 'missing_access'
  | 'missing_permissions'
  | 'cannot_dm';

/** Numeric Discord API code carried on a discord.js / REST error, or `null` when `err` isn't one of those. */
export function discordErrorCode(err: unknown): number | null {
  if (!err || typeof err !== 'object' || !('code' in err)) return null;
  const code = (err as { code: unknown }).code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  return null;
}

/**
 * Classifies the Discord errors that mean a channel, message, guild, or user is gone, or the bot cannot
 * see or message it. Anything else (network, 5xx, rate limit) returns `null` so the caller can retry.
 */
export function classifyDiscordFailure(err: unknown): DiscordFailure | null {
  switch (discordErrorCode(err)) {
    case UNKNOWN_CHANNEL:
      return 'unknown_channel';
    case UNKNOWN_GUILD:
      return 'unknown_guild';
    case UNKNOWN_MESSAGE:
      return 'unknown_message';
    case UNKNOWN_USER:
      return 'unknown_user';
    case MISSING_ACCESS:
      return 'missing_access';
    case MISSING_PERMISSIONS:
      return 'missing_permissions';
    case CANNOT_DM:
      return 'cannot_dm';
    default:
      return null;
  }
}

const FAILURE_KEYS = {
  unknown_channel: 'errors.channel_gone',
  unknown_guild: null,
  unknown_message: 'errors.message_gone',
  unknown_user: null,
  missing_access: 'errors.cannot_post',
  missing_permissions: 'errors.cannot_post',
  cannot_dm: 'errors.cannot_dm',
} as const satisfies Record<DiscordFailure, string | null>;

function isClassifiedFailure(value: unknown): value is DiscordFailure {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FAILURE_KEYS, value);
}

/**
 * Core i18n key for `t(discordFailureKey(...))`.
 *
 * Pass a raw error (`unknown`) — classified with {@link classifyDiscordFailure} — or an already-classified
 * {@link DiscordFailure} name. A bare numeric code is not an error object; pass `{ code }` or the failure
 * name instead. Returns `null` when classification is `null` (network, 5xx, rate limit) so callers can retry.
 *
 * `unknown_guild` and `unknown_user` also return `null`. No shared sentence fits "the server is gone" or
 * "that user id does not exist" without a new key, so callers that already know that context supply their own copy.
 */
export function discordFailureKey(failureOrError: unknown): (typeof FAILURE_KEYS)[DiscordFailure] {
  const failure = isClassifiedFailure(failureOrError)
    ? failureOrError
    : classifyDiscordFailure(failureOrError);
  if (!failure) return null;
  return FAILURE_KEYS[failure];
}
