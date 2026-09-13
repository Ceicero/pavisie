// Modal submit handler for `/ticket panel create` (see ../commands/ticket.ts's `handlePanelCreate`, which stashes
// the slash-command options in Redis via PendingStore and shows this modal for the title/description/button text).
import type { ModalSubmitInteraction } from 'discord.js';
import { AuditAction, NotFoundError } from '@pavisie/core';
import type { Prisma, TicketMode } from '@pavisie/database';
import { PendingStore, errorEmbed, successEmbed, type ComponentHandler } from '../../sdk';
import type { TicketsConfig } from '../manifest';
import { postPanelMessage } from '../service';

interface PanelCreatePendingPayload {
  channelId: string;
  categoryId: string | null;
  supportRoleIds: string[];
  mode: TicketMode;
  slaMinutes: number | null;
  intake: boolean;
}

const panelCreateModalHandler: ComponentHandler = {
  action: 'panel-create-modal',
  kind: 'modal',
  ownerOnly: true,
  async handler(c) {
    const [, pendingId] = c.args;
    const interaction = c.interaction as ModalSubmitInteraction<'cached'>;

    const pendingStore = new PendingStore(c.ctx.redis);
    const pending = await pendingStore.take<PanelCreatePendingPayload>(pendingId);
    if (!pending) {
      await interaction.reply({
        embeds: [errorEmbed('This form expired. Run `/ticket panel create` again.')],
        ephemeral: true,
      });
      return;
    }

    const title = interaction.fields.getTextInputValue('title').trim();
    const description = interaction.fields.getTextInputValue('description').trim();
    const buttonLabel = interaction.fields.getTextInputValue('buttonLabel').trim() || 'Open a ticket';

    const config = pending.intake ? await c.ctx.getConfig<TicketsConfig>(c.guildId) : null;

    const panel = await c.ctx.prisma.ticketPanel.create({
      data: {
        guildId: c.guildId,
        channelId: pending.channelId,
        title,
        description,
        buttonLabel,
        categoryId: pending.categoryId,
        supportRoleIds: pending.supportRoleIds,
        mode: pending.mode,
        slaMinutes: pending.slaMinutes,
        intakeForm:
          config && config.intakeForm.length > 0
            ? (config.intakeForm as unknown as Prisma.InputJsonValue)
            : undefined,
      },
    });

    await interaction.deferReply({ ephemeral: true });

    try {
      await postPanelMessage(c.ctx, panel);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `Panel "${panel.title}" was created, but I could not post it: ${err instanceof Error ? err.message : 'unknown error'}. Try \`/ticket panel post\` from the dashboard.`,
          ),
        ],
      });
      return;
    }

    await c.ctx.audit({
      guildId: c.guildId,
      actorId: interaction.user.id,
      actorType: 'user',
      action: AuditAction.TicketPanelCreate,
      targetType: 'ticket_panel',
      targetId: panel.id,
      after: { title: panel.title, channelId: panel.channelId, mode: panel.mode },
      source: 'bot',
    });

    await interaction.editReply({
      embeds: [
        successEmbed(`Created and posted the "${panel.title}" ticket panel in <#${panel.channelId}>.`),
      ],
    });
  },
};

export const panelCreateComponents: ComponentHandler[] = [panelCreateModalHandler];
