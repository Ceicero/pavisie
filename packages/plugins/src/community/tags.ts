// Tag rendering (spec CG-02). Tags are plain text and/or a flat embed rendered with the welcome engine's fixed,
// non-recursive `renderTemplate` variable set — `{user}`, `{user.tag}`, `{user.id}`, `{server}`,
// `{memberCount}`, `{mention}` — and nothing else is ever evaluated. Pure trigger/name/schema logic lives in
// `./tag-schemas.ts` (discord.js-free so the API can import it); this module adds the discord.js `EmbedBuilder`
// side and is what the bot's command/event code uses.
import { EmbedBuilder, type Guild, type MessageMentionOptions, type User } from 'discord.js';
import { EMBED_LIMITS, sanitizeEmbedText, truncate } from '@pavisie/core';
import { renderTemplate, type TemplateVars } from '../roles/engine';
import { parseColorHex } from '../utility/embed-payload';
import { isTagEmbedEmpty, tagEmbedSchema, type TagEmbedInput } from './tag-schemas';

export * from './tag-schemas';

export interface RenderableTag {
  content: string | null | undefined;
  embed: unknown;
}

export interface RenderedTag {
  content?: string;
  embeds?: EmbedBuilder[];
  allowedMentions: MessageMentionOptions;
}

/** Builds the fixed template variable set for a tag invoked by (or triggered by a message from) `user` in `guild`. */
export function tagTemplateVars(user: User, guild: Guild): TemplateVars {
  return {
    user: user.username,
    'user.tag': user.tag,
    'user.id': user.id,
    server: guild.name,
    memberCount: guild.memberCount,
    mention: `<@${user.id}>`,
  };
}

/** Coerces the stored `Tag.embed` JSON into a validated flat embed payload (or `undefined` if absent/invalid/empty). */
export function parseStoredTagEmbed(raw: unknown): TagEmbedInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const parsed = tagEmbedSchema.safeParse(raw);
  if (!parsed.success || isTagEmbedEmpty(parsed.data)) return undefined;
  return parsed.data;
}

/**
 * Renders a tag for sending: template tokens substituted (unknown tokens stay literal), embed text fields
 * mention-stripped via `sanitizeEmbedText`, and `allowedMentions.parse = []` always — the only mention a tag
 * can ever produce is the invoker's own `{mention}` (explicitly whitelisted via `users: [invokerId]`); never
 * `@everyone`/`@here`/roles.
 */
export function renderTag(tag: RenderableTag, vars: TemplateVars, invokerId?: string): RenderedTag {
  // Only plain-text content can ping; embed text is mention-stripped by `sanitizeEmbedText` below anyway.
  const usesMention = typeof tag.content === 'string' && tag.content.includes('{mention}');
  const allowedMentions: MessageMentionOptions =
    invokerId && usesMention ? { parse: [], users: [invokerId] } : { parse: [] };

  const out: RenderedTag = { allowedMentions };

  if (typeof tag.content === 'string' && tag.content.trim().length > 0) {
    out.content = truncate(renderTemplate(tag.content, vars), 2000);
  }

  const embedPayload = parseStoredTagEmbed(tag.embed);
  if (embedPayload) {
    const embed = new EmbedBuilder();
    if (embedPayload.title) {
      embed.setTitle(sanitizeEmbedText(renderTemplate(embedPayload.title, vars), EMBED_LIMITS.title));
    }
    if (embedPayload.description) {
      embed.setDescription(
        sanitizeEmbedText(renderTemplate(embedPayload.description, vars), EMBED_LIMITS.description),
      );
    }
    if (embedPayload.footer) {
      embed.setFooter({
        text: sanitizeEmbedText(renderTemplate(embedPayload.footer, vars), EMBED_LIMITS.footer),
      });
    }
    if (embedPayload.imageUrl) {
      embed.setImage(embedPayload.imageUrl);
    }
    try {
      const color = parseColorHex(embedPayload.colorHex);
      if (color !== undefined) embed.setColor(color);
    } catch {
      // Stored color is malformed (should not happen — validated on write); render without a color.
    }
    out.embeds = [embed];
  }

  return out;
}
