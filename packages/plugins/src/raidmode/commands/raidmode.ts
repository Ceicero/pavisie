import { SlashCommandBuilder } from 'discord.js';
import { errorEmbed, infoEmbed, successEmbed, type PluginCommand } from '../../sdk';
import { incidentEmbed } from '../alert';
import { latestIncident, lockdownIncident, restoreIncident } from '../incident';
import { lockdownMessage, restoreMessage } from '../outcome-text';

const data = new SlashCommandBuilder()
  .setName('raidmode')
  .setDescription('Raid mode: see the latest raid, lock down, or restore permissions.')
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('status').setDescription('Show the latest raid incident.'))
  .addSubcommand((s) => s.setName('lockdown').setDescription('Lock down for the latest raid incident.'))
  .addSubcommand((s) =>
    s.setName('restore').setDescription('Put back exactly the permissions the last lockdown changed.'),
  );

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'admin', guildOnly: true },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand();
    const incident = await latestIncident(c.ctx, c.guildId);
    if (!incident) {
      await c.interaction.reply({
        embeds: [infoEmbed(c.t('status.title'), c.t('status.noIncident'))],
        ephemeral: true,
      });
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
