import { PermissionFlagsBits, SlashCommandBuilder, type EmbedBuilder } from 'discord.js';
import type { PluginId } from '@pavisie/types';
import {
  assertStaffLevel,
  errorEmbed,
  infoEmbed,
  listEmbed,
  paginatedReply,
  successEmbed,
  type PluginCommand,
  type PluginManifest,
} from '../../sdk';

const data = new SlashCommandBuilder()
  .setName('plugin')
  .setDescription('Manage plugins.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('enable')
      .setDescription('Enable a plugin.')
      .addStringOption((opt) =>
        opt.setName('plugin').setDescription('Plugin id').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('disable')
      .setDescription('Disable a plugin.')
      .addStringOption((opt) =>
        opt.setName('plugin').setDescription('Plugin id').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription("Show a plugin's status, or every plugin's if none is given.")
      .addStringOption((opt) =>
        opt.setName('plugin').setDescription('Plugin id').setRequired(false).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List every plugin, grouped by category.'));

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function availabilityLine(
  availability: { available: boolean; degraded?: boolean; reason?: string } | undefined,
): string {
  if (!availability || availability.available === false) {
    return `❌ Unavailable${availability?.reason ? ` — ${availability.reason}` : ''}`;
  }
  if (availability.degraded) {
    return `⚠️ Degraded${availability.reason ? ` — ${availability.reason}` : ''}`;
  }
  return '✅ Available';
}

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'admin', guildOnly: true },
  async execute(c) {
    assertStaffLevel(c.staffLevel, 'admin', c.t);
    const sub = c.interaction.options.getSubcommand(true);
    const host = c.ctx.services.require('host');
    const actor = { id: c.interaction.user.id, source: 'bot' as const };

    if (sub === 'list') {
      const manifests = host.listManifests();
      const byCategory = new Map<string, PluginManifest[]>();
      for (const manifest of manifests) {
        const list = byCategory.get(manifest.category) ?? [];
        list.push(manifest);
        byCategory.set(manifest.category, list);
      }

      const lines: string[] = [];
      for (const [category, list] of byCategory) {
        lines.push(`**${capitalize(category)}**`);
        for (const manifest of list) {
          const enabled = manifest.alwaysEnabled ? true : await host.isPluginEnabled(c.guildId, manifest.id);
          lines.push(
            `${enabled ? '🟢' : '⚪'} ${manifest.name} (\`${manifest.id}\`)${manifest.alwaysEnabled ? ' — always enabled' : ''}`,
          );
        }
      }

      await c.interaction.reply({ embeds: [listEmbed(c.t('plugin.listTitle'), lines)], ephemeral: true });
      return;
    }

    if (sub === 'status') {
      const pluginId = c.interaction.options.getString('plugin');
      const manifests = host.listManifests();
      const targets = pluginId ? manifests.filter((manifest) => manifest.id === pluginId) : manifests;

      if (pluginId && targets.length === 0) {
        await c.interaction.reply({
          embeds: [errorEmbed(c.t('plugin.unknownPlugin', { plugin: pluginId }))],
          ephemeral: true,
        });
        return;
      }

      const availability = host.getPluginAvailability();
      const pages: EmbedBuilder[] = [];
      for (const manifest of targets) {
        const enabled = manifest.alwaysEnabled ? true : await host.isPluginEnabled(c.guildId, manifest.id);
        const health = await host.getPluginHealth(manifest.id);
        const lines = [
          `Enabled: ${enabled ? 'Yes' : 'No'}${manifest.alwaysEnabled ? ' (always enabled)' : ''}`,
          `Availability: ${availabilityLine(availability.get(manifest.id))}`,
          `Health: ${health ? `${health.status}${health.details ? ` — ${health.details}` : ''}` : '_No health check reported._'}`,
          `Required permissions: ${manifest.permissions.length > 0 ? manifest.permissions.map((doc) => doc.feature).join(', ') : '_None_'}`,
          `Privileged intents: ${manifest.privilegedIntents && manifest.privilegedIntents.length > 0 ? manifest.privilegedIntents.join(', ') : '_None_'}`,
        ];
        pages.push(infoEmbed(`${manifest.name} (${manifest.id})`, lines.join('\n')));
      }

      if (pages.length <= 1) {
        await c.interaction.reply({ embeds: pages, ephemeral: true });
      } else {
        await paginatedReply({
          interaction: c.interaction,
          pages,
          ownerId: c.interaction.user.id,
          pluginId: 'admin',
        });
      }
      return;
    }

    // sub === 'enable' | 'disable'
    const pluginId = c.interaction.options.getString('plugin', true) as PluginId;
    const manifest = host.getManifest(pluginId);
    if (!manifest) {
      await c.interaction.reply({
        embeds: [errorEmbed(c.t('plugin.unknownPlugin', { plugin: pluginId }))],
        ephemeral: true,
      });
      return;
    }
    if (manifest.alwaysEnabled) {
      await c.interaction.reply({
        embeds: [errorEmbed(c.t('plugin.alwaysEnabled', { plugin: manifest.name }))],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'enable') {
      await host.enable(c.guildId, pluginId, actor);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('plugin.enabledMessage', { plugin: manifest.name }))],
        ephemeral: true,
      });
    } else {
      await host.disable(c.guildId, pluginId, actor);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('plugin.disabledMessage', { plugin: manifest.name }))],
        ephemeral: true,
      });
    }
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    const sub = c.interaction.options.getSubcommand(true);
    const host = c.ctx.services.require('host');
    const query = String(focused.value).toLowerCase();

    const manifests = host
      .listManifests()
      .filter((manifest) => (sub === 'enable' || sub === 'disable' ? !manifest.alwaysEnabled : true))
      .filter(
        (manifest) =>
          manifest.id.toLowerCase().includes(query) || manifest.name.toLowerCase().includes(query),
      )
      .slice(0, 25);

    await c.interaction.respond(
      manifests.map((manifest) => ({ name: `${manifest.name} (${manifest.id})`, value: manifest.id })),
    );
  },
};
