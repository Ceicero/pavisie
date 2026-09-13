import { SlashCommandBuilder } from 'discord.js';
import { EMBED_LIMITS, NotFoundError, ValidationError, truncate } from '@pavisie/core';
import { infoEmbed, userMention, type PluginCommand } from '../../sdk';
import { AiUnavailableError, enforceCooldown } from '../service';
import { AI_DISCLOSURE } from '../manifest';
import { buildModAssistPrompt, type ModAssistCaseSummary } from '../prompt';

const CASE_HISTORY_LIMIT = 50;
const RECENT_REASONS_SHOWN = 5;

const data = new SlashCommandBuilder()
  .setName('mod-assist')
  .setDescription(
    'Ask the AI assistant to suggest moderation case options (staff only, never acts alone).',
  )
  .setDMPermission(false)
  .addIntegerOption((opt) =>
    opt.setName('case-number').setDescription('A case number to look up').setMinValue(1),
  )
  .addUserOption((opt) => opt.setName('user').setDescription('A user to look up case history for'))
  .addStringOption((opt) =>
    opt
      .setName('context')
      .setDescription('Extra context for the suggestion (not stored, not message content)')
      .setMaxLength(1000),
  );

function summarizeCases(cases: { type: string; reason: string | null }[]): ModAssistCaseSummary {
  const byType: Record<string, number> = {};
  for (const c of cases) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
  }
  const recentReasons = cases
    .filter((c) => c.reason && c.reason.trim().length > 0)
    .slice(0, RECENT_REASONS_SHOWN)
    .map((c) => `${c.type}: ${c.reason as string}`);

  return { totalCases: cases.length, byType, recentReasons };
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true, staffLevel: 'moderator' },
  async execute(c) {
    const caseNumber = c.interaction.options.getInteger('case-number');
    const userOption = c.interaction.options.getUser('user');
    const extraContext = c.interaction.options.getString('context') ?? undefined;

    if (!caseNumber && !userOption) {
      throw new ValidationError(c.t('errors.modAssistNeedsTarget'));
    }

    const moderationService = c.ctx.services.get('moderation');
    if (!moderationService) {
      throw new AiUnavailableError(c.t('errors.moderationUnavailable'));
    }

    const aiService = c.ctx.services.get('ai');
    if (!aiService) {
      throw new AiUnavailableError(c.t('errors.unavailable'));
    }

    let targetUserId = userOption?.id;
    let targetLabel: string | undefined = userOption ? userMention(userOption.id) : undefined;

    if (!targetUserId && caseNumber) {
      const foundCase = await moderationService.getCase(c.guildId, caseNumber);
      if (!foundCase) {
        throw new NotFoundError(c.t('errors.caseNotFound', { number: caseNumber }));
      }
      targetUserId = foundCase.targetId;
      targetLabel = `${userMention(foundCase.targetId)} (case #${caseNumber})`;
    }

    const config = await c.config<{ userCooldownSeconds: number }>();
    await enforceCooldown(c.ctx, c.guildId, c.interaction.user.id, config.userCooldownSeconds, c.t);

    await c.interaction.deferReply({ ephemeral: true });

    const { items } = await moderationService.listCases({
      guildId: c.guildId,
      targetId: targetUserId,
      limit: CASE_HISTORY_LIMIT,
    });
    const summary = summarizeCases(items);

    const result = await aiService.complete({
      guildId: c.guildId,
      userId: c.interaction.user.id,
      command: 'mod-assist',
      prompt: buildModAssistPrompt(targetLabel ?? `user ${targetUserId}`, summary, extraContext),
    });

    const embed = infoEmbed(
      c.t('modAssist.replyTitle'),
      [c.t('modAssist.disclaimer'), '', truncate(result.text, EMBED_LIMITS.description - 200)].join('\n'),
    ).setFooter({ text: AI_DISCLOSURE });

    await c.interaction.editReply({ embeds: [embed] });
  },
};
