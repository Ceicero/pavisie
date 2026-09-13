import type { StringSelectMenuInteraction } from 'discord.js';
import type { PluginId } from '@pavisie/types';
import { getCommandCatalog } from '../command-catalog';
import { infoEmbed, listEmbed, type ComponentContext, type ComponentHandler, COMMAND_PREFIX_DISPLAY } from '../../sdk';

const helpSelectHandler: ComponentHandler = {
  action: 'help-select',
  kind: 'select',
  ownerOnly: true,
  async handler(c: ComponentContext) {
    const interaction = c.interaction as unknown as StringSelectMenuInteraction<'cached'>;
    const pluginId = interaction.values[0] as PluginId | undefined;
    if (!pluginId) {
      await interaction.update({
        embeds: [infoEmbed('Help', 'Nothing was selected.')],
        components: interaction.message.components,
      });
      return;
    }

    const host = c.ctx.services.get('host');
    const manifest = host?.getManifest(pluginId);
    const catalog = await getCommandCatalog(c.ctx.client, c.guildId);
    const entries = catalog.byPlugin.get(pluginId) ?? [];

    const lines =
      entries.length > 0
        ? entries.map((entry) => {
            // Context menu commands (no leading slash) should show as right-click options
            if (!entry.fullName.startsWith('/')) {
              return `\`Right-click → ${entry.fullName}\` — ${entry.description}`;
            }
            // Slash commands should show both prefix and slash forms
            const slashName = entry.fullName.slice(1); // Remove the leading /
            const prefixForm = `${COMMAND_PREFIX_DISPLAY}${slashName}`;
            return `\`${prefixForm}\` · \`${entry.fullName}\` — ${entry.description}`;
          })
        : ['_No commands are registered for this plugin yet._'];

    if (catalog.degraded) {
      lines.push(
        '',
        '_(Live command details are temporarily unavailable — showing what is known from the plugin registry.)_',
      );
    }

    const title = manifest ? `${manifest.name} commands` : `${pluginId} commands`;
    await interaction.update({
      embeds: [listEmbed(title, lines)],
      components: interaction.message.components,
    });
  },
};

export const helpComponents: ComponentHandler[] = [helpSelectHandler];
