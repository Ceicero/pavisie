// Buttons posted on a ticket's opening embed (Close/Claim/Add user) and closing message (Reopen).
import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { PermissionError, ValidationError, hasStaffLevel } from '@pavisie/core';
import {
  buildCustomId,
  errorEmbed,
  infoEmbed,
  registerConfirmHandlers,
  requestConfirmation,
  successEmbed,
  type ComponentHandler,
  type ConfirmationInteraction,
} from '../../sdk';
import { addTicketParticipant, assignTicket, closeTicketCore, reopenTicketCore } from '../service';

const SNOWFLAKE_PATTERN = /(\d{17,20})/;

function extractUserId(input: string): string | null {
  const match = SNOWFLAKE_PATTERN.exec(input);
  return match ? match[1] : null;
}

interface CloseTicketPayload {
  ticketId: string;
  reason?: string;
}

const closeHandler: ComponentHandler = {
  action: 'close',
  kind: 'button',
  ownerOnly: false,
  async handler(c) {
    const [ticketId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;

    const ticket = await c.ctx.prisma.ticket.findFirst({ where: { id: ticketId, guildId: c.guildId } });
    if (!ticket) {
      await interaction.reply({ embeds: [errorEmbed('This ticket no longer exists.')], ephemeral: true });
      return;
    }
    if (ticket.status !== 'OPEN') {
      await interaction.reply({ embeds: [errorEmbed('This ticket is already closed.')], ephemeral: true });
      return;
    }
    if (ticket.openerId !== interaction.user.id && !hasStaffLevel(c.staffLevel, 'helper')) {
      throw new PermissionError('Only the ticket opener or support staff can close this ticket.');
    }

    const host = c.ctx.services.get('host');
    const fastActions = host ? (await host.getGuildConfig(c.guildId)).fastActions : false;

    // Button interactions structurally support the same `.reply()`/`.fetchReply()` surface `requestConfirmation`
    // needs; only its declared type is narrower (same interaction-subtype friction as sdk/confirm.ts itself).
    const result = await requestConfirmation<CloseTicketPayload>({
      interaction: interaction as unknown as ConfirmationInteraction,
      ctx: c.ctx,
      pluginId: 'tickets',
      action: 'close-ticket',
      ownerId: interaction.user.id,
      embed: infoEmbed('Close this ticket?', 'You will be asked to confirm.'),
      payload: { ticketId: ticket.id },
      fastActions,
    });

    if (result.confirmed) {
      await interaction.reply({ embeds: [successEmbed('Closing this ticket…')], ephemeral: true });
      await closeTicketCore(c.ctx, {
        guildId: c.guildId,
        ticketId: ticket.id,
        closedBy: interaction.user.id,
        source: 'bot',
      });
    }
  },
};

const [confirmCloseHandler, cancelCloseHandler] = registerConfirmHandlers<CloseTicketPayload>(
  'close-ticket',
  async (c, payload) => {
    await closeTicketCore(c.ctx, {
      guildId: c.guildId,
      ticketId: payload.ticketId,
      closedBy: c.interaction.user.id,
      reason: payload.reason,
      source: 'bot',
    });
  },
);

const claimHandler: ComponentHandler = {
  action: 'claim',
  kind: 'button',
  ownerOnly: false,
  requirement: { staffLevel: 'helper' },
  async handler(c) {
    const [ticketId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;

    const ticket = await c.ctx.prisma.ticket.findFirst({ where: { id: ticketId, guildId: c.guildId } });
    if (!ticket) {
      await interaction.reply({ embeds: [errorEmbed('This ticket no longer exists.')], ephemeral: true });
      return;
    }
    if (ticket.status !== 'OPEN') {
      await interaction.reply({ embeds: [errorEmbed('This ticket is already closed.')], ephemeral: true });
      return;
    }

    await assignTicket(c.ctx, c.guildId, ticket.id, interaction.user.id, interaction.user.id);
    await interaction.reply({ embeds: [successEmbed(`<@${interaction.user.id}> claimed this ticket.`)] });
  },
};

const addUserHandler: ComponentHandler = {
  action: 'add-user',
  kind: 'button',
  ownerOnly: false,
  requirement: { staffLevel: 'helper' },
  async handler(c) {
    const [ticketId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;

    const modal = new ModalBuilder()
      .setCustomId(buildCustomId('tickets', 'add-user-modal', interaction.user.id, ticketId))
      .setTitle('Add a user to this ticket')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('user')
            .setLabel('User ID or @mention')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(40),
        ),
      );
    await interaction.showModal(modal);
  },
};

const addUserModalHandler: ComponentHandler = {
  action: 'add-user-modal',
  kind: 'modal',
  ownerOnly: true,
  requirement: { staffLevel: 'helper' },
  async handler(c) {
    const [, ticketId] = c.args;
    const interaction = c.interaction as ModalSubmitInteraction<'cached'>;
    const raw = interaction.fields.getTextInputValue('user').trim();
    const userId = extractUserId(raw);
    if (!userId) {
      await interaction.reply({
        embeds: [errorEmbed('Could not find a user id in that input. Paste a user ID or @mention.')],
        ephemeral: true,
      });
      return;
    }

    try {
      await addTicketParticipant(c.ctx, c.guildId, ticketId, userId, interaction.user.id);
    } catch (err) {
      if (err instanceof ValidationError) {
        await interaction.reply({ embeds: [errorEmbed(err.message)], ephemeral: true });
        return;
      }
      throw err;
    }

    await interaction.reply({
      embeds: [successEmbed(`Added <@${userId}> to this ticket.`)],
      ephemeral: true,
    });
  },
};

const reopenButtonHandler: ComponentHandler = {
  action: 'reopen-btn',
  kind: 'button',
  ownerOnly: false,
  async handler(c) {
    const [ticketId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;

    const ticket = await c.ctx.prisma.ticket.findFirst({ where: { id: ticketId, guildId: c.guildId } });
    if (!ticket) {
      await interaction.reply({ embeds: [errorEmbed('This ticket no longer exists.')], ephemeral: true });
      return;
    }
    if (ticket.openerId !== interaction.user.id && !hasStaffLevel(c.staffLevel, 'helper')) {
      await interaction.reply({
        embeds: [errorEmbed('Only the ticket opener or support staff can reopen this ticket.')],
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const updated = await reopenTicketCore(c.ctx, {
        guildId: c.guildId,
        ticketId: ticket.id,
        reopenedBy: interaction.user.id,
      });
      const location = updated.channelId
        ? `<#${updated.channelId}>`
        : updated.threadId
          ? `<#${updated.threadId}>`
          : 'its original location';
      await interaction.editReply({
        embeds: [successEmbed(`Reopened ticket #${updated.number} in ${location}.`)],
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        await interaction.editReply({ embeds: [errorEmbed(err.message)] });
        return;
      }
      throw err;
    }
  },
};

export const ticketActionComponents: ComponentHandler[] = [
  closeHandler,
  confirmCloseHandler,
  cancelCloseHandler,
  claimHandler,
  addUserHandler,
  addUserModalHandler,
  reopenButtonHandler,
];
