import { SlashCommandBuilder } from 'discord.js';
import { EMBED_LIMITS, ValidationError, truncate } from '@pavisie/core';
import { infoEmbed, type PluginCommand } from '../../sdk';
import { AiUnavailableError, enforceCooldown } from '../service';
import { AI_DISCLOSURE, type AiConfig } from '../manifest';
import { buildAskPrompt } from '../prompt';

const data = new SlashCommandBuilder()
  .setName('ask')
  .setDescription('Ask the AI assistant a question.')
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt.setName('question').setDescription('Your question').setRequired(true).setMaxLength(1000),
  )
  .addBooleanOption((opt) =>
    opt.setName('private').setDescription('Reply so only you can see it (default: off)').setRequired(false),
  );

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true },
  async execute(c) {
    const config = await c.config<AiConfig>();
    const question = c.interaction.options.getString('question', true);
    const wantsPrivate = c.interaction.options.getBoolean('private') ?? false;

    if (!config.allowedChannelIds.includes(c.interaction.channelId)) {
      throw new ValidationError(c.t('errors.channelNotAllowed'));
    }

    const aiService = c.ctx.services.get('ai');
    if (!aiService) {
      throw new AiUnavailableError(c.t('errors.unavailable'));
    }

    await enforceCooldown(c.ctx, c.guildId, c.interaction.user.id, config.userCooldownSeconds, c.t);

    await c.interaction.deferReply({ ephemeral: wantsPrivate });

    const result = await aiService.complete({
      guildId: c.guildId,
      userId: c.interaction.user.id,
      command: 'ask',
      prompt: buildAskPrompt(question),
    });

    const embed = infoEmbed(c.t('ask.replyTitle'), truncate(result.text, EMBED_LIMITS.description)).setFooter(
      { text: AI_DISCLOSURE },
    );
    await c.interaction.editReply({ embeds: [embed] });
  },
};
