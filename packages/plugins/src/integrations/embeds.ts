import { EmbedBuilder } from 'discord.js';
import { EMBED_LIMITS, truncate } from '@pavisie/core';
import { resolveTextChannel, roleMention, type PluginContext } from '../sdk';
import type { AlertEmbedData } from './formatters/types';

/** Converts a provider formatter's plain-data `AlertEmbedData` into a real discord.js embed, right before sending
 * (kept separate from the formatters themselves so those stay pure and trivially unit-testable). */
export function toEmbedBuilder(data: AlertEmbedData): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(truncate(data.title, EMBED_LIMITS.title));
  if (data.url) embed.setURL(data.url);
  if (data.description) embed.setDescription(truncate(data.description, EMBED_LIMITS.description));
  if (data.color !== undefined) embed.setColor(data.color);
  if (data.thumbnailUrl) embed.setThumbnail(data.thumbnailUrl);
  if (data.imageUrl) embed.setImage(data.imageUrl);
  if (data.authorName) embed.setAuthor({ name: truncate(data.authorName, 256), iconURL: data.authorIconUrl });
  if (data.fields && data.fields.length > 0) {
    embed.addFields(
      data.fields
        .slice(0, EMBED_LIMITS.fields)
        .map((f) => ({
          name: truncate(f.name, EMBED_LIMITS.fieldName),
          value: truncate(f.value, EMBED_LIMITS.fieldValue),
          inline: f.inline ?? false,
        })),
    );
  }
  if (data.footer) embed.setFooter({ text: truncate(data.footer, EMBED_LIMITS.footer) });
  embed.setTimestamp();
  return embed;
}

export interface AlertTarget {
  guildId: string;
  channelId: string;
  roleId?: string | null;
}

/**
 * Sends a formatted alert embed to a guild channel, with an optional role mention. Never throws — a channel the
 * bot can no longer see/post in, or a guild it's left, just means the alert is silently skipped (the caller
 * still records `lastSyncAt`/dedupe state so the underlying item is never re-alerted later).
 */
export async function postAlert(
  ctx: PluginContext,
  target: AlertTarget,
  data: AlertEmbedData,
): Promise<boolean> {
  try {
    const guild = await ctx.client.guilds.fetch(target.guildId).catch(() => null);
    if (!guild) return false;
    const channel = await resolveTextChannel(guild, target.channelId);
    if (!channel) return false;

    const embed = toEmbedBuilder(data);
    const content = target.roleId ? roleMention(target.roleId) : undefined;
    await channel.send({
      content,
      embeds: [embed],
      allowedMentions: target.roleId ? { roles: [target.roleId] } : { parse: [] },
    });
    return true;
  } catch (err) {
    ctx.logger.warn(
      { err, guildId: target.guildId, channelId: target.channelId },
      'integrations: failed to post alert',
    );
    return false;
  }
}
