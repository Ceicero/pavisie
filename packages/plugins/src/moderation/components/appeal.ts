import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import { NotFoundError, PermissionError } from '@pavisie/core';
import { infoEmbed, successEmbed, type ComponentHandler } from '../../sdk';
import { moderationService } from '../commands/shared';

class AppealAlreadyDecidedError extends PermissionError {
  constructor() {
    super('This appeal has already been decided.');
  }
}

function assertPending(status: string): void {
  if (status !== 'PENDING') {
    throw new AppealAlreadyDecidedError();
  }
}

const appealAcceptHandler: ComponentHandler = {
  action: 'appeal-accept',
  kind: 'button',
  ownerOnly: false,
  requirement: { staffLevel: 'moderator' },
  async handler(c) {
    const [appealId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;

    const existing = await c.ctx.prisma.moderationAppeal.findUnique({ where: { id: appealId } });
    if (!existing || existing.guildId !== c.guildId) throw new NotFoundError('Appeal not found.');
    assertPending(existing.status);

    const service = moderationService(c.ctx);
    await service.decideAppeal({
      guildId: c.guildId,
      appealId,
      accept: true,
      reviewerId: c.interaction.user.id,
    });
    await interaction.update({
      content: `✅ Appeal accepted by <@${c.interaction.user.id}>.`,
      embeds: [],
      components: [],
    });
  },
};

const appealDenyHandler: ComponentHandler = {
  action: 'appeal-deny',
  kind: 'button',
  ownerOnly: false,
  requirement: { staffLevel: 'moderator' },
  async handler(c) {
    const [appealId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;

    const existing = await c.ctx.prisma.moderationAppeal.findUnique({ where: { id: appealId } });
    if (!existing || existing.guildId !== c.guildId) throw new NotFoundError('Appeal not found.');
    assertPending(existing.status);

    const service = moderationService(c.ctx);
    await service.decideAppeal({
      guildId: c.guildId,
      appealId,
      accept: false,
      reviewerId: c.interaction.user.id,
    });
    await interaction.update({
      content: `❌ Appeal denied by <@${c.interaction.user.id}>.`,
      embeds: [],
      components: [],
    });
  },
};

const appealUnbanHandler: ComponentHandler = {
  action: 'appeal-unban',
  kind: 'button',
  ownerOnly: false,
  requirement: { staffLevel: 'moderator' },
  async handler(c) {
    const [appealId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;
    const appeal = await c.ctx.prisma.moderationAppeal.findUnique({ where: { id: appealId } });
    if (!appeal || appeal.guildId !== c.guildId) throw new NotFoundError('Appeal not found.');

    const service = moderationService(c.ctx);
    await service.unban({
      guildId: c.guildId,
      targetId: appeal.userId,
      moderatorId: c.interaction.user.id,
      reason: `Appeal ${appeal.id} accepted`,
      source: 'BOT',
    });
    await interaction.update({
      content: `${interaction.message.content}\n\n✅ Unbanned by <@${c.interaction.user.id}>.`,
      components: [],
    });
  },
};

const appealModalHandler: ComponentHandler = {
  action: 'appeal-modal',
  kind: 'modal',
  ownerOnly: true,
  async handler(c) {
    const [, caseNumberRaw] = c.args;
    const interaction = c.interaction as ModalSubmitInteraction<'cached'>;
    const content = interaction.fields.getTextInputValue('content');
    const caseNumber = caseNumberRaw ? Number(caseNumberRaw) : undefined;

    const service = moderationService(c.ctx);
    const { staffNotified } = await service.openAppeal({
      guildId: c.guildId,
      userId: c.interaction.user.id,
      caseNumber,
      content,
      source: 'bot',
    });

    // Never claim staff will review it when no appeals channel is configured (or the bot can't post in the one
    // that is) — the row is saved either way, but nobody was told about it.
    await interaction.reply({
      embeds: [
        staffNotified
          ? successEmbed(c.t('appeal.submitted'))
          : infoEmbed(c.t('appeal.notRoutedTitle'), c.t('appeal.notRouted')),
      ],
      ephemeral: true,
    });
  },
};

export const appealComponents: ComponentHandler[] = [
  appealAcceptHandler,
  appealDenyHandler,
  appealUnbanHandler,
  appealModalHandler,
];
