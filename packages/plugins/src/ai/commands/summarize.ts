import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildTextBasedChannel,
} from 'discord.js';
import { EMBED_LIMITS, ValidationError, truncate } from '@pavisie/core';
import { infoEmbed, type PluginCommand } from '../../sdk';
import { AiUnavailableError, enforceCooldown } from '../service';
import { AI_DISCLOSURE, type AiConfig } from '../manifest';
import { buildSummarizePrompt, type SummarizeMessageInput } from '../prompt';
import { redact } from '../redact';

const MIN_COUNT = 10;
const MAX_COUNT = 100;
const DEFAULT_COUNT = 30;
const MAX_CHARS_PER_MESSAGE = 400;

const SUMMARIZABLE_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
];

const data = new SlashCommandBuilder()
  .setName('summarize')
  .setDescription('Summarize recent messages in a channel using the AI assistant.')
  .setDMPermission(false)
  .addIntegerOption((opt) =>
    opt
      .setName('count')
      .setDescription(
        `How many recent messages to summarize (${MIN_COUNT}-${MAX_COUNT}, default ${DEFAULT_COUNT})`,
      )
      .setMinValue(MIN_COUNT)
      .setMaxValue(MAX_COUNT),
  )
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel to summarize (default: this channel)')
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
      ),
  );

function isSummarizable(channel: unknown): channel is GuildTextBasedChannel {
  return (
    channel != null &&
    typeof channel === 'object' &&
    'type' in channel &&
    SUMMARIZABLE_CHANNEL_TYPES.includes((channel as { type: ChannelType }).type)
  );
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true },
  async execute(c) {
    const config = await c.config<AiConfig>();
    const count = c.interaction.options.getInteger('count') ?? DEFAULT_COUNT;
    const requestedChannel = c.interaction.options.getChannel('channel');
    const targetChannel = requestedChannel ?? c.interaction.channel;

    if (!isSummarizable(targetChannel)) {
      throw new ValidationError(c.t('errors.channelNotSummarizable'));
    }

    if (!config.allowedChannelIds.includes(targetChannel.id)) {
      throw new ValidationError(c.t('errors.channelNotAllowed'));
    }

    if (!c.ctx.intentsEnabled.messageContent) {
      throw new ValidationError(c.t('errors.messageContentIntentMissing'));
    }

    const memberPermissions = c.interaction.member.permissionsIn(targetChannel);
    if (!memberPermissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      throw new ValidationError(c.t('errors.summarizeNoAccess'));
    }

    const aiService = c.ctx.services.get('ai');
    if (!aiService) {
      throw new AiUnavailableError(c.t('errors.unavailable'));
    }

    await enforceCooldown(c.ctx, c.guildId, c.interaction.user.id, config.userCooldownSeconds, c.t);

    const fetched = await targetChannel.messages.fetch({ limit: count });
    const messages: SummarizeMessageInput[] = [...fetched.values()]
      .filter((m) => !m.author.bot && m.content.trim().length > 0)
      .reverse() // fetch() returns newest-first; the transcript reads best oldest-first
      .map((m) => ({
        author: m.member?.displayName ?? m.author.username,
        content: redact(truncate(m.content, MAX_CHARS_PER_MESSAGE)),
      }));

    if (messages.length === 0) {
      throw new ValidationError(c.t('errors.nothingToSummarize'));
    }

    await c.interaction.deferReply({ ephemeral: true });

    const result = await aiService.complete({
      guildId: c.guildId,
      userId: c.interaction.user.id,
      command: 'summarize',
      prompt: buildSummarizePrompt(messages),
    });

    const embed = infoEmbed(
      c.t('summarize.replyTitle', { channel: targetChannel.name }),
      truncate(result.text, EMBED_LIMITS.description),
    ).setFooter({
      text: AI_DISCLOSURE,
    });
    await c.interaction.editReply({ embeds: [embed] });
  },
};
