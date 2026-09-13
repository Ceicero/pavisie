import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { AuditAction, ValidationError } from '@pavisie/core';
import { buildCustomId, successEmbed, type ComponentHandler } from '../../sdk';
import {
  checkReportRateLimit,
  getBotVersion,
  isReportKind,
  REPORT_BODY_MAX,
  REPORT_SUBJECT_MAX,
  validateReportInput,
} from '../report-shared';

/** Step 2 of 2: the "Write report" button from `/pavisie report` opens the subject/body modal. */
const reportContinueHandler: ComponentHandler = {
  action: 'report-continue',
  kind: 'button',
  ownerOnly: true,
  requirement: { staffLevel: 'admin' },
  async handler(c) {
    const interaction = c.interaction as ButtonInteraction<'cached'>;
    const [ownerId, kind] = c.args;

    const modal = new ModalBuilder()
      .setCustomId(buildCustomId('admin', 'report-modal', ownerId, kind))
      .setTitle('Report to the Pavisie developer')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('subject')
            .setLabel('Subject')
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(REPORT_SUBJECT_MAX)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('body')
            .setLabel('Details')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(1)
            .setMaxLength(REPORT_BODY_MAX)
            .setRequired(true),
        ),
      );

    await interaction.showModal(modal);
  },
};

/**
 * Step 3 of 3 (final): persists the report. Only the fields the admin typed in this modal, plus unavoidable
 * routing metadata (guild id/name, sender id/tag, timestamp, bot version), are ever written — see the
 * regression test in `__tests__/report.test.ts` asserting the exact `developerReport.create` payload shape.
 * Writes a guild-audit-log entry too (source: 'bot') so the server's *other* admins can see a report was sent —
 * transparency in both directions, per the plugin's `privacyNotes`.
 */
const reportModalHandler: ComponentHandler = {
  action: 'report-modal',
  kind: 'modal',
  ownerOnly: true,
  requirement: { staffLevel: 'admin' },
  async handler(c) {
    const interaction = c.interaction as ModalSubmitInteraction<'cached'>;
    const [, kindRaw] = c.args;

    if (!kindRaw || !isReportKind(kindRaw)) {
      throw new ValidationError('Unknown report kind. Please run `/pavisie report` again.');
    }
    const kind = kindRaw;

    await checkReportRateLimit(c.ctx.rateLimiter, c.guildId, interaction.user.id);

    const subject = interaction.fields.getTextInputValue('subject');
    const body = interaction.fields.getTextInputValue('body');
    validateReportInput({ subject, body });

    const row = await c.ctx.prisma.developerReport.create({
      data: {
        guildId: c.guildId,
        guildName: interaction.guild.name,
        senderId: interaction.user.id,
        senderTag: interaction.user.tag,
        kind,
        subject: subject.trim(),
        body: body.trim(),
        botVersion: getBotVersion(),
      },
    });

    await c.ctx.audit({
      guildId: c.guildId,
      actorId: interaction.user.id,
      actorType: 'user',
      action: AuditAction.DeveloperReportSubmit,
      targetType: 'developer_report',
      targetId: row.id,
      after: { kind, subject: row.subject },
      source: 'bot',
    });

    await interaction.reply({ embeds: [successEmbed(c.t('report.success'))], ephemeral: true });
  },
};

export const reportComponents: ComponentHandler[] = [reportContinueHandler, reportModalHandler];
