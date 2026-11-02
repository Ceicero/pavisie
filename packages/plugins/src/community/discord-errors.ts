/** Discord REST codes the community jobs must treat as "this post can never succeed", not as a transient failure. */
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
 * Classifies the Discord errors that end/draw/sync jobs hit once a channel or message is gone, or the bot
 * cannot see it. Anything else (network, 5xx, rate limit) returns `null` so the caller can retry.
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
