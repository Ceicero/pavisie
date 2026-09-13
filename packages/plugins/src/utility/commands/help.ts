import {
  ActionRowBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type EmbedBuilder,
} from 'discord.js';
import { brandSiteUrl, env } from '@pavisie/core';
import {
  brandEmbed,
  buildCustomId,
  COMMAND_PREFIX_DISPLAY,
  HELP_COMMAND_DISPLAY,
  type PluginCommand,
} from '../../sdk';

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Every Pavisie command. Tip: just type +help in chat.')
  .setDMPermission(false);

const MAX_SELECT_OPTIONS = 25;

/**
 * The prefix pitch, repeated at the top of every `/help` branch. This embed is the bot's front door, so a member
 * who runs help once should come away knowing both ways to call every command — which is why it stays in the
 * description even on the degraded paths where the plugin catalog itself is unavailable.
 */
const PREFIX_LEAD =
  `**Type \`${HELP_COMMAND_DISPLAY}\` in any channel.** Every Pavisie command works two ways — as a ` +
  `\`${COMMAND_PREFIX_DISPLAY}\` message command or as a \`/\` slash command. Same command, same permissions.`;

/** Brand-styled help embed (colour, footer and timestamp from `brandEmbed`) that always leads with the prefix. */
function helpEmbed(title: string): EmbedBuilder {
  return brandEmbed().setTitle(title).setDescription(PREFIX_LEAD);
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true },
  async execute(c) {
    const host = c.ctx.services.get('host');
    if (!host) {
      await c.interaction.reply({
        embeds: [
          helpEmbed(c.t('help.title')).addFields({
            name: 'Status',
            value: 'The plugin catalog is not available right now. Try again in a moment.',
          }),
        ],
      });
      return;
    }

    const manifests = host.listManifests();
    const availability = host.getPluginAvailability();

    const options: StringSelectMenuOptionBuilder[] = [];
    for (const manifest of manifests) {
      const isAvailable = availability.get(manifest.id)?.available !== false;
      if (!isAvailable) continue;
      const enabled = manifest.alwaysEnabled ? true : await host.isPluginEnabled(c.guildId, manifest.id);
      if (!enabled) continue;
      options.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(manifest.name)
          .setValue(manifest.id)
          .setDescription(manifest.description.slice(0, 100)),
      );
      if (options.length >= MAX_SELECT_OPTIONS) break;
    }

    if (options.length === 0) {
      await c.interaction.reply({
        embeds: [helpEmbed(c.t('help.title')).addFields({ name: 'Status', value: c.t('help.noPlugins') })],
      });
      return;
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(buildCustomId('utility', 'help-select', c.interaction.user.id))
      .setPlaceholder('Choose a plugin to see its commands')
      .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    // Always link the domain actually being served (env.WEB_URL), not the brand's eventual
    // home — during the rename those are different and the brand one does not resolve yet.
    const siteUrl = brandSiteUrl(env);
    const siteHost = siteUrl.replace(/^https?:\/\//, '');

    const embed = helpEmbed(c.t('help.title'))
      .addFields({
        name: 'Try it',
        value: [
          `\`${HELP_COMMAND_DISPLAY}\` — this menu`,
          `\`${COMMAND_PREFIX_DISPLAY}mod ban @user spam\` — ban someone, with a reason`,
          `\`/mod ban\` — the exact same command, as a slash command`,
        ].join('\n'),
      })
      .addFields({
        name: 'Getting started',
        value:
          `${c.t('help.intro')}\n\n` +
          `[${siteHost}](${siteUrl}) · [Open the dashboard](${siteUrl}/dashboard)`,
      });

    await c.interaction.reply({ embeds: [embed], components: [row] });
  },
};
