import { PermissionFlagsBits } from 'discord.js';
import type { PluginCommand } from '../../sdk';
import { buildSectionCommand, buildSectionExecute } from './welcome-goodbye-shared';

export const command: PluginCommand = {
  data: buildSectionCommand('goodbye'),
  // Matches the slash command's default_member_permissions so the prefix path can't be used by staff without
  // Manage Server (staffLevel + discordPermissions would be OR'd by evaluateRequirement, so only the permission).
  requirement: { discordPermissions: [PermissionFlagsBits.ManageGuild], guildOnly: true },
  execute: buildSectionExecute('goodbye'),
};
