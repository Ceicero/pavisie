import {
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  SlashCommandBuilder,
} from 'discord.js';
import {
  errorEmbed,
  infoEmbed,
  listEmbed,
  resolveTextChannel,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import { cancelEvent } from '../actions';
import { isInThePast, isMissingChannelPermission, nonBlank } from '../command-input';
import { buildEventComponents, buildEventEmbed, summarizeRsvps } from '../render';
import { parseAt } from '../schedule';
import type { CommunityConfig } from '../manifest';
import { upcomingReminderMinutes } from '../service';

const data = new SlashCommandBuilder()
  .setName('event')
  .setDescription('Community events with RSVP.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create an event.')
      .addStringOption((opt) =>
        opt.setName('title').setDescription('Event title').setRequired(true).setMaxLength(100),
      )
      .addStringOption((opt) =>
        opt
          .setName('starts-at')
          .setDescription('When it starts: an ISO date/time or a duration like "2h"')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('ends-at')
          .setDescription('When it ends: an ISO date/time or a duration')
          .setRequired(false),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to announce and RSVP in (default: this channel)')
          .setRequired(false)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addStringOption((opt) =>
        opt.setName('description').setDescription('Event description').setRequired(false).setMaxLength(1000),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('create-discord-event')
          .setDescription('Also create a native Discord scheduled event (default: off)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List upcoming events.'))
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel an event.')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Event id').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rsvps')
      .setDescription('Show RSVP counts for an event.')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Event id').setRequired(true).setAutocomplete(true),
      ),
  );

async function handleCreate(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const config = await c.config<CommunityConfig>();

  const title = nonBlank(interaction.options.getString('title', true));
  if (!title) {
    await interaction.reply({ embeds: [errorEmbed(t('event.emptyTitle'))], ephemeral: true });
    return;
  }
  const startsAtStr = interaction.options.getString('starts-at', true);
  const endsAtStr = interaction.options.getString('ends-at');
  const description = interaction.options.getString('description');
  const createDiscordEvent = interaction.options.getBoolean('create-discord-event') ?? false;
  const channelOption = interaction.options.getChannel('channel');
  const channelId = channelOption?.id ?? interaction.channelId;

  const host = ctx.services.get('host');
  const timezone = host ? (await host.getGuildConfig(guildId)).timezone : 'UTC';

  const startsAt = parseAt(startsAtStr, timezone);
  if (!startsAt.ok) {
    await interaction.reply({ embeds: [errorEmbed(startsAt.reason)], ephemeral: true });
    return;
  }
  if (isInThePast(startsAt.date)) {
    await interaction.reply({ embeds: [errorEmbed(t('event.past'))], ephemeral: true });
    return;
  }
  let endsAt: Date | null = null;
  if (endsAtStr) {
    const parsedEnd = parseAt(endsAtStr, timezone);
    if (!parsedEnd.ok) {
      await interaction.reply({ embeds: [errorEmbed(parsedEnd.reason)], ephemeral: true });
      return;
    }
    endsAt = parsedEnd.date;
    if (endsAt.getTime() <= startsAt.date.getTime()) {
      await interaction.reply({ embeds: [errorEmbed(t('event.endsBeforeStart'))], ephemeral: true });
      return;
    }
  }

  const channel = await resolveTextChannel(interaction.guild, channelId);
  if (!channel) {
    await interaction.reply({ embeds: [errorEmbed(t('event.badChannel'))], ephemeral: true });
    return;
  }

  let discordEventId: string | null = null;
  let discordEventFailed = false;
  if (createDiscordEvent) {
    try {
      const scheduledEvent = await interaction.guild.scheduledEvents.create({
        name: title,
        scheduledStartTime: startsAt.date,
        scheduledEndTime: endsAt ?? new Date(startsAt.date.getTime() + 60 * 60 * 1000),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: `#${channel.name}` },
        description: description ?? undefined,
      });
      discordEventId = scheduledEvent.id;
    } catch (err) {
      discordEventFailed = true;
      ctx.logger.warn({ err, guildId }, 'community: failed to create a native Discord scheduled event');
    }
  }

  let createdEventId: string | null = null;
  let messageId: string | null = null;
  try {
    const event = await ctx.prisma.communityEvent.create({
      data: {
        guildId,
        title,
        description,
        startsAt: startsAt.date,
        endsAt,
        channelId: channel.id,
        hostId: interaction.user.id,
        discordEventId,
        reminderMinutes: config.eventReminderMinutes,
      },
    });
    createdEventId = event.id;

    const message = await channel.send({
      embeds: [buildEventEmbed(event, { going: 0, maybe: 0, declined: 0 })],
      components: buildEventComponents(event.id, false),
    });
    messageId = message.id;
    const updated = await ctx.prisma.communityEvent.update({
      where: { id: event.id },
      data: { messageId: message.id },
    });

    const queue = ctx.queue('event-reminder');
    for (const minutes of upcomingReminderMinutes(config.eventReminderMinutes, updated.startsAt, new Date())) {
      const fireAt = updated.startsAt.getTime() - minutes * 60_000;
      await queue.add(
        'event-reminder',
        { eventId: updated.id, minutesBefore: minutes },
        { jobId: `ev-${updated.id}-${minutes}`, delay: Math.max(0, fireAt - Date.now()) },
      );
    }
  } catch (err) {
    if (messageId) await channel.messages.delete(messageId).catch(() => undefined);
    if (createdEventId) {
      await ctx.prisma.communityEvent.delete({ where: { id: createdEventId } }).catch(() => undefined);
    }
    if (discordEventId) await interaction.guild.scheduledEvents.delete(discordEventId).catch(() => undefined);
    ctx.logger.warn({ err, guildId }, 'community: failed to post an event');
    const key = isMissingChannelPermission(err) ? 'event.badChannel' : 'event.postFailed';
    await interaction.reply({ embeds: [errorEmbed(t(key))], ephemeral: true });
    return;
  }

  const note = discordEventFailed ? `\n${t('event.discordEventFailed')}` : '';
  await interaction.reply({
    embeds: [successEmbed(t('event.created', { channel: `<#${channel.id}>` }) + note)],
    ephemeral: true,
  });
}

