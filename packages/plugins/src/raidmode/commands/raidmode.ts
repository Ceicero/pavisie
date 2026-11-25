import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { errorEmbed, infoEmbed, successEmbed, type PluginCommand } from '../../sdk';
import { incidentEmbed } from '../alert';
import { latestIncident, latestLockedIncident, lockdownIncident, restoreIncident } from '../incident';
import { lockdownMessage, restoreMessage } from '../outcome-text';

const data = new SlashCommandBuilder()
  .setName('raidmode')
  .setDescription('Raid mode: see the latest raid, lock down, or restore permissions.')
  .setDMPermission(false)
  // Hidden from members who can't manage the server. The runtime staffLevel check below is the real gate.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('status').setDescription('Show the latest raid incident.'))
  .addSubcommand((s) => s.setName('lockdown').setDescription('Lock down for the latest raid incident.'))
  .addSubcommand((s) =>
    s.setName('restore').setDescription('Put back exactly the permissions a lockdown changed.'),
  );

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'admin', guildOnly: true },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand();
    // Restore targets the newest incident that still has something locked, not simply the newest incident:
    // a new raid can start while an older lockdown is still on.
    const incident =
      sub === 'restore'
        ? await latestLockedIncident(c.ctx, c.guildId)
        : await latestIncident(c.ctx, c.guildId);
    if (!incident) {
      const text = sub === 'restore' ? c.t('restore.nothingLocked') : c.t('status.noIncident');
      await c.interaction.reply({ embeds: [infoEmbed(c.t('status.title'), text)], ephemeral: true });
      return;
    }
    if (sub === 'status') {
      await c.interaction.reply({ embeds: [incidentEmbed(incident)], ephemeral: true });
      return;
    }
    await c.interaction.deferReply({ ephemeral: true });
    const guild = c.interaction.guild;
    const msg =
      sub === 'lockdown'
        ? lockdownMessage(await lockdownIncident(c.ctx, guild, incident.id, c.interaction.user.id), c.t)
        : restoreMessage(await restoreIncident(c.ctx, guild, incident.id, c.interaction.user.id), c.t);
    await c.interaction.editReply({ embeds: [msg.ok ? successEmbed(msg.text) : errorEmbed(msg.text)] });
  },
};
