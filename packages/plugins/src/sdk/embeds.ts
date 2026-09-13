import { EmbedBuilder } from 'discord.js';
import { BRAND, EMBED_LIMITS, brandIconUrl, env, truncate } from '@pavisie/core';

/** A bare embed pre-set to the platform brand color and footer (with the brand icon when `WEB_URL` is set), timestamped. */
export function brandEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BRAND.color)
    .setFooter({ text: BRAND.name, iconURL: brandIconUrl(env) })
    .setTimestamp();
}

/** A green-accented success embed with `text` as its description. */
export function successEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setDescription(`✅ ${truncate(text, EMBED_LIMITS.description - 2)}`)
    .setTimestamp();
}

/** A red-accented error embed with `text` as its description. */
export function errorEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xef4444)
    .setDescription(`❌ ${truncate(text, EMBED_LIMITS.description - 2)}`)
    .setTimestamp();
}

/** A brand-colored informational embed with a title and description. */
export function infoEmbed(title: string, text: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle(truncate(title, EMBED_LIMITS.title))
    .setDescription(truncate(text, EMBED_LIMITS.description))
    .setTimestamp();
}

/** A brand-colored embed rendering `lines` as a bullet list under `title`; shows a placeholder when `lines` is empty. */
export function listEmbed(title: string, lines: string[]): EmbedBuilder {
  const body = lines.length > 0 ? lines.map((line) => `• ${line}`).join('\n') : '_Nothing to show._';
  return new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle(truncate(title, EMBED_LIMITS.title))
    .setDescription(truncate(body, EMBED_LIMITS.description))
    .setTimestamp();
}
