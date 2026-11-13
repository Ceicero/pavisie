import { SlashCommandBuilder } from 'discord.js';
import { Prisma, type PrismaClient, type Suggestion } from '@pavisie/database';
import { errorEmbed, resolveTextChannel, successEmbed, type PluginCommand } from '../../sdk';
import { isMissingChannelPermission, nonBlank } from '../command-input';
import type { CommunityConfig } from '../manifest';
import { buildSuggestionComponents, buildSuggestionEmbed } from '../render';

const NUMBER_MAX_ATTEMPTS = 3;

/**
 * Creates a Suggestion with the next per-guild `number` (`MAX(number) + 1`), retrying on a `[guildId, number]`
 * unique-constraint violation (Prisma P2002) — same race-window caveat and retry pattern as
 * `@pavisie/database`'s `withNextCaseNumber`/`nextCaseNumber` for ModerationCase, reimplemented here for
 * Suggestion since that helper is case-specific and lives in a package this plugin doesn't own.
 */
async function createSuggestionWithNextNumber(
  prisma: PrismaClient,
  guildId: string,
  data: (number: number) => Prisma.SuggestionUncheckedCreateInput,
): Promise<Suggestion> {
  let lastError: unknown;
  for (let attempt = 0; attempt < NUMBER_MAX_ATTEMPTS; attempt++) {
    const agg = await prisma.suggestion.aggregate({ where: { guildId }, _max: { number: true } });
    const number = (agg._max.number ?? 0) + 1;
    try {
      return await prisma.suggestion.create({ data: data(number) });
    } catch (err) {
      lastError = err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

const data = new SlashCommandBuilder()
  .setName('suggest')
  .setDescription('Submit a suggestion for staff to review.')
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt.setName('text').setDescription('Your suggestion').setRequired(true).setMaxLength(1500),
  );

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true, cooldown: { seconds: 30, scope: 'user' } },
  async execute(c) {
    const { interaction, ctx, guildId, t } = c;
    const config = await c.config<CommunityConfig>();

    if (!config.suggestions.channelId) {
      await interaction.reply({ embeds: [errorEmbed(t('suggest.notConfigured'))], ephemeral: true });
      return;
    }

    const content = nonBlank(interaction.options.getString('text', true));
    if (!content) {
      await interaction.reply({ embeds: [errorEmbed(t('suggest.empty'))], ephemeral: true });
      return;
    }

    const channel = await resolveTextChannel(interaction.guild, config.suggestions.channelId);
    if (!channel) {
      await interaction.reply({ embeds: [errorEmbed(t('suggest.channelUnavailable'))], ephemeral: true });
      return;
    }

    let suggestionId: string | null = null;
    let suggestionNumber = 0;
    let messageId: string | null = null;
    try {
      const suggestion = await createSuggestionWithNextNumber(ctx.prisma, guildId, (number) => ({
        guildId,
        number,
        authorId: interaction.user.id,
        channelId: channel.id,
        content,
      }));
      suggestionId = suggestion.id;
      suggestionNumber = suggestion.number;

      const message = await channel.send({
        embeds: [buildSuggestionEmbed(suggestion)],
        components: buildSuggestionComponents(suggestion.id),
      });
      messageId = message.id;

      let threadId: string | null = null;
      if (config.suggestions.threads && message.thread === null) {
        try {
          const thread = await message.startThread({
            name: `Suggestion #${suggestion.number}`.slice(0, 100),
            autoArchiveDuration: 1440,
          });
          threadId = thread.id;
        } catch {
          // Threads may be unavailable (missing permission, or the channel doesn't support them); the suggestion still posts.
        }
      }

      await ctx.prisma.suggestion.update({
        where: { id: suggestion.id },
        data: { messageId: message.id, threadId },
      });
    } catch (err) {
      if (messageId) await channel.messages.delete(messageId).catch(() => undefined);
      if (suggestionId) await ctx.prisma.suggestion.delete({ where: { id: suggestionId } }).catch(() => undefined);
      ctx.logger.warn({ err, guildId }, 'community: failed to submit a suggestion');
      const key = suggestionId
        ? isMissingChannelPermission(err)
          ? 'suggest.channelUnavailable'
          : 'suggest.postFailed'
        : 'suggest.saveFailed';
      await interaction.reply({ embeds: [errorEmbed(t(key))], ephemeral: true });
      return;
    }

    await interaction.reply({
      embeds: [
        successEmbed(t('suggest.submitted', { number: suggestionNumber, channel: `<#${channel.id}>` })),
      ],
      ephemeral: true,
    });
  },
};
