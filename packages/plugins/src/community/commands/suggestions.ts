import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  errorEmbed,
  fetchMemberSafe,
  infoEmbed,
  listEmbed,
  safeDm,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import { syncSuggestionMessage } from '../actions';
import type { CommunityConfig } from '../manifest';
import { isValidSuggestionTransition, type SuggestionStatus } from '../service';

const STATUS_CHOICES: { name: string; value: SuggestionStatus }[] = [
  { name: 'Pending', value: 'PENDING' },
  { name: 'Considering', value: 'CONSIDERING' },
  { name: 'Approved', value: 'APPROVED' },
  { name: 'Denied', value: 'DENIED' },
  { name: 'Implemented', value: 'IMPLEMENTED' },
];

const data = new SlashCommandBuilder()
  .setName('suggestions')
  .setDescription('Manage the suggestion box.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Choose the channel suggestions are posted to.')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Suggestions channel')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription("Change a suggestion's status.")
      .addIntegerOption((opt) =>
        opt.setName('number').setDescription('Suggestion number').setRequired(true).setMinValue(1),
      )
      .addStringOption((opt) =>
        opt
          .setName('status')
          .setDescription('New status')
          .setRequired(true)
          .addChoices(...STATUS_CHOICES),
      )
      .addStringOption((opt) =>
        opt
          .setName('note')
          .setDescription('Optional note shown on the suggestion')
          .setRequired(false)
          .setMaxLength(500),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List suggestions.')
      .addStringOption((opt) =>
        opt
          .setName('status')
          .setDescription('Filter by status')
          .setRequired(false)
          .addChoices(...STATUS_CHOICES),
      ),
  );

async function handleSetup(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const channel = interaction.options.getChannel('channel', true);
  await ctx.setConfig<CommunityConfig>(
    guildId,
    { suggestions: { channelId: channel.id, threads: true, dmAuthorOnStatus: true } },
    { id: interaction.user.id, source: 'bot' },
  );
  await interaction.reply({
    embeds: [successEmbed(t('suggestions.setupDone', { channel: `<#${channel.id}>` }))],
    ephemeral: true,
  });
}

async function handleStatus(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const config = await c.config<CommunityConfig>();
  const number = interaction.options.getInteger('number', true);
  const status = interaction.options.getString('status', true) as SuggestionStatus;
  const note = interaction.options.getString('note') ?? undefined;

  const suggestion = await ctx.prisma.suggestion.findFirst({ where: { guildId, number, deletedAt: null } });
  if (!suggestion) {
    await interaction.reply({ embeds: [errorEmbed(t('suggestions.notFound', { number }))], ephemeral: true });
    return;
  }
  if (!isValidSuggestionTransition(suggestion.status, status)) {
    await interaction.reply({ embeds: [errorEmbed(t('suggestions.alreadyThatStatus'))], ephemeral: true });
    return;
  }

  const updated = await ctx.prisma.suggestion.update({
    where: { id: suggestion.id },
    data: { status, staffNote: note ?? suggestion.staffNote },
  });
  await syncSuggestionMessage(ctx, updated);
  await ctx.audit({
    guildId,
    actorId: interaction.user.id,
    actorType: 'user',
    action: 'community.suggestion.status',
    targetType: 'suggestion',
    targetId: suggestion.id,
    before: { status: suggestion.status },
    after: { status: updated.status },
    source: 'bot',
  });

  if (config.suggestions.dmAuthorOnStatus) {
    const member = await fetchMemberSafe(interaction.guild, updated.authorId);
    if (member) {
      await safeDm(
        member.user,
        t('suggestions.dmStatusChanged', { number, status, guild: interaction.guild.name }),
      );
    }
  }

  await interaction.reply({
    embeds: [successEmbed(t('suggestions.statusChanged', { number, status }))],
    ephemeral: true,
  });
}

async function handleList(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const status = interaction.options.getString('status') as SuggestionStatus | null;
  const suggestions = await ctx.prisma.suggestion.findMany({
    where: { guildId, deletedAt: null, ...(status ? { status } : {}) },
    orderBy: { number: 'desc' },
    take: 25,
  });
  if (suggestions.length === 0) {
    await interaction.reply({
      embeds: [
        infoEmbed(
          t('suggestions.listTitle'),
          status ? t('suggestions.listEmptyFiltered', { status }) : t('suggestions.listEmpty'),
        ),
      ],
      ephemeral: true,
    });
    return;
  }
  const lines = suggestions.map(
    (s) =>
      `**#${s.number}** ${s.content.slice(0, 60)}${s.content.length > 60 ? '…' : ''} — ${s.status} (👍${s.upvotes} 👎${s.downvotes})`,
  );
  await interaction.reply({ embeds: [listEmbed(t('suggestions.listTitle'), lines)], ephemeral: true });
}

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'moderator', guildOnly: true },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'setup') return handleSetup(c);
    if (sub === 'status') return handleStatus(c);
    return handleList(c);
  },
};
