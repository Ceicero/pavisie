import { SlashCommandBuilder } from 'discord.js';
import { EMBED_LIMITS, truncate } from '@pavisie/core';
import { infoEmbed, type PluginCommand } from '../../sdk';
import { AiUnavailableError, enforceCooldown } from '../service';
import { AI_DISCLOSURE } from '../manifest';
import { buildDraftPrompt, type DraftType } from '../prompt';

const DRAFT_TYPES: { name: string; value: DraftType }[] = [
  { name: 'Announcement', value: 'announcement' },
  { name: 'Rules', value: 'rules' },
  { name: 'Welcome message', value: 'welcome' },
  { name: 'Reply', value: 'reply' },
];

const data = new SlashCommandBuilder()
  .setName('draft')
  .setDescription('Draft a piece of server text with the AI assistant (staff only).')
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName('type')
      .setDescription('What to draft')
      .setRequired(true)
      .addChoices(...DRAFT_TYPES),
  )
  .addStringOption((opt) =>
    opt.setName('notes').setDescription('Notes / key points to include').setRequired(true).setMaxLength(1500),
  );

export const command: PluginCommand = {
  data,
  // Staff-only, ephemeral, and allowed in any channel — not gated by `allowedChannelIds` (per-command spec:
  // "/draft & /mod-assist are ephemeral and allowed anywhere for staff").
  requirement: { guildOnly: true, staffLevel: 'helper' },
  async execute(c) {
    const type = c.interaction.options.getString('type', true) as DraftType;
    const notes = c.interaction.options.getString('notes', true);

    const aiService = c.ctx.services.get('ai');
    if (!aiService) {
      throw new AiUnavailableError(c.t('errors.unavailable'));
    }

    const config = await c.config<{ userCooldownSeconds: number }>();
    await enforceCooldown(c.ctx, c.guildId, c.interaction.user.id, config.userCooldownSeconds, c.t);

    await c.interaction.deferReply({ ephemeral: true });

    const result = await aiService.complete({
      guildId: c.guildId,
      userId: c.interaction.user.id,
      command: 'draft',
      prompt: buildDraftPrompt(type, notes),
    });

    const embed = infoEmbed(
      c.t('draft.replyTitle'),
      truncate(result.text, EMBED_LIMITS.description),
    ).setFooter({ text: AI_DISCLOSURE });
    await c.interaction.editReply({ embeds: [embed] });
  },
};
