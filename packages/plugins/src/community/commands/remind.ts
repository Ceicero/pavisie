import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { hasStaffLevel } from '@pavisie/core';
import {
  errorEmbed,
  listEmbed,
  resolveTextChannel,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import { cancelReminder } from '../actions';
import { parseAt, validateCron } from '../schedule';

const data = new SlashCommandBuilder()
  .setName('remind')
  .setDescription('Set reminders.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Set a reminder.')
      .addStringOption((opt) =>
        opt
          .setName('when')
          .setDescription('When: an ISO date/time or a duration like "10m"/"2h"')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('message').setDescription('What to remind you about').setRequired(true).setMaxLength(500),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Post in this channel instead of DMing you')
          .setRequired(false)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addStringOption((opt) =>
        opt
          .setName('recurring')
          .setDescription('Repeat on this cron schedule instead of a one-off reminder')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List your upcoming reminders.'))
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel a reminder.')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Reminder id').setRequired(true).setAutocomplete(true),
      ),
  );

async function handleSet(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const when = interaction.options.getString('when', true);
  const message = interaction.options.getString('message', true);
  const channel = interaction.options.getChannel('channel');
  const recurring = interaction.options.getString('recurring');

  const host = ctx.services.get('host');
  const timezone = host ? (await host.getGuildConfig(guildId)).timezone : 'UTC';

  const parsedAt = parseAt(when, timezone);
  if (!parsedAt.ok) {
    await interaction.reply({ embeds: [errorEmbed(parsedAt.reason)], ephemeral: true });
    return;
  }

  if (recurring) {
    const cronCheck = validateCron(recurring, timezone);
    if (!cronCheck.ok) {
      await interaction.reply({
        embeds: [errorEmbed(t('remind.badCron', { reason: cronCheck.reason }))],
        ephemeral: true,
      });
      return;
    }
  }

  if (channel) {
    const resolved = await resolveTextChannel(interaction.guild, channel.id);
    if (!resolved) {
      await interaction.reply({ embeds: [errorEmbed(t('remind.badChannel'))], ephemeral: true });
      return;
    }
  }

  const reminder = await ctx.prisma.reminder.create({
    data: {
      guildId,
      userId: interaction.user.id,
      channelId: channel?.id ?? null,
      content: message,
      remindAt: parsedAt.date,
      recurring: recurring ?? null,
    },
  });

  const queue = ctx.queue('reminder-deliver');
  if (recurring) {
    await queue.upsertJobScheduler(
      `rem-${reminder.id}`,
      { pattern: recurring, tz: timezone },
      { name: 'reminder-deliver', data: { reminderId: reminder.id } },
    );
  } else {
    await queue.add(
      'reminder-deliver',
      { reminderId: reminder.id },
      { jobId: `rem-${reminder.id}`, delay: Math.max(0, parsedAt.date.getTime() - Date.now()) },
    );
  }

  await interaction.reply({
    embeds: [successEmbed(t('remind.set', { time: parsedAt.date.toISOString() }))],
    ephemeral: true,
  });
}

async function handleList(c: CommandContext): Promise<void> {
  const { interaction, ctx, t } = c;
  const reminders = await ctx.prisma.reminder.findMany({
    where: { userId: interaction.user.id, guildId: c.guildId, delivered: false },
    orderBy: { remindAt: 'asc' },
    take: 25,
  });
  const lines = reminders.map(
    (r) =>
      `**${r.content.slice(0, 60)}${r.content.length > 60 ? '…' : ''}** — ${r.remindAt.toISOString()}${r.recurring ? ` (recurring: \`${r.recurring}\`)` : ''} · \`${r.id}\``,
  );
  await interaction.reply({ embeds: [listEmbed(t('remind.listTitle'), lines)], ephemeral: true });
}

async function handleCancel(c: CommandContext): Promise<void> {
  const { interaction, ctx, t, staffLevel } = c;
  const id = interaction.options.getString('id', true);
  const reminder = await ctx.prisma.reminder.findFirst({ where: { id, guildId: c.guildId } });
  if (!reminder) {
    await interaction.reply({ embeds: [errorEmbed(t('remind.notFound'))], ephemeral: true });
    return;
  }
  if (reminder.userId !== interaction.user.id && !hasStaffLevel(staffLevel, 'moderator')) {
    await interaction.reply({ embeds: [errorEmbed(t('remind.notOwner'))], ephemeral: true });
    return;
  }
  await cancelReminder(ctx, reminder.id, reminder.recurring);
  await interaction.reply({ embeds: [successEmbed(t('remind.cancelled'))], ephemeral: true });
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true, cooldown: { seconds: 5, scope: 'user' } },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'set') return handleSet(c);
    if (sub === 'list') return handleList(c);
    return handleCancel(c);
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    const query = String(focused.value).toLowerCase();
    const reminders = await c.ctx.prisma.reminder.findMany({
      where: { userId: c.interaction.user.id, guildId: c.guildId, delivered: false },
      orderBy: { remindAt: 'asc' },
      take: 25,
    });
    const matches = reminders.filter((r) => r.content.toLowerCase().includes(query) || r.id.includes(query));
    await c.interaction.respond(matches.map((r) => ({ name: r.content.slice(0, 100), value: r.id })));
  },
};
