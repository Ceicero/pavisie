// Button-driven ticket creation from a posted panel: `tickets:open:<panelId>` opens directly, or — when the
// panel has an intake form — shows a modal (`tickets:open-modal:<pendingId>`) first.
import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { ValidationError } from '@pavisie/core';
import {
  PendingStore,
  buildCustomId,
  errorEmbed,
  successEmbed,
  type ComponentContext,
  type ComponentHandler,
} from '../../sdk';
import { validateIntakeAnswers } from '../intake';
import type { TicketIntakeField, TicketsConfig } from '../manifest';
import { openTicket } from '../service';

interface OpenPendingPayload {
  panelId: string;
}

async function replyEphemeralError(c: ComponentContext, message: string): Promise<void> {
  const interaction = c.interaction as ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>;
  await interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
}

async function assertUnderOpenLimit(c: ComponentContext, config: TicketsConfig): Promise<boolean> {
  const openCount = await c.ctx.prisma.ticket.count({
    where: { guildId: c.guildId, openerId: c.interaction.user.id, status: 'OPEN' },
  });
  if (openCount < config.maxOpenPerUser) return true;
  await replyEphemeralError(
    c,
    config.maxOpenPerUser === 1
      ? 'You already have an open ticket. Close it before opening another one.'
      : `You already have ${openCount} open tickets (limit ${config.maxOpenPerUser}). Close one before opening another.`,
  );
  return false;
}

const openHandler: ComponentHandler = {
  action: 'open',
  kind: 'button',
  ownerOnly: false,
  async handler(c) {
    const [panelId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;

    const panel = await c.ctx.prisma.ticketPanel.findFirst({
      where: { id: panelId, guildId: c.guildId, deletedAt: null },
    });
    if (!panel) {
      await replyEphemeralError(c, 'This ticket panel no longer exists.');
      return;
    }

    const config = await c.ctx.getConfig<TicketsConfig>(c.guildId);
    if (!(await assertUnderOpenLimit(c, config))) return;

    const intakeForm = (panel.intakeForm as unknown as TicketIntakeField[] | null) ?? [];
    if (intakeForm.length > 0) {
      const pendingStore = new PendingStore(c.ctx.redis);
      const pendingId = await pendingStore.put({ panelId: panel.id } satisfies OpenPendingPayload, 300);

      const modal = new ModalBuilder()
        .setCustomId(buildCustomId('tickets', 'open-modal', pendingId))
        .setTitle(panel.title.slice(0, 45) || 'Open a ticket');
      for (const [index, field] of intakeForm.slice(0, 5).entries()) {
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(`intake_${index}`)
              .setLabel(field.label.slice(0, 45))
              .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
              .setRequired(field.required),
          ),
        );
      }
      await interaction.showModal(modal);
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const ticket = await openTicket(c.ctx, {
      guildId: c.guildId,
      openerId: interaction.user.id,
      subject: null,
      intake: null,
      panel,
    });
    const location = ticket.channelId
      ? `<#${ticket.channelId}>`
      : ticket.threadId
        ? `<#${ticket.threadId}>`
        : 'a new location';
    await interaction.editReply({
      embeds: [successEmbed(`Opened ticket #${ticket.number} in ${location}.`)],
    });
  },
};

const openModalHandler: ComponentHandler = {
  action: 'open-modal',
  kind: 'modal',
  ownerOnly: false,
  async handler(c) {
    const [pendingId] = c.args;
    const interaction = c.interaction as ModalSubmitInteraction<'cached'>;

    const pendingStore = new PendingStore(c.ctx.redis);
    const pending = await pendingStore.take<OpenPendingPayload>(pendingId);
    if (!pending) {
      await replyEphemeralError(c, 'This form expired. Click the ticket button again.');
      return;
    }

    const panel = await c.ctx.prisma.ticketPanel.findFirst({
      where: { id: pending.panelId, guildId: c.guildId, deletedAt: null },
    });
    if (!panel) {
      await replyEphemeralError(c, 'This ticket panel no longer exists.');
      return;
    }

    const config = await c.ctx.getConfig<TicketsConfig>(c.guildId);
    if (!(await assertUnderOpenLimit(c, config))) return;

    const intakeForm = (panel.intakeForm as unknown as TicketIntakeField[] | null) ?? [];
    const answers: Record<string, string> = {};
    intakeForm.slice(0, 5).forEach((field, index) => {
      const value = interaction.fields.getTextInputValue(`intake_${index}`);
      if (value) answers[field.label] = value;
    });

    try {
      validateIntakeAnswers(intakeForm, answers);
    } catch (err) {
      if (err instanceof ValidationError) {
        await replyEphemeralError(c, err.message);
        return;
      }
      throw err;
    }

    await interaction.deferReply({ ephemeral: true });
    const ticket = await openTicket(c.ctx, {
      guildId: c.guildId,
      openerId: interaction.user.id,
      subject: null,
      intake: answers,
      panel,
    });
    const location = ticket.channelId
      ? `<#${ticket.channelId}>`
      : ticket.threadId
        ? `<#${ticket.threadId}>`
        : 'a new location';
    await interaction.editReply({
      embeds: [successEmbed(`Opened ticket #${ticket.number} in ${location}.`)],
    });
  },
};

export const panelComponents: ComponentHandler[] = [openHandler, openModalHandler];
