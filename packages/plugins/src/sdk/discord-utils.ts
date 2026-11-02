import {
  ChannelType,
  PermissionFlagsBits,
  userMention,
  roleMention,
  channelMention,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type MessageCreateOptions,
  type MessagePayload,
  type User,
} from 'discord.js';

export { userMention, roleMention, channelMention };

export interface SafeDmResult {
  sent: boolean;
  error?: string;
  /** The caught error itself, so callers can log it with its stack and code (`error` is message-only). */
  cause?: unknown;
}

/** Attempts to DM `user`. Never throws — DMs routinely fail (blocked bot, closed DMs, shared server left) and that must never break the calling flow. */
export async function safeDm(
  user: User,
  payload: string | MessagePayload | MessageCreateOptions,
): Promise<SafeDmResult> {
  try {
    await user.send(payload);
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err), cause: err };
  }
}

/** Fetches a guild member by id, returning `null` instead of throwing if they aren't found (left, invalid id, etc). */
export async function fetchMemberSafe(guild: Guild, userId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

const SEND_REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
] as const;

/**
 * Resolves a text-capable channel by id in `guild`, returning it only if it's actually a channel the bot can
 * send messages in (right type, and has View Channel + Send Messages there). Returns `null` otherwise.
 */
export async function resolveTextChannel(
  guild: Guild,
  channelId: string,
): Promise<GuildTextBasedChannel | null> {
  let channel;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch {
    return null;
  }
  if (!channel || !channel.isTextBased() || channel.type === ChannelType.GuildStageVoice) {
    return null;
  }

  const botMember = guild.members.me;
  if (!botMember) return null;

  const perms = channel.permissionsFor(botMember);
  if (!perms || !perms.has(SEND_REQUIRED_PERMISSIONS)) return null;

  return channel as GuildTextBasedChannel;
}

/** Splits `array` into consecutive chunks of at most `size` elements each. */
export function chunk<T>(array: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk: size must be a positive integer.');
  const out: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** True if `str` looks like a Discord snowflake id (17-20 decimal digits). */
export function isSnowflake(str: string): boolean {
  return SNOWFLAKE_PATTERN.test(str);
}
