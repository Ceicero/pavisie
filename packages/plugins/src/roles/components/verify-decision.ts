import { ActionRowBuilder, ButtonBuilder, type ButtonInteraction } from 'discord.js';
import { AppError } from '@entrophy/core';
import { errorEmbed, successEmbed, type ComponentHandler } from '../../sdk';
import { canDecideVerification } from '../engine';

// discord.js's read-only `Message.components` has no simple public type alias for `ActionRowBuilder.from()`'s
// accepted input (same friction as sdk/confirm.ts's `disableAllButtons`, which uses the identical pattern).
function disableAllButtons(
  components: ButtonInteraction<'cached'>['message']['components'],
): ActionRowBuilder<ButtonBuilder>[] {
  return components.map((row) => {
    const builder = ActionRowBuilder.from<ButtonBuilder>(row as any); // eslint-disable-line @typescript-eslint/no-explicit-any -- see above
    for (const component of builder.components) {
      if (component instanceof ButtonBuilder) {
        component.setDisabled(true);
      }
    }
    return builder;
  });
}

function buildDecisionHandler(approve: boolean): ComponentHandler {
  return {
    action: approve ? 'verify-approve' : 'verify-deny',
    kind: 'button',
    ownerOnly: false,
    requirement: { staffLevel: 'moderator' },
    async handler(c) {
      const [requestId] = c.args;
      const interaction = c.interaction as ButtonInteraction<'cached'>;

      const request = await c.ctx.prisma.verificationRequest.findFirst({
        where: { id: requestId, guildId: c.guildId },
      });
      if (!request || !canDecideVerification(request.status)) {
        await interaction.reply({
          embeds: [errorEmbed('This request was already decided by another moderator.')],
          ephemeral: true,
        });
        return;
      }

      const roles = c.ctx.services.get('roles');
      if (!roles) {
        await interaction.reply({
          embeds: [errorEmbed('The roles service is not available right now.')],
          ephemeral: true,
        });
        return;
      }

      try {
        await roles.verificationDecision({
          guildId: c.guildId,
          requestId: request.id,
          approve,
          reviewerId: interaction.user.id,
        });
      } catch (err) {
        // The service decides atomically, so the losing side of two near-simultaneous clicks lands here. Any
        // other failure is a real fault: rethrow it so the router logs it rather than reporting a tidy message.
        if (!(err instanceof AppError) || err.code !== 'already_decided') throw err;
        await interaction.reply({
          embeds: [errorEmbed('This request was already decided by another moderator.')],
          ephemeral: true,
        });
        return;
      }

      const disabled = disableAllButtons(interaction.message.components);
      await interaction.update({
        content: `${approve ? 'Approved' : 'Denied'} by <@${interaction.user.id}>.`,
        components: disabled,
      });
      await interaction.followUp({
        embeds: [successEmbed(`Marked ${approve ? 'approved' : 'denied'}.`)],
        ephemeral: true,
      });
    },
  };
}

export const verifyApproveHandler = buildDecisionHandler(true);
export const verifyDenyHandler = buildDecisionHandler(false);
