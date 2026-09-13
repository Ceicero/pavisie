import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { parseDuration } from '@pavisie/core';
import {
  errorEmbed,
  listEmbed,
  resolveTextChannel,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import { cancelGiveaway, finalizeGiveaway, rerollGiveaway } from '../actions';
import type { CommunityConfig } from '../manifest';
import { buildGiveawayComponents, buildGiveawayEmbed } from '../render';

const data = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Run giveaways.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Start a giveaway.')
      .addStringOption((opt) =>
        opt.setName('prize').setDescription('What is being given away').setRequired(true).setMaxLength(200),
      )
      .addStringOption((opt) =>
        opt.setName('duration').setDescription('How long the giveaway runs, e.g. 1h, 1d').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('winners')
          .setDescription('Number of winners')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(50),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to post in (default: this channel)')
          .setRequired(false),
      )
      .addRoleOption((opt) =>
        opt.setName('required-role').setDescription('Role required to enter').setRequired(false),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('min-account-age-days')
          .setDescription('Minimum Discord account age, in days')
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(3650),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('min-level')
          .setDescription('Minimum engagement level (if the engagement plugin is enabled)')
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(1000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('End a giveaway now and draw winners.')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Giveaway id').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reroll')
      .setDescription('Redraw winners for an ended giveaway.')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Giveaway id').setRequired(true).setAutocomplete(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('count')
          .setDescription('How many winners to draw (default: original winner count)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(50),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List active and recently-ended giveaways.'))
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel a giveaway before it ends.')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Giveaway id').setRequired(true).setAutocomplete(true),
      ),
  );

async function handleStart(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const config = await c.config<CommunityConfig>();

  const prize = interaction.options.getString('prize', true);
  const durationStr = interaction.options.getString('duration', true);
  const ms = parseDuration(durationStr);
  if (ms === null || ms <= 0) {
    await interaction.reply({ embeds: [errorEmbed(t('giveaway.badDuration'))], ephemeral: true });
    return;
  }

  const winnerCount = interaction.options.getInteger('winners') ?? config.giveaways.defaultWinners;
  const channelOption = interaction.options.getChannel('channel');
  const channelId = channelOption?.id ?? interaction.channelId;
  const channel = await resolveTextChannel(interaction.guild, channelId);
  if (!channel) {
    await interaction.reply({ embeds: [errorEmbed(t('giveaway.badChannel'))], ephemeral: true });
    return;
  }

  const requiredRole = interaction.options.getRole('required-role');
  const minAccountAgeDays = interaction.options.getInteger('min-account-age-days');
  const minLevel = interaction.options.getInteger('min-level');
  const endsAt = new Date(Date.now() + ms);

  const giveaway = await ctx.prisma.giveaway.create({
    data: {
      guildId,
      channelId,
      prize,
      winnerCount,
      hostId: interaction.user.id,
      endsAt,
      requiredRoleIds: requiredRole ? [requiredRole.id] : [],
      minAccountAgeDays: minAccountAgeDays ?? undefined,
      minLevel: minLevel ?? undefined,
    },
  });

  const message = await channel.send({
    embeds: [buildGiveawayEmbed(giveaway, 0)],
    components: buildGiveawayComponents(giveaway.id, false),
  });
  await ctx.prisma.giveaway.update({ where: { id: giveaway.id }, data: { messageId: message.id } });
  await ctx
    .queue('giveaway-end')
    .add('giveaway-end', { giveawayId: giveaway.id }, { jobId: `gw-${giveaway.id}`, delay: ms });

  await interaction.reply({
    embeds: [successEmbed(t('giveaway.started', { channel: `<#${channelId}>` }))],
    ephemeral: true,
  });
}

async function handleEnd(c: CommandContext): Promise<void> {
  const { interaction, ctx, t, guildId } = c;
  const id = interaction.options.getString('id', true);
  const giveaway = await ctx.prisma.giveaway.findFirst({ where: { id, guildId } });
  if (!giveaway) {
    await interaction.reply({ embeds: [errorEmbed(t('giveaway.notFound'))], ephemeral: true });
    return;
  }
  if (giveaway.ended) {
    await interaction.reply({ embeds: [errorEmbed(t('giveaway.alreadyEnded'))], ephemeral: true });
    return;
  }

  await ctx
    .queue('giveaway-end')
    .remove(`gw-${giveaway.id}`)
    .catch(() => undefined);
  await finalizeGiveaway(ctx, giveaway.id);
  await interaction.reply({ embeds: [successEmbed(t('giveaway.ended'))], ephemeral: true });
}

async function handleReroll(c: CommandContext): Promise<void> {
  const { interaction, ctx, t, guildId } = c;
  const id = interaction.options.getString('id', true);
  const count = interaction.options.getInteger('count') ?? undefined;
  const giveaway = await ctx.prisma.giveaway.findFirst({ where: { id, guildId } });
  if (!giveaway) {
    await interaction.reply({ embeds: [errorEmbed(t('giveaway.notFound'))], ephemeral: true });
    return;
  }
  if (!giveaway.ended) {
    await interaction.reply({ embeds: [errorEmbed(t('giveaway.notEndedYet'))], ephemeral: true });
    return;
  }

  const result = await rerollGiveaway(ctx, giveaway.id, count);
  if (!result || result.winnerIds.length === 0) {
    await interaction.reply({ embeds: [errorEmbed(t('giveaway.noEntries'))], ephemeral: true });
    return;
  }
  await interaction.reply({
    embeds: [
      successEmbed(t('giveaway.rerolled', { winners: result.winnerIds.map((w) => `<@${w}>`).join(', ') })),
    ],
    ephemeral: true,
  });
}

async function handleList(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const giveaways = await ctx.prisma.giveaway.findMany({
    where: { guildId },
    orderBy: { endsAt: 'desc' },
    take: 25,
  });
  const lines = giveaways.map(
    (g) => `${g.ended ? '🏁' : '🎉'} **${g.prize}** — ${g.ended ? 'ended' : 'active'} · \`${g.id}\``,
  );
  await interaction.reply({ embeds: [listEmbed(t('giveaway.listTitle'), lines)], ephemeral: true });
}

async function handleCancel(c: CommandContext): Promise<void> {
  const { interaction, ctx, t, guildId } = c;
  const id = interaction.options.getString('id', true);
  const giveaway = await ctx.prisma.giveaway.findFirst({ where: { id, guildId } });
  if (!giveaway) {
    await interaction.reply({ embeds: [errorEmbed(t('giveaway.notFound'))], ephemeral: true });
    return;
  }
  if (giveaway.ended) {
    await interaction.reply({ embeds: [errorEmbed(t('giveaway.alreadyEnded'))], ephemeral: true });
    return;
  }
  await cancelGiveaway(ctx, giveaway.id);
  await interaction.reply({ embeds: [successEmbed(t('giveaway.cancelled'))], ephemeral: true });
}

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'moderator', guildOnly: true },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'start') return handleStart(c);
    if (sub === 'end') return handleEnd(c);
    if (sub === 'reroll') return handleReroll(c);
    if (sub === 'list') return handleList(c);
    return handleCancel(c);
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    const query = String(focused.value).toLowerCase();
    const giveaways = await c.ctx.prisma.giveaway.findMany({
      where: { guildId: c.guildId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const matches = giveaways
      .filter((g) => g.prize.toLowerCase().includes(query) || g.id.includes(query))
      .slice(0, 25);
    await c.interaction.respond(
      matches.map((g) => ({ name: `${g.ended ? '[ended] ' : ''}${g.prize}`.slice(0, 100), value: g.id })),
    );
  },
};
