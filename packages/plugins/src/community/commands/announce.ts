import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Prisma } from '@pavisie/database';
import {
  errorEmbed,
  infoEmbed,
  listEmbed,
  resolveTextChannel,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import { cancelAnnouncement, type AnnouncementContent } from '../actions';
import { parseSchedule } from '../schedule';

const data = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Schedule announcements.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('schedule')
      .setDescription('Schedule an announcement.')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to post in')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addStringOption((opt) =>
        opt
          .setName('when')
          .setDescription('A cron expression, an ISO date/time, or a duration like "10m"/"2h"')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('message').setDescription('The message to send').setRequired(true).setMaxLength(2000),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List scheduled announcements.'))
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel a scheduled announcement.')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Announcement id').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('preview')
      .setDescription('Preview a scheduled announcement.')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Announcement id').setRequired(true).setAutocomplete(true),
      ),
  );

async function handleSchedule(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const channel = interaction.options.getChannel('channel', true);
  const when = interaction.options.getString('when', true);
  const message = interaction.options.getString('message', true);

  const host = ctx.services.get('host');
  const timezone = host ? (await host.getGuildConfig(guildId)).timezone : 'UTC';

  const parsed = parseSchedule(when, timezone);
  if (parsed.kind === 'invalid') {
    await interaction.reply({ embeds: [errorEmbed(parsed.reason)], ephemeral: true });
    return;
  }

  const targetChannel = await resolveTextChannel(interaction.guild, channel.id);
  if (!targetChannel) {
    await interaction.reply({ embeds: [errorEmbed(t('announce.badChannel'))], ephemeral: true });
    return;
  }

  const content: AnnouncementContent = { content: message };
  const announcement = await ctx.prisma.scheduledAnnouncement.create({
    data: {
      guildId,
      channelId: channel.id,
      content: content as unknown as Prisma.InputJsonValue,
      cron: parsed.kind === 'cron' ? parsed.cron : null,
      runAt: parsed.kind === 'at' ? parsed.runAt : null,
      createdBy: interaction.user.id,
    },
  });

  const queue = ctx.queue('announcement-run');
  if (parsed.kind === 'cron') {
    await queue.upsertJobScheduler(
      `ann-${announcement.id}`,
      { pattern: parsed.cron, tz: timezone },
      { name: 'announcement-run', data: { announcementId: announcement.id } },
    );
  } else {
    await queue.add(
      'announcement-run',
      { announcementId: announcement.id },
      { jobId: `ann-${announcement.id}`, delay: Math.max(0, parsed.runAt.getTime() - Date.now()) },
    );
  }

  const when_ =
    parsed.kind === 'cron'
      ? t('announce.scheduledCron', { cron: parsed.cron })
      : t('announce.scheduledAt', { time: parsed.runAt.toISOString() });
  await interaction.reply({
    embeds: [successEmbed(`${t('announce.scheduled', { channel: `<#${channel.id}>` })} ${when_}`)],
    ephemeral: true,
  });
}

async function handleList(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const rows = await ctx.prisma.scheduledAnnouncement.findMany({
    where: { guildId },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  const lines = rows.map((a) => {
    const body = a.content as unknown as AnnouncementContent | null;
    const preview = body?.content ? body.content.slice(0, 40) : '(empty)';
    const schedule = a.cron
      ? `cron \`${a.cron}\``
      : a.runAt
        ? `once at ${a.runAt.toISOString()}`
        : 'unscheduled';
    return `${a.enabled ? '🟢' : '⚪'} **${preview}${(body?.content?.length ?? 0) > 40 ? '…' : ''}** in <#${a.channelId}> — ${schedule} · \`${a.id}\``;
  });
  await interaction.reply({ embeds: [listEmbed(t('announce.listTitle'), lines)], ephemeral: true });
}

async function handleCancel(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const id = interaction.options.getString('id', true);
  const announcement = await ctx.prisma.scheduledAnnouncement.findFirst({ where: { id, guildId } });
  if (!announcement) {
    await interaction.reply({ embeds: [errorEmbed(t('announce.notFound'))], ephemeral: true });
    return;
  }
  await cancelAnnouncement(ctx, announcement.id, announcement.cron);
  await interaction.reply({ embeds: [successEmbed(t('announce.cancelled'))], ephemeral: true });
}

async function handlePreview(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const id = interaction.options.getString('id', true);
  const announcement = await ctx.prisma.scheduledAnnouncement.findFirst({ where: { id, guildId } });
  if (!announcement) {
    await interaction.reply({ embeds: [errorEmbed(t('announce.notFound'))], ephemeral: true });
    return;
  }
  const body = announcement.content as unknown as AnnouncementContent | null;
  await interaction.reply({
    embeds: [infoEmbed(t('announce.previewTitle'), body?.content ?? '_Empty_')],
    ephemeral: true,
  });
}

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'moderator', guildOnly: true },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'schedule') return handleSchedule(c);
    if (sub === 'list') return handleList(c);
    if (sub === 'cancel') return handleCancel(c);
    return handlePreview(c);
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    const query = String(focused.value).toLowerCase();
    const rows = await c.ctx.prisma.scheduledAnnouncement.findMany({
      where: { guildId: c.guildId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const matches = rows
      .filter(
        (a) =>
          a.id.includes(query) ||
          ((a.content as unknown as AnnouncementContent | null)?.content ?? '').toLowerCase().includes(query),
      )
      .slice(0, 25);
    await c.interaction.respond(
      matches.map((a) => ({
        name: `${(a.content as unknown as AnnouncementContent | null)?.content ?? a.id}`.slice(0, 100),
        value: a.id,
      })),
    );
  },
};
