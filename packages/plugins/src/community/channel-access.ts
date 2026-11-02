import { ChannelType, PermissionFlagsBits, type Guild, type GuildTextBasedChannel } from 'discord.js';
import { classifyDiscordFailure, type DiscordFailure } from './discord-errors';

const SEND_REQUIRED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

export type OpenChannelResult =
  | { ok: true; channel: GuildTextBasedChannel }
  | { ok: false; failure: DiscordFailure | 'unavailable' };

/**
 * Resolves a text channel and reports *why* it isn't usable. `resolveTextChannel` collapses every failure to
 * `null`, which made end/draw jobs treat a deleted channel (10003), missing access (50001), and a blip the same.
 */
export async function openTextChannel(guild: Guild, channelId: string): Promise<OpenChannelResult> {
  let channel;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch (err) {
    const failure = classifyDiscordFailure(err);
    return { ok: false, failure: failure ?? 'unavailable' };
  }

  if (!channel || !channel.isTextBased() || channel.type === ChannelType.GuildStageVoice) {
    return { ok: false, failure: 'unknown_channel' };
  }

  const botMember = guild.members.me;
  if (!botMember) return { ok: false, failure: 'missing_access' };

  const perms = channel.permissionsFor(botMember);
  if (!perms || !perms.has(SEND_REQUIRED)) return { ok: false, failure: 'missing_permissions' };

  return { ok: true, channel: channel as GuildTextBasedChannel };
}
