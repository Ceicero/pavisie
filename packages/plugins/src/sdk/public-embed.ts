import type { EmbedBuilder } from 'discord.js';
import { BRAND, EMBED_LIMITS, brandIconUrl, env, truncate } from '@pavisie/core';
import type { PluginContext } from './types';

/** The attribution shown on public embeds. */
export const POWERED_BY_TEXT = `Powered by ${BRAND.name}`;

/** Key of the per-guild switch in the `admin` plugin's config (`admin.poweredByFooter`; on by default). */
export const POWERED_BY_CONFIG_KEY = 'poweredByFooter';

const SEPARATOR = ' · ';

/**
 * Adds the "Powered by Pavisie" attribution to the footer of a PUBLIC embed (one the bot posts into a channel for
 * everyone: go-live alerts, giveaways, polls, starboard posts). Returns the same builder.
 *
 * It never clobbers a footer that is already there:
 * - no footer: becomes the attribution, with the brand icon;
 * - the plain brand footer (`brandEmbed()`'s "Pavisie"): becomes the attribution, since it says the same thing;
 * - any other footer text (e.g. "Twitch"): kept, with the attribution appended after a separator ("Twitch · Powered
 *   by Pavisie"); the existing text and its icon survive, and if the two together would not fit in Discord's
 *   2048 character limit it is the existing text that is shortened, never the attribution;
 * - already carrying the attribution: left alone, so applying it twice is harmless.
 *
 * With `enabled` false the embed is returned untouched.
 */
export function withPoweredByFooter(embed: EmbedBuilder, enabled = true): EmbedBuilder {
  if (!enabled) return embed;

  const existing = embed.data.footer;
  const text = existing?.text?.trim() ?? '';

  if (text.includes(POWERED_BY_TEXT)) return embed;

  if (text === '' || text === BRAND.name) {
    return embed.setFooter({
      text: POWERED_BY_TEXT,
      iconURL: existing?.icon_url ?? brandIconUrl(env),
    });
  }

  const room = EMBED_LIMITS.footer - SEPARATOR.length - POWERED_BY_TEXT.length;
  return embed.setFooter({
    text: `${truncate(text, room)}${SEPARATOR}${POWERED_BY_TEXT}`,
    ...(existing?.icon_url ? { iconURL: existing.icon_url } : {}),
  });
}

/**
 * Whether a guild wants the attribution. On unless an admin turned `admin.poweredByFooter` off (dashboard: Settings,
 * or `/setup footer`). Any failure to read the setting (host service not registered, config store hiccup) counts as
 * "on" and is swallowed: a footer must never be the reason a message does not get posted.
 */
export async function isPoweredByFooterEnabled(
  ctx: Pick<PluginContext, 'services'>,
  guildId: string,
): Promise<boolean> {
  const host = ctx.services.get('host');
  if (!host) return true;
  try {
    const config = await host.getPluginConfig<Record<string, unknown>>(guildId, 'admin');
    return config[POWERED_BY_CONFIG_KEY] !== false;
  } catch {
    return true;
  }
}

/**
 * The one call a public poster makes: applies the guild's attribution setting to `embed`.
 * `await publicEmbed(ctx, guildId, buildGiveawayEmbed(...))`
 */
export async function publicEmbed(
  ctx: Pick<PluginContext, 'services'>,
  guildId: string,
  embed: EmbedBuilder,
): Promise<EmbedBuilder> {
  return withPoweredByFooter(embed, await isPoweredByFooterEnabled(ctx, guildId));
}
