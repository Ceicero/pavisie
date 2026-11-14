import type { ButtonInteraction } from 'discord.js';
import { errorEmbed, successEmbed, type ComponentHandler } from '../sdk';
import { lockdownIncident, restoreIncident } from './incident';
import { lockdownMessage, restoreMessage } from './outcome-text';

/** "Lock down now" on the raid alert. Any admin may press it (not only whoever the alert was for). */
const lockdownButton: ComponentHandler = {
  action: 'lockdown',
  kind: 'button',
  ownerOnly: false,
  requirement: { staffLevel: 'admin' },
  async handler(c) {
    const [incidentId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;
    await interaction.deferReply({ ephemeral: true });
    const outcome = await lockdownIncident(c.ctx, interaction.guild, incidentId ?? '', interaction.user.id);
    const msg = lockdownMessage(outcome, c.t);
    await interaction.editReply({ embeds: [msg.ok ? successEmbed(msg.text) : errorEmbed(msg.text)] });
  },
};

/** "Restore permissions": puts back exactly what the lockdown changed. */
const restoreButton: ComponentHandler = {
  action: 'restore',
  kind: 'button',
  ownerOnly: false,
  requirement: { staffLevel: 'admin' },
  async handler(c) {
    const [incidentId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;
    await interaction.deferReply({ ephemeral: true });
    const outcome = await restoreIncident(c.ctx, interaction.guild, incidentId ?? '', interaction.user.id);
    const msg = restoreMessage(outcome, c.t);
    await interaction.editReply({ embeds: [msg.ok ? successEmbed(msg.text) : errorEmbed(msg.text)] });
  },
};

export const raidModeComponents: ComponentHandler[] = [lockdownButton, restoreButton];
