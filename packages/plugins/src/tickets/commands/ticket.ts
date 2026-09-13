import {
  ActionRowBuilder,
  ChannelType,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Role,
  type TextChannel,
} from 'discord.js';
import { PermissionError, ValidationError, hasStaffLevel, sanitizeFilename } from '@pavisie/core';
import {
  PendingStore,
  assertStaffLevel,
  buildCustomId,
  errorEmbed,
  infoEmbed,
  listEmbed,
  requestConfirmation,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import type { TicketsConfig } from '../manifest';
import {
  addTicketParticipant,
  addTicketTag,
  assignTicket,
  closeTicketCore,
  fetchTicketMessages,
  findTicketForChannel,
  openTicket,
  removeTicketParticipant,
  removeTicketTag,
  reopenTicketCore,
} from '../service';
import { buildHtmlTranscript, buildJsonTranscript, type TranscriptTicketMeta } from '../transcript';

const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Open, manage, and configure support tickets.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('open')
      .setDescription('Open a new support ticket.')
      .addStringOption((opt) =>
        opt
          .setName('subject')
          .setDescription('A short summary of what you need help with')
          .setRequired(false)
          .setMaxLength(200),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Close this ticket.')
      .addStringOption((opt) =>
        opt
          .setName('reason')
          .setDescription('Why this ticket is being closed')
          .setRequired(false)
          .setMaxLength(1000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a user to this ticket.')
      .addUserOption((opt) => opt.setName('user').setDescription('User to add').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a user from this ticket.')
      .addUserOption((opt) => opt.setName('user').setDescription('User to remove').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('transcript')
      .setDescription('Get a ticket transcript (sent to you privately).')
      .addIntegerOption((opt) =>
        opt
          .setName('number')
          .setDescription("Ticket number (defaults to this channel's ticket)")
          .setRequired(false)
          .setMinValue(1)
          .setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('format')
          .setDescription('Transcript format (default HTML)')
          .setRequired(false)
          .addChoices({ name: 'HTML', value: 'html' }, { name: 'JSON', value: 'json' }),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('assign')
      .setDescription('Assign this ticket to a staff member.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Staff member to assign (omit to unassign)').setRequired(false),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('tag')
      .setDescription("Manage this ticket's tags.")
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a tag.')
          .addStringOption((opt) =>
            opt.setName('tag').setDescription('Tag text').setRequired(true).setMaxLength(32),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a tag.')
          .addStringOption((opt) =>
            opt.setName('tag').setDescription('Tag text').setRequired(true).setMaxLength(32),
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reopen')
      .setDescription('Reopen a recently-closed ticket.')
      .addIntegerOption((opt) =>
        opt
          .setName('number')
          .setDescription('Ticket number')
          .setRequired(true)
          .setMinValue(1)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('config').setDescription('View the tickets configuration.'))
  .addSubcommandGroup((group) =>
    group
      .setName('panel')
      .setDescription('Manage ticket panels.')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create a ticket panel (a form for the title/description/button text opens next).')
          .addChannelOption((opt) =>
            // Private threads (thread mode) are a GUILD_TEXT-only Discord feature, so the panel channel is
            // restricted to plain text channels regardless of which mode ends up chosen.
            opt
              .setName('channel')
              .setDescription('Channel to post the panel in')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText),
          )
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('How tickets from this panel are opened')
              .setRequired(true)
              .addChoices(
                { name: 'Private channel', value: 'CHANNEL' },
                { name: 'Private thread', value: 'THREAD' },
              ),
          )
          .addChannelOption((opt) =>
            opt
              .setName('category')
              .setDescription('Category new ticket channels are created under (channel mode)')
              .setRequired(false)
              .addChannelTypes(ChannelType.GuildCategory),
          )
          .addRoleOption((opt) =>
            opt
              .setName('support_role_1')
              .setDescription('Support role with access to tickets from this panel')
              .setRequired(false),
          )
          .addRoleOption((opt) =>
            opt.setName('support_role_2').setDescription('Second support role').setRequired(false),
          )
          .addRoleOption((opt) =>
            opt.setName('support_role_3').setDescription('Third support role').setRequired(false),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('sla_minutes')
              .setDescription(
                'Minutes before an unanswered ticket is flagged overdue (overrides the default)',
              )
              .setRequired(false)
              .setMinValue(1)
              .setMaxValue(43200),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('intake')
              .setDescription(
                "Ask the server's configured intake-form questions when opening from this panel",
              )
              .setRequired(false),
          ),
      ),
  );

function ticketMetaOf(ticket: {
  number: number;
  guildId: string;
  openerId: string;
  subject: string | null;
  status: string;
  mode: string;
  createdAt: Date;
  closedAt: Date | null;
  closedBy: string | null;
  closeReason: string | null;
  tags: string[];
  intake: unknown;
}): TranscriptTicketMeta {
  return {
    number: ticket.number,
    guildId: ticket.guildId,
    openerId: ticket.openerId,
    subject: ticket.subject,
    status: ticket.status,
    mode: ticket.mode,
    createdAt: ticket.createdAt.toISOString(),
    closedAt: ticket.closedAt ? ticket.closedAt.toISOString() : null,
    closedBy: ticket.closedBy,
    closeReason: ticket.closeReason,
    tags: ticket.tags,
    intake: (ticket.intake as Record<string, string> | null) ?? null,
  };
}

async function handleOpen(c: CommandContext): Promise<void> {
  const subject = c.interaction.options.getString('subject', false);
  await c.interaction.deferReply({ ephemeral: true });
  const ticket = await openTicket(c.ctx, {
    guildId: c.guildId,
    openerId: c.interaction.user.id,
    subject,
    intake: null,
    panel: null,
    parentChannelId: c.interaction.channelId,
  });
  const location = ticket.channelId
    ? `<#${ticket.channelId}>`
    : ticket.threadId
      ? `<#${ticket.threadId}>`
      : 'a new location';
  await c.interaction.editReply({
    embeds: [successEmbed(`Opened ticket #${ticket.number} in ${location}.`)],
  });
}

async function handleClose(c: CommandContext): Promise<void> {
  const ticket = await findTicketForChannel(c.ctx, c.guildId, c.interaction.channelId);
  if (!ticket) {
    await c.interaction.reply({ embeds: [errorEmbed('This is not a ticket channel.')], ephemeral: true });
    return;
  }
  if (ticket.status !== 'OPEN') {
    await c.interaction.reply({ embeds: [errorEmbed('This ticket is already closed.')], ephemeral: true });
    return;
  }
  if (ticket.openerId !== c.interaction.user.id && !hasStaffLevel(c.staffLevel, 'helper')) {
    throw new PermissionError('Only the ticket opener or support staff can close this ticket.');
  }

  const reason = c.interaction.options.getString('reason', false) ?? undefined;
  const host = c.ctx.services.get('host');
  const fastActions = host ? (await host.getGuildConfig(c.guildId)).fastActions : false;

  const result = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'tickets',
    action: 'close-ticket',
    ownerId: c.interaction.user.id,
    embed: infoEmbed('Close this ticket?', reason ? `Reason: ${reason}` : 'No reason given.'),
    payload: { ticketId: ticket.id, reason },
    fastActions,
  });

  if (result.confirmed) {
    await c.interaction.reply({ embeds: [successEmbed('Closing this ticket…')], ephemeral: true });
    await closeTicketCore(c.ctx, {
      guildId: c.guildId,
      ticketId: ticket.id,
      closedBy: c.interaction.user.id,
      reason,
      source: 'bot',
    });
  }
}

async function handleAdd(c: CommandContext): Promise<void> {
  const ticket = await findTicketForChannel(c.ctx, c.guildId, c.interaction.channelId);
  if (!ticket) {
    await c.interaction.reply({ embeds: [errorEmbed('This is not a ticket channel.')], ephemeral: true });
    return;
  }
  const user = c.interaction.options.getUser('user', true);
  await addTicketParticipant(c.ctx, c.guildId, ticket.id, user.id, c.interaction.user.id);
  await c.interaction.reply({
    embeds: [successEmbed(`Added <@${user.id}> to this ticket.`)],
    ephemeral: true,
  });
}

async function handleRemove(c: CommandContext): Promise<void> {
  const ticket = await findTicketForChannel(c.ctx, c.guildId, c.interaction.channelId);
  if (!ticket) {
    await c.interaction.reply({ embeds: [errorEmbed('This is not a ticket channel.')], ephemeral: true });
    return;
  }
  const user = c.interaction.options.getUser('user', true);
  await removeTicketParticipant(c.ctx, c.guildId, ticket.id, user.id, c.interaction.user.id);
  await c.interaction.reply({
    embeds: [successEmbed(`Removed <@${user.id}> from this ticket.`)],
    ephemeral: true,
  });
}

async function handleTranscript(c: CommandContext): Promise<void> {
  const numberOpt = c.interaction.options.getInteger('number', false);
  const format = (c.interaction.options.getString('format', false) ?? 'html') as 'html' | 'json';

  const ticket =
    numberOpt !== null
      ? await c.ctx.prisma.ticket.findFirst({ where: { guildId: c.guildId, number: numberOpt } })
      : await findTicketForChannel(c.ctx, c.guildId, c.interaction.channelId);

  if (!ticket) {
    await c.interaction.reply({ embeds: [errorEmbed('Ticket not found.')], ephemeral: true });
    return;
  }
  if (ticket.openerId !== c.interaction.user.id && !hasStaffLevel(c.staffLevel, 'helper')) {
    throw new PermissionError('Only the ticket opener or support staff can view this transcript.');
  }

  await c.interaction.deferReply({ ephemeral: true });

  const stored = await c.ctx.prisma.ticketTranscript.findUnique({ where: { ticketId: ticket.id } });
  let html: string;
  let json: unknown;
  if (stored) {
    html = stored.htmlContent ?? '<!doctype html><title>No transcript</title>';
    json = stored.jsonContent ?? {};
  } else {
    const guild = await c.ctx.client.guilds.fetch(c.guildId);
    const messages = await fetchTicketMessages(guild, ticket);
    const meta = ticketMetaOf(ticket);
    html = buildHtmlTranscript(meta, messages);
    json = buildJsonTranscript(meta, messages);
  }

  const filename = sanitizeFilename(`ticket-${ticket.number}-transcript`);
  if (format === 'json') {
    await c.interaction.editReply({
      files: [{ attachment: Buffer.from(JSON.stringify(json, null, 2), 'utf8'), name: `${filename}.json` }],
    });
  } else {
    await c.interaction.editReply({
      files: [{ attachment: Buffer.from(html, 'utf8'), name: `${filename}.html` }],
    });
  }
}

async function handleAssign(c: CommandContext): Promise<void> {
  const ticket = await findTicketForChannel(c.ctx, c.guildId, c.interaction.channelId);
  if (!ticket) {
    await c.interaction.reply({ embeds: [errorEmbed('This is not a ticket channel.')], ephemeral: true });
    return;
  }
  const user = c.interaction.options.getUser('user', false);
  await assignTicket(c.ctx, c.guildId, ticket.id, user?.id ?? null, c.interaction.user.id);
  await c.interaction.reply({
    embeds: [successEmbed(user ? `Assigned to <@${user.id}>.` : 'Unassigned this ticket.')],
    ephemeral: true,
  });
}

async function handleTag(c: CommandContext, action: string): Promise<void> {
  const ticket = await findTicketForChannel(c.ctx, c.guildId, c.interaction.channelId);
  if (!ticket) {
    await c.interaction.reply({ embeds: [errorEmbed('This is not a ticket channel.')], ephemeral: true });
    return;
  }
  const tag = c.interaction.options.getString('tag', true);
  const updated =
    action === 'add'
      ? await addTicketTag(c.ctx, c.guildId, ticket.id, tag, c.interaction.user.id)
      : await removeTicketTag(c.ctx, c.guildId, ticket.id, tag, c.interaction.user.id);
  await c.interaction.reply({
    embeds: [successEmbed(`Tags: ${updated.tags.length > 0 ? updated.tags.join(', ') : '_none_'}`)],
    ephemeral: true,
  });
}

async function handleReopen(c: CommandContext): Promise<void> {
  const number = c.interaction.options.getInteger('number', true);
  const ticket = await c.ctx.prisma.ticket.findFirst({ where: { guildId: c.guildId, number } });
  if (!ticket) {
    await c.interaction.reply({ embeds: [errorEmbed(`No ticket #${number} found.`)], ephemeral: true });
    return;
  }
  if (ticket.openerId !== c.interaction.user.id && !hasStaffLevel(c.staffLevel, 'helper')) {
    throw new PermissionError('Only the ticket opener or support staff can reopen this ticket.');
  }

  await c.interaction.deferReply({ ephemeral: true });
  const updated = await reopenTicketCore(c.ctx, {
    guildId: c.guildId,
    ticketId: ticket.id,
    reopenedBy: c.interaction.user.id,
  });
  const location = updated.channelId
    ? `<#${updated.channelId}>`
    : updated.threadId
      ? `<#${updated.threadId}>`
      : 'its original location';
  await c.interaction.editReply({
    embeds: [successEmbed(`Reopened ticket #${updated.number} in ${location}.`)],
  });
}

async function handleConfigView(c: CommandContext): Promise<void> {
  const config = await c.config<TicketsConfig>();
  const lines = [
    `Mode: ${config.mode}`,
    `Support roles: ${config.supportRoleIds.length > 0 ? config.supportRoleIds.map((id) => `<@&${id}>`).join(', ') : '_None_'}`,
    `Category: ${config.categoryId ? `<#${config.categoryId}>` : '_None_'}`,
    `Transcript channel: ${config.transcriptChannelId ? `<#${config.transcriptChannelId}>` : '_None_'}`,
    `Transcript retention: ${config.transcriptRetentionDays} days`,
    `DM transcript to opener: ${config.dmTranscript ? 'On' : 'Off'}`,
    `Default SLA: ${config.slaMinutes ? `${config.slaMinutes}m` : '_None_'}`,
    `Max open tickets per user: ${config.maxOpenPerUser}`,
    `Reopen window: ${config.reopenWindowHours}h`,
    `Delete closed channel after: ${config.keepClosedChannels ? 'Never (kept)' : `${config.deleteAfterCloseSeconds}s`}`,
    `Intake form questions: ${config.intakeForm.length}`,
    `Alert channel: ${config.alertChannelId ? `<#${config.alertChannelId}>` : '_None_'}`,
  ];
  await c.interaction.reply({ embeds: [listEmbed('Ticket settings', lines)], ephemeral: true });
}

async function handlePanelCreate(c: CommandContext): Promise<void> {
  const channel = c.interaction.options.getChannel('channel', true) as TextChannel;
  const mode = c.interaction.options.getString('mode', true) as 'CHANNEL' | 'THREAD';
  const category = c.interaction.options.getChannel('category', false);
  const roleIds = [
    c.interaction.options.getRole('support_role_1', false),
    c.interaction.options.getRole('support_role_2', false),
    c.interaction.options.getRole('support_role_3', false),
  ]
    .filter((role): role is Role => role !== null)
    .map((role) => role.id);
  const slaMinutes = c.interaction.options.getInteger('sla_minutes', false);
  const intake = c.interaction.options.getBoolean('intake', false) ?? false;

  if (mode === 'THREAD' && !('threads' in channel)) {
    await c.interaction.reply({
      embeds: [errorEmbed('Thread-mode panels need a text or announcement channel.')],
      ephemeral: true,
    });
    return;
  }

  const pendingStore = new PendingStore(c.ctx.redis);
  const pendingId = await pendingStore.put(
    {
      channelId: channel.id,
      categoryId: category?.id ?? null,
      supportRoleIds: [...new Set(roleIds)].slice(0, 3),
      mode,
      slaMinutes: slaMinutes ?? null,
      intake,
    },
    300,
  );

  const modal = new ModalBuilder()
    .setCustomId(buildCustomId('tickets', 'panel-create-modal', c.interaction.user.id, pendingId))
    .setTitle('Create a ticket panel')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('title')
          .setLabel('Panel title')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Panel description')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(2000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('buttonLabel')
          .setLabel('Button label')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue('Open a ticket'),
      ),
    );

  await c.interaction.showModal(modal);
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true, cooldown: { seconds: 3, scope: 'user' } },
  async execute(c) {
    const group = c.interaction.options.getSubcommandGroup(false);
    const sub = c.interaction.options.getSubcommand(true);

    if (group === 'panel') {
      assertStaffLevel(c.staffLevel, 'moderator', c.t);
      if (sub === 'create') return handlePanelCreate(c);
      return;
    }
    if (group === 'tag') {
      assertStaffLevel(c.staffLevel, 'helper', c.t);
      return handleTag(c, sub);
    }

    switch (sub) {
      case 'open':
        return handleOpen(c);
      case 'close':
        return handleClose(c);
      case 'add':
        assertStaffLevel(c.staffLevel, 'helper', c.t);
        return handleAdd(c);
      case 'remove':
        assertStaffLevel(c.staffLevel, 'helper', c.t);
        return handleRemove(c);
      case 'transcript':
        return handleTranscript(c);
      case 'assign':
        assertStaffLevel(c.staffLevel, 'helper', c.t);
        return handleAssign(c);
      case 'reopen':
        return handleReopen(c);
      case 'config':
        assertStaffLevel(c.staffLevel, 'moderator', c.t);
        return handleConfigView(c);
      default:
        throw new ValidationError(`Unknown subcommand "${sub}".`);
    }
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    if (focused.name !== 'number') {
      await c.interaction.respond([]);
      return;
    }
    const staff = hasStaffLevel(c.staffLevel, 'helper');
    const tickets = await c.ctx.prisma.ticket.findMany({
      where: staff ? { guildId: c.guildId } : { guildId: c.guildId, openerId: c.interaction.user.id },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    const query = String(focused.value ?? '');
    const matches = tickets.filter((t) => String(t.number).includes(query)).slice(0, 25);
    await c.interaction.respond(
      matches.map((t) => ({
        name: `#${t.number}${t.subject ? ` — ${t.subject}` : ''} (${t.status})`,
        value: t.number,
      })),
    );
  },
};
