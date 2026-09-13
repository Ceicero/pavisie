import { SlashCommandBuilder } from 'discord.js';
import { hasStaffLevel, parseDuration } from '@pavisie/core';
import { errorEmbed, successEmbed, type CommandContext, type PluginCommand } from '../../sdk';
import { closePoll } from '../actions';
import type { CommunityConfig } from '../manifest';
import { buildPollComponents, buildPollEmbed, tallyPollFromRows } from '../render';

const MAX_OPTIONS = 10;

const data = new SlashCommandBuilder()
  .setName('poll')
  .setDescription('Run a poll.')
  .setDMPermission(false)
  .addSubcommand((sub) => {
    sub
      .setName('create')
      .setDescription('Start a new poll.')
      .addStringOption((opt) =>
        opt.setName('question').setDescription('The poll question').setRequired(true).setMaxLength(256),
      )
      .addStringOption((opt) =>
        opt.setName('option1').setDescription('Option 1').setRequired(true).setMaxLength(100),
      )
      .addStringOption((opt) =>
        opt.setName('option2').setDescription('Option 2').setRequired(true).setMaxLength(100),
      );
    for (let i = 3; i <= MAX_OPTIONS; i++) {
      sub.addStringOption((opt) =>
        opt.setName(`option${i}`).setDescription(`Option ${i}`).setRequired(false).setMaxLength(100),
      );
    }
    sub
      .addStringOption((opt) =>
        opt
          .setName('duration')
          .setDescription('How long the poll stays open, e.g. 1h, 30m (default: open until manually ended)')
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt.setName('anonymous').setDescription('Hide who voted for what (default: off)').setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('multi')
          .setDescription('Allow selecting more than one option (default: off)')
          .setRequired(false),
      );
    return sub;
  })
  .addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('End a poll early and show final results.')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Poll id').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('results')
      .setDescription("Show a poll's current results.")
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Poll id').setRequired(true).setAutocomplete(true),
      ),
  );

async function handleCreate(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const config = await c.config<CommunityConfig>();

  const question = interaction.options.getString('question', true);
  const rawOptions: string[] = [];
  for (let i = 1; i <= MAX_OPTIONS; i++) {
    const value = interaction.options.getString(`option${i}`);
    if (value && value.trim().length > 0) rawOptions.push(value.trim());
  }

  if (rawOptions.length < 2) {
    await interaction.reply({ embeds: [errorEmbed(t('poll.needTwoOptions'))], ephemeral: true });
    return;
  }
  if (rawOptions.length > config.polls.maxOptions) {
    await interaction.reply({
      embeds: [errorEmbed(t('poll.tooManyOptions', { max: config.polls.maxOptions }))],
      ephemeral: true,
    });
    return;
  }

  const durationStr = interaction.options.getString('duration');
  let endsAt: Date | null = null;
  if (durationStr) {
    const ms = parseDuration(durationStr);
    if (ms === null || ms <= 0) {
      await interaction.reply({ embeds: [errorEmbed(t('poll.badDuration'))], ephemeral: true });
      return;
    }
    endsAt = new Date(Date.now() + ms);
  }

  const anonymous = interaction.options.getBoolean('anonymous') ?? false;
  const multiSelect = interaction.options.getBoolean('multi') ?? false;

  const poll = await ctx.prisma.poll.create({
    data: {
      guildId,
      channelId: interaction.channelId,
      question,
      anonymous,
      multiSelect,
      endsAt,
      createdBy: interaction.user.id,
      options: { create: rawOptions.map((label, position) => ({ label, position })) },
    },
    include: { options: true },
  });

  const tallies = tallyPollFromRows(poll, poll.options, []);
  await interaction.reply({
    embeds: [buildPollEmbed(poll, tallies)],
    components: buildPollComponents(poll.id, poll.options, false),
  });
  const message = await interaction.fetchReply();
  await ctx.prisma.poll.update({ where: { id: poll.id }, data: { messageId: message.id } });

  if (endsAt) {
    await ctx
      .queue('poll-end')
      .add(
        'poll-end',
        { pollId: poll.id },
        { jobId: `poll-${poll.id}`, delay: Math.max(0, endsAt.getTime() - Date.now()) },
      );
  }
}

async function handleEnd(c: CommandContext): Promise<void> {
  const { interaction, ctx, t, staffLevel } = c;
  const id = interaction.options.getString('id', true);
  const poll = await ctx.prisma.poll.findFirst({ where: { id, guildId: c.guildId } });
  if (!poll) {
    await interaction.reply({ embeds: [errorEmbed(t('poll.notFound'))], ephemeral: true });
    return;
  }
  if (poll.createdBy !== interaction.user.id && !hasStaffLevel(staffLevel, 'moderator')) {
    await interaction.reply({ embeds: [errorEmbed(t('poll.notOwner'))], ephemeral: true });
    return;
  }
  if (poll.closed) {
    await interaction.reply({ embeds: [errorEmbed(t('poll.alreadyClosed'))], ephemeral: true });
    return;
  }

  await ctx
    .queue('poll-end')
    .remove(`poll-${poll.id}`)
    .catch(() => undefined);
  await closePoll(ctx, poll.id);
  await interaction.reply({ embeds: [successEmbed(t('poll.ended'))], ephemeral: true });
}

async function handleResults(c: CommandContext): Promise<void> {
  const { interaction, ctx, t } = c;
  const id = interaction.options.getString('id', true);
  const poll = await ctx.prisma.poll.findFirst({
    where: { id, guildId: c.guildId },
    include: { options: true, votes: true },
  });
  if (!poll) {
    await interaction.reply({ embeds: [errorEmbed(t('poll.notFound'))], ephemeral: true });
    return;
  }
  const tallies = tallyPollFromRows(poll, poll.options, poll.votes);
  await interaction.reply({ embeds: [buildPollEmbed(poll, tallies)] });
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true, cooldown: { seconds: 10, scope: 'user' } },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'create') return handleCreate(c);
    if (sub === 'end') return handleEnd(c);
    return handleResults(c);
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    const query = String(focused.value).toLowerCase();
    const polls = await c.ctx.prisma.poll.findMany({
      where: { guildId: c.guildId, OR: [{ createdBy: c.interaction.user.id }, { closed: false }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const matches = polls
      .filter((p) => p.question.toLowerCase().includes(query) || p.id.includes(query))
      .slice(0, 25);
    await c.interaction.respond(
      matches.map((p) => ({
        name: `${p.closed ? '[closed] ' : ''}${p.question}`.slice(0, 100),
        value: p.id,
      })),
    );
  },
};
