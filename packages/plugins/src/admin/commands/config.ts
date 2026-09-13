import { PermissionFlagsBits, SlashCommandBuilder, type EmbedBuilder } from 'discord.js';
import { ValidationError } from '@pavisie/core';
import {
  assertStaffLevel,
  errorEmbed,
  listEmbed,
  paginatedReply,
  successEmbed,
  DEFAULT_GUILD_CONFIG,
  type PluginCommand,
} from '../../sdk';
import { allConfigKeys, findConfigKey, parseConfigValue, pluginConfigKeys } from '../config-keys';

const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('View or change server configuration.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub.setName('view').setDescription('View the current configuration.'))
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Set a configuration key.')
      .addStringOption((opt) =>
        opt
          .setName('key')
          .setDescription('Config key, e.g. guild.locale')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt.setName('value').setDescription('New value ("none" clears a nullable field)').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reset')
      .setDescription('Reset a configuration key to its default.')
      .addStringOption((opt) =>
        opt.setName('key').setDescription('Config key to reset').setRequired(true).setAutocomplete(true),
      ),
  );

function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined) return '_Not set_';
  if (Array.isArray(value)) return value.length > 0 ? value.map(String).join(', ') : '_None_';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return String(value);
}

function formatRoles(roleIds: string[]): string {
  return roleIds.length > 0 ? roleIds.map((id) => `<@&${id}>`).join(', ') : '_None_';
}

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'admin', guildOnly: true },
  async execute(c) {
    assertStaffLevel(c.staffLevel, 'admin', c.t);
    const sub = c.interaction.options.getSubcommand(true);
    const host = c.ctx.services.require('host');

    if (sub === 'view') {
      const guildConfig = await host.getGuildConfig(c.guildId);
      const manifests = host.listManifests();

      const pages: EmbedBuilder[] = [
        listEmbed(c.t('config.guildTitle'), [
          `Locale: ${guildConfig.locale}`,
          `Timezone: ${guildConfig.timezone}`,
          `Fast actions (skip confirmations): ${guildConfig.fastActions ? 'On' : 'Off'}`,
          `Admin roles: ${formatRoles(guildConfig.adminRoleIds)}`,
          `Moderator roles: ${formatRoles(guildConfig.modRoleIds)}`,
          `Helper roles: ${formatRoles(guildConfig.helperRoleIds)}`,
          `Mod-log channel: ${guildConfig.modLogChannelId ? `<#${guildConfig.modLogChannelId}>` : '_Not set_'}`,
          `Staff channel: ${guildConfig.staffChannelId ? `<#${guildConfig.staffChannelId}>` : '_Not set_'}`,
          `Appeals channel: ${guildConfig.appealsChannelId ? `<#${guildConfig.appealsChannelId}>` : '_Not set_'}`,
          `Data collection: ${guildConfig.dataCollectionEnabled ? 'On' : 'Off'}`,
          `Log message content: ${guildConfig.logMessageContent ? 'On' : 'Off'}`,
          `DM on moderation: ${guildConfig.dmOnModeration ? 'On' : 'Off'}`,
        ]),
      ];

      for (const manifest of manifests) {
        const keys = pluginConfigKeys(manifest);
        if (keys.length === 0) continue;
        const enabled = await host.isPluginEnabled(c.guildId, manifest.id);
        if (!enabled) continue;
        const config = await host.getPluginConfig<Record<string, unknown>>(c.guildId, manifest.id);
        const lines = keys.map(
          (descriptor) => `${descriptor.field}: ${formatConfigValue(config[descriptor.field])}`,
        );
        pages.push(listEmbed(c.t('config.pluginTitle', { plugin: manifest.name }), lines));
      }

      await paginatedReply({
        interaction: c.interaction,
        pages,
        ownerId: c.interaction.user.id,
        pluginId: 'admin',
      });
      return;
    }

    const key = c.interaction.options.getString('key', true);
    const manifests = host.listManifests();
    const descriptor = findConfigKey(manifests, key);
    if (!descriptor) {
      await c.interaction.reply({
        embeds: [errorEmbed(c.t('config.unknownKey', { key }))],
        ephemeral: true,
      });
      return;
    }

    const actor = { id: c.interaction.user.id, source: 'bot' as const };

    if (sub === 'reset') {
      if (descriptor.scope === 'guild') {
        const defaultValue = DEFAULT_GUILD_CONFIG[descriptor.field as keyof typeof DEFAULT_GUILD_CONFIG];
        await host.updateGuildConfig(c.guildId, { [descriptor.field]: defaultValue }, actor);
      } else {
        const manifest = host.getManifest(descriptor.scope);
        const defaults = (manifest?.defaultConfig ?? {}) as Record<string, unknown>;
        await host.setPluginConfig(
          c.guildId,
          descriptor.scope,
          { [descriptor.field]: defaults[descriptor.field] },
          actor,
        );
      }
      await c.interaction.reply({
        embeds: [successEmbed(c.t('config.resetSuccess', { key: descriptor.key }))],
        ephemeral: true,
      });
      return;
    }

    // sub === 'set'
    const rawValue = c.interaction.options.getString('value', true);
    let parsedValue: unknown;
    try {
      parsedValue = parseConfigValue(descriptor, rawValue);
    } catch (err) {
      if (err instanceof ValidationError) {
        await c.interaction.reply({ embeds: [errorEmbed(err.message)], ephemeral: true });
        return;
      }
      throw err;
    }

    if (descriptor.scope === 'guild') {
      const after = await host.updateGuildConfig(c.guildId, { [descriptor.field]: parsedValue }, actor);
      const afterValue = (after as unknown as Record<string, unknown>)[descriptor.field];
      await c.interaction.reply({
        embeds: [
          successEmbed(
            c.t('config.setSuccess', { key: descriptor.key, value: formatConfigValue(afterValue) }),
          ),
        ],
        ephemeral: true,
      });
    } else {
      const after = await host.setPluginConfig<Record<string, unknown>>(
        c.guildId,
        descriptor.scope,
        { [descriptor.field]: parsedValue },
        actor,
      );
      await c.interaction.reply({
        embeds: [
          successEmbed(
            c.t('config.setSuccess', {
              key: descriptor.key,
              value: formatConfigValue(after[descriptor.field]),
            }),
          ),
        ],
        ephemeral: true,
      });
    }
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    const host = c.ctx.services.require('host');
    const keys = allConfigKeys(host.listManifests());
    const query = String(focused.value).toLowerCase();
    const matches = keys.filter((descriptor) => descriptor.key.toLowerCase().includes(query)).slice(0, 25);
    await c.interaction.respond(
      matches.map((descriptor) => ({ name: descriptor.key, value: descriptor.key })),
    );
  },
};