async function handleList(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const events = await ctx.prisma.communityEvent.findMany({
    where: { guildId, startsAt: { gte: new Date() } },
    orderBy: { startsAt: 'asc' },
    take: 25,
  });
  if (events.length === 0) {
    await interaction.reply({
      embeds: [infoEmbed(t('event.listTitle'), t('event.listEmpty'))],
      ephemeral: true,
    });
    return;
  }
  const lines = events.map((e) => `📅 **${e.title}** — ${e.startsAt.toISOString()} · \`${e.id}\``);
  await interaction.reply({ embeds: [listEmbed(t('event.listTitle'), lines)], ephemeral: true });
}

async function handleCancel(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const id = interaction.options.getString('id', true);
  const event = await ctx.prisma.communityEvent.findFirst({ where: { id, guildId } });
  if (!event) {
    await interaction.reply({ embeds: [errorEmbed(t('event.notFound'))], ephemeral: true });
    return;
  }
  await cancelEvent(ctx, event.id);
  await interaction.reply({ embeds: [successEmbed(t('event.cancelled'))], ephemeral: true });
}

async function handleRsvps(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const id = interaction.options.getString('id', true);
  const event = await ctx.prisma.communityEvent.findFirst({ where: { id, guildId } });
  if (!event) {
    await interaction.reply({ embeds: [errorEmbed(t('event.notFound'))], ephemeral: true });
    return;
  }
  const rsvps = await ctx.prisma.eventRsvp.findMany({ where: { eventId: event.id } });
  const counts = summarizeRsvps(rsvps);
  await interaction.reply({ embeds: [buildEventEmbed(event, counts)], ephemeral: true });
}

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'helper', guildOnly: true },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'create') return handleCreate(c);
    if (sub === 'list') return handleList(c);
    if (sub === 'cancel') return handleCancel(c);
    return handleRsvps(c);
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    const query = String(focused.value).toLowerCase();
    const events = await c.ctx.prisma.communityEvent.findMany({
      where: { guildId: c.guildId },
      orderBy: { startsAt: 'desc' },
      take: 50,
    });
    const matches = events
      .filter((e) => e.title.toLowerCase().includes(query) || e.id.includes(query))
      .slice(0, 25);
    await c.interaction.respond(matches.map((e) => ({ name: e.title.slice(0, 100), value: e.id })));
  },
};
