import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AuditAction } from '@pavisie/core';
import { buildCustomId, errorEmbed, successEmbed, PendingStore, type ComponentHandler } from '../../sdk';
import { flagRecord } from '../service';

interface PendingFlagTarget {
  targetUserId: string;
  channelId: string;
  messageId: string;
  content: string;
}

/** Step 1 of "Flag for review": the moderator picked a policy (or "none") — show the optional-note modal. */
const selectPolicyHandler: ComponentHandler = {
  action: 'flag-select-policy',
  kind: 'select',
  ownerOnly: true,
  requirement: { staffLevel: 'helper' },
  async handler(c) {
    const [ownerId, pendingId] = c.args;
    const interaction = c.interaction as unknown as StringSelectMenuInteraction<'cached'>;
    const policyId = interaction.values[0] ?? 'none';

    const pendingStore = new PendingStore(c.ctx.redis);
    const pending = pendingId ? await pendingStore.peek<PendingFlagTarget>(pendingId) : null;
    if (!pending) {
      await interaction.update({
        content: 'This flag session has expired — run "Flag for review" again.',
        components: [],
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(
        buildCustomId(
          'enforcer',
          'flag-note-modal',
          ownerId ?? interaction.user.id,
          pendingId ?? '',
          policyId,
        ),
      )
      .setTitle('Flag for review')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('note')
            .setLabel('Note for the moderator queue (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(500),
        ),
      );

    await interaction.showModal(modal);
  },
};

/** Step 2: the note modal was submitted — create the flag record. */
const noteModalHandler: ComponentHandler = {
  action: 'flag-note-modal',
  kind: 'modal',
  ownerOnly: true,
  requirement: { staffLevel: 'helper' },
  async handler(c) {
    const [, pendingId, policyId] = c.args;
    const interaction = c.interaction as unknown as ModalSubmitInteraction<'cached'>;
    const note = interaction.fields.getTextInputValue('note').trim();

    const pendingStore = new PendingStore(c.ctx.redis);
    const pending = pendingId ? await pendingStore.take<PendingFlagTarget>(pendingId) : null;
    if (!pending) {
      await interaction.reply({
        embeds: [errorEmbed('This flag session has expired — run "Flag for review" again.')],
        ephemeral: true,
      });
      return;
    }

    const resolvedPolicyId = policyId && policyId !== 'none' ? policyId : undefined;
    let policyName: string | undefined;
    if (resolvedPolicyId) {
      const policy = await c.ctx.prisma.enforcerPolicy.findFirst({
        where: { id: resolvedPolicyId, guildId: c.guildId, deletedAt: null },
      });
      policyName = policy?.name;
    }

    const content = note.length > 0 ? `${pending.content}\n\nStaff note: ${note}` : pending.content;

    const result = await flagRecord(c.ctx, {
      guildId: c.guildId,
      userId: pending.targetUserId,
      channelId: pending.channelId,
      messageId: pending.messageId,
      content,
      policyId: resolvedPolicyId,
      policyName,
      source: 'MANUAL',
      flaggedBy: interaction.user.id,
    });

    await c.ctx.audit({
      guildId: c.guildId,
      actorId: interaction.user.id,
      actorType: 'user',
      action: AuditAction.ModerationCaseCreate,
      targetType: 'enforcer_record',
      targetId: result.recordId,
      after: { userId: pending.targetUserId, recordNumber: result.recordNumber },
      source: 'bot',
    });

    await interaction.reply({
      embeds: [successEmbed(`Flag **#E-${result.recordNumber}** opened.`)],
      ephemeral: true,
    });
  },
};

export const flagReviewComponents: ComponentHandler[] = [selectPolicyHandler, noteModalHandler];
