import { PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { describePermission, missingPermissions } from '@pavisie/core';
import type { PluginId } from '@pavisie/types';
import { assertStaffLevel, brandEmbed, type PluginCommand } from '../../sdk';
import { describeIntentWarnings, describeRoleHierarchyWarnings } from '../format';

const data = new SlashCommandBuilder()
  .setName('permissions')
  .setDescription('Audit bot permissions and configuration health.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub.setName('audit').setDescription('Run a permissions and configuration audit.'));

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'admin', guildOnly: true },
  async execute(c) {
    assertStaffLevel(c.staffLevel, 'admin', c.t);
    const host = c.ctx.services.require('host');
    const manifests = host.listManifests();
    const guildConfig = await host.getGuildConfig(c.guildId);
    const guild = c.interaction.guild;
    const botMember = guild.members.me;

    const permissionLines: string[] = [];
    const have = botMember?.permissions.bitfield ?? 0n;
    if (!botMember) {
      permissionLines.push("❌ I couldn't read my own member/permissions in this server.");
    }
    for (const manifest of manifests) {
      if (manifest.permissions.length === 0) continue;
      const enabled = manifest.alwaysEnabled ? true : await host.isPluginEnabled(c.guildId, manifest.id);
      if (!enabled) continue;
      for (const doc of manifest.permissions) {
        const bit = PermissionsBitField.resolve(doc.permission);
        // Via the shared helper rather than a bare `have & bit`, so Administrator is honoured: it implicitly
        // grants everything, but the individual bits are absent from the bitfield, so a raw test reports
        // permissions as missing that the bot can actually exercise.
        if (missingPermissions(have, [bit]).length === 0) continue;
        const requirement = doc.optional ? 'optional' : 'required';
        permissionLines.push(
          `❌ **${manifest.name}** — missing **${describePermission(bit)}** (${requirement}) for ${doc.feature}. ${doc.fallback}`,
        );
      }
    }
    if (botMember?.permissions.has(PermissionFlagsBits.Administrator)) {
      permissionLines.push(c.t('permissions.administratorGranted'));
    }
    if (permissionLines.length === 0) permissionLines.push(c.t('permissions.noMissingPermissions'));

    // Get list of enabled plugins for intent checks
    const enabledPluginIds: PluginId[] = [];
    for (const manifest of manifests) {
      const enabled = manifest.alwaysEnabled ? true : await host.isPluginEnabled(c.guildId, manifest.id);
      if (enabled) enabledPluginIds.push(manifest.id);
    }

    // Extract role hierarchy warnings using pure function
    const staffRoleIds = [
      ...new Set([...guildConfig.adminRoleIds, ...guildConfig.modRoleIds, ...guildConfig.helperRoleIds]),
    ];
    const hierarchyWarnings = describeRoleHierarchyWarnings(guild, staffRoleIds, c.t);
    const hierarchyLines = hierarchyWarnings.length > 0 ? hierarchyWarnings : [c.t('permissions.hierarchyOk')];

    // Extract intent warnings using pure function
    const intentWarnings = describeIntentWarnings(manifests, enabledPluginIds, c.ctx.intentsEnabled, c.t);
    const intentLines = intentWarnings.length > 0 ? intentWarnings : [c.t('permissions.intentsOk')];

    const embed = brandEmbed()
      .setTitle(c.t('permissions.auditTitle'))
      .addFields(
        { name: c.t('permissions.botPermissionsField'), value: permissionLines.join('\n').slice(0, 1024) },
        { name: c.t('permissions.roleHierarchyField'), value: hierarchyLines.join('\n').slice(0, 1024) },
        { name: c.t('permissions.privilegedIntentsField'), value: intentLines.join('\n').slice(0, 1024) },
      );

    await c.interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
