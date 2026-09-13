import { EmbedBuilder } from 'discord.js';
import { BRAND, EMBED_LIMITS, brandIconUrl, env, truncate } from '@entrophy/core';
import { channelMention, userMention } from '../sdk';
import type { LogKind, LogPayload } from '../sdk';
import { LOG_KIND_LABELS } from './constants';

export interface BuildLogEmbedOptions {
  kind: LogKind;
  guildId: string;
  payload: LogPayload;
}

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/** `https://discord.com/channels/<guild>/<channel>/<message>` — a direct jump link to the referenced message. */
function jumpLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/**
 * Builds a compact, brand-colored log embed from a `LogPayload` (ARCHITECTURE.md §7.5's `LoggingService.log`
 * task: "title/description/fields/actor/target/channel/message jump link/timestamp"). Content fields
 * (`contentBefore`/`contentAfter`/`attachments`) are only included when the caller already redacted/gated them — this
 * function trusts whatever `payload` it's given, matching the plugin's own service which redacts and applies
 * the `logMessageContent` gate *before* calling this.
 */
export function buildLogEmbed({ kind, guildId, payload }: BuildLogEmbedOptions): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle(truncate(payload.title ?? LOG_KIND_LABELS[kind], EMBED_LIMITS.title))
    .setFooter({ text: BRAND.name, iconURL: brandIconUrl(env) })
    .setTimestamp();

  if (payload.description) {
    embed.setDescription(truncate(payload.description, EMBED_LIMITS.description));
  }

  const fields: EmbedField[] = [];

  if (payload.actorId) {
    fields.push({
      name: 'Actor',
      value: `${userMention(payload.actorId)} (\`${payload.actorId}\`)`,
      inline: true,
    });
  }
  if (payload.targetId && payload.targetId !== payload.actorId) {
    fields.push({
      name: 'Target',
      value: `${userMention(payload.targetId)} (\`${payload.targetId}\`)`,
      inline: true,
    });
  }
  if (payload.channelId) {
    fields.push({ name: 'Channel', value: channelMention(payload.channelId), inline: true });
  }
  if (payload.channelId && payload.messageId) {
    fields.push({
      name: 'Message',
      value: `[Jump to message](${jumpLink(guildId, payload.channelId, payload.messageId)})`,
      inline: true,
    });
  }
  if (payload.contentBefore) {
    fields.push({ name: 'Before', value: truncate(payload.contentBefore, EMBED_LIMITS.fieldValue) });
  }
  if (payload.contentAfter) {
    fields.push({ name: 'After', value: truncate(payload.contentAfter, EMBED_LIMITS.fieldValue) });
  }
  if (payload.attachments && payload.attachments.length > 0) {
    fields.push({
      name: 'Attachments',
      value: truncate(payload.attachments.join('\n'), EMBED_LIMITS.fieldValue),
    });
  }
  for (const field of payload.fields ?? []) {
    fields.push({
      name: truncate(field.name, EMBED_LIMITS.fieldName),
      value: truncate(field.value, EMBED_LIMITS.fieldValue),
      inline: field.inline,
    });
  }

  if (fields.length > 0) {
    embed.addFields(fields.slice(0, EMBED_LIMITS.fields));
  }

  return embed;
}
