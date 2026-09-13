// Core ticket business logic: opening, closing, reopening, panels, participants, and tags. `createTicketsService`
// wraps the subset of this declared by `ServiceMap['tickets']` (packages/plugins/src/sdk/services.ts) for
// registration via `ctx.services.register('tickets', ...)`; commands/components call the richer functions below
// directly (they need panel-specific overrides and Discord interaction context the narrow service interface
// doesn't carry).
import { AttachmentBuilder, ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { AppError, NotFoundError, ValidationError, redisKey, sanitizeFilename } from '@pavisie/core';
import type { Prisma, Ticket, TicketPanel } from '@pavisie/database';
import type { CreateTicketInput, PluginContext, TicketsService } from '../sdk';
import { assertBotPermissions, fetchMemberSafe, resolveTextChannel, safeDm } from '../sdk';
import { ticketChannelName } from './channel-name';
import {
  buildClosingSummaryEmbed,
  buildOpeningButtons,
  buildOpeningEmbed,
  buildPanelButtons,
  buildPanelEmbed,
  buildReopenButton,
} from './embeds';
import { validateIntakeAnswers } from './intake';
import type { TicketIntakeField, TicketsConfig } from './manifest';
import { withNextTicketNumber } from './number';
import { buildTicketChannelOverwrites } from './permissions';
import { isWithinReopenWindow } from './reopen';
import { computeSlaDueAt } from './sla';
import { buildHtmlTranscript, buildJsonTranscript, type TranscriptMessage } from './transcript';

const TICKETS_PLUGIN_ID = 'tickets';
const MAX_TRANSCRIPT_MESSAGES = 1000;
const MESSAGE_FETCH_PAGE = 100;
const TICKET_OPEN_LOCK_TTL_MS = 30_000; // 30 seconds; enough time to count + create + update

function intakeFormOf(panel: Pick<TicketPanel, 'intakeForm'> | null | undefined): TicketIntakeField[] {
  if (!panel?.intakeForm) return [];
  return panel.intakeForm as unknown as TicketIntakeField[];
}

function authorTagOf(user: { username: string; discriminator: string }): string {
  return user.discriminator && user.discriminator !== '0'
    ? `${user.username}#${user.discriminator}`
    : user.username;
}

/** Fetches up to `MAX_TRANSCRIPT_MESSAGES` messages from a ticket's channel/thread, oldest last (Discord's default), for transcript building. */
async function fetchTicketMessages(
  guild: Guild,
  ticket: Pick<Ticket, 'channelId' | 'threadId'>,
): Promise<TranscriptMessage[]> {
  const channelId = ticket.threadId ?? ticket.channelId;
  if (!channelId) return [];

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return [];

  const collected: TranscriptMessage[] = [];
  let before: string | undefined;

  while (collected.length < MAX_TRANSCRIPT_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: MESSAGE_FETCH_PAGE, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

    for (const message of batch.values()) {
      collected.push({
        id: message.id,
        authorId: message.author.id,
        authorTag: authorTagOf(message.author),
        content: message.content ?? '',
        createdAt: message.createdAt.toISOString(),
        editedAt: message.editedTimestamp ? new Date(message.editedTimestamp).toISOString() : null,
        attachments: [...message.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
      });
    }

    before = batch.last()?.id;
    if (batch.size < MESSAGE_FETCH_PAGE) break;
  }

  // Discord returns newest-first per page; sort ascending (oldest first) for a readable transcript.
  return collected.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface OpenTicketParams {
  guildId: string;
  openerId: string;
  subject?: string | null;
  intake?: Record<string, string> | null;
  panel?: TicketPanel | null;
  /** Parent channel to create a THREAD in when not opened from a panel (e.g. the channel `/ticket open` ran in). */
  parentChannelId?: string | null;
}

/** Opens a ticket: allocates its number, creates the channel/thread with the right overwrites, and posts the opening embed. */
export async function openTicket(ctx: PluginContext, params: OpenTicketParams): Promise<Ticket> {
  // Serialize concurrent ticket open attempts for this user in this guild using a short-lived Redis lock.
  // This prevents race conditions where two rapid button clicks both pass the open-count check before either
  // creates a ticket, resulting in duplicates even when the limit is 1.
  const lockKey = redisKey('tickets', 'open-lock', params.guildId, params.openerId);
  const acquired = await ctx.redis.set(lockKey, '1', 'PX', TICKET_OPEN_LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    throw new ValidationError(
      'You are already opening a ticket. Please wait a moment and try again.',
    );
  }

  try {
    const config = await ctx.getConfig<TicketsConfig>(params.guildId);

    const openCount = await ctx.prisma.ticket.count({
      where: { guildId: params.guildId, openerId: params.openerId, status: 'OPEN' },
    });
    if (openCount >= config.maxOpenPerUser) {
      throw new ValidationError(
        config.maxOpenPerUser === 1
          ? 'You already have an open ticket. Close it before opening another one.'
          : `You already have ${openCount} open tickets (limit ${config.maxOpenPerUser}). Close one before opening another.`,
      );
    }

    const intakeFields = intakeFormOf(params.panel);
    if (intakeFields.length > 0 && params.intake) {
      validateIntakeAnswers(intakeFields, params.intake);
    }

    const mode: Ticket['mode'] = params.panel
      ? params.panel.mode
      : config.mode === 'thread'
        ? 'THREAD'
        : 'CHANNEL';
    const supportRoleIds = params.panel ? params.panel.supportRoleIds : config.supportRoleIds;
    const categoryId = params.panel ? params.panel.categoryId : config.categoryId;
    const slaMinutes = params.panel ? (params.panel.slaMinutes ?? config.slaMinutes) : config.slaMinutes;

    const guild = await ctx.client.guilds.fetch(params.guildId);
    const openerMember = await fetchMemberSafe(guild, params.openerId);
    const openerUser = openerMember?.user ?? (await ctx.client.users.fetch(params.openerId));

    const now = new Date();
    const created = await withNextTicketNumber(ctx.prisma, params.guildId, (number) =>
      ctx.prisma.ticket.create({
        data: {
          guildId: params.guildId,
          number,
          openerId: params.openerId,
          mode,
          status: 'OPEN',
          subject: params.subject?.trim() || null,
          intake: params.intake ? (params.intake as Prisma.InputJsonValue) : undefined,
          panelId: params.panel?.id ?? null,
          slaDueAt: computeSlaDueAt(now, slaMinutes),
        },
      }),
    );

    let channelId: string | null = null;
    let threadId: string | null = null;

    try {
      if (mode === 'CHANNEL') {
        assertBotPermissions(
          guild,
          [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
          ctx.t,
        );
        const name = ticketChannelName(created.number, openerUser.username);
        const overwrites = buildTicketChannelOverwrites({
          everyoneRoleId: guild.roles.everyone.id,
          openerId: params.openerId,
          supportRoleIds,
          botId: ctx.client.user.id,
        });
        const channel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: categoryId ?? undefined,
          permissionOverwrites: overwrites.map((o) => ({ id: o.id, allow: o.allow, deny: o.deny })),
          reason: `Ticket #${created.number} opened by ${openerUser.username} (${params.openerId})`,
        });
        channelId = channel.id;
      } else {
        const parentChannelId = params.panel ? params.panel.channelId : params.parentChannelId;
        if (!parentChannelId) {
          throw new ValidationError(
            'Thread-mode tickets need a parent text channel. Run `/ticket open` in a text channel, or use a ticket panel.',
          );
        }
        assertBotPermissions(
          guild,
          [PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.ManageThreads],
          ctx.t,
        );
        const parent = await guild.channels.fetch(parentChannelId).catch(() => null);
        // Private threads are a GUILD_TEXT-only feature (Discord does not support them in announcement channels),
        // so the parent must be a plain text channel regardless of what channel types the panel-creation command
        // let staff pick for its `channel` option.
        if (!parent || parent.type !== ChannelType.GuildText) {
          throw new AppError(
            'ticket_thread_parent_invalid',
            'The configured parent channel for thread-mode tickets is missing or is not a text channel.',
            {
              status: 422,
              expose: true,
            },
          );
        }
        const thread = await parent.threads.create({
          name: ticketChannelName(created.number, openerUser.username),
          type: ChannelType.PrivateThread,
          invitable: false,
          reason: `Ticket #${created.number} opened by ${openerUser.username} (${params.openerId})`,
        });
        await thread.members.add(params.openerId).catch(() => undefined);
        threadId = thread.id;
      }
    } catch (err) {
      await ctx.prisma.ticket.delete({ where: { id: created.id } }).catch(() => undefined);
      throw err;
    }

    const updated = await ctx.prisma.ticket.update({
      where: { id: created.id },
      data: { channelId, threadId },
    });
    const targetChannel = channelId
      ? await resolveTextChannel(guild, channelId)
      : threadId
        ? await guild.channels.fetch(threadId).catch(() => null)
        : null;

    if (targetChannel && targetChannel.isTextBased()) {
      const embed = buildOpeningEmbed(
        updated,
        updated.subject,
        (params.intake as Record<string, string> | null) ?? null,
      );
      const row = buildOpeningButtons(updated.id);
      const mentionRoleIds = mode === 'THREAD' ? supportRoleIds : [];
      const mentionText = [`<@${params.openerId}>`, ...mentionRoleIds.map((id) => `<@&${id}>`)].join(' ');
      await targetChannel
        .send({
          content: mentionText,
          embeds: [embed],
          components: [row],
          allowedMentions: { users: [params.openerId], roles: mentionRoleIds },
        })
        .catch((err) =>
          ctx.logger.warn({ err, ticketId: updated.id }, 'tickets: failed to post opening embed'),
        );
    }

    await ctx.audit({
      guildId: params.guildId,
      actorId: params.openerId,
      actorType: 'user',
      action: 'ticket.open',
      targetType: 'ticket',
      targetId: updated.id,
      after: { number: updated.number, mode: updated.mode, panelId: updated.panelId },
      source: 'bot',
    });
    ctx.events.emit('ticket.opened', {
      guildId: params.guildId,
      ticketId: updated.id,
      userId: params.openerId,
    });

    return updated;
  } finally {
    await ctx.redis.del(lockKey);
  }
}

export interface CloseTicketParams {
  guildId: string;
  ticketId: string;
  closedBy: string;
  reason?: string;
  source: 'bot' | 'dashboard';
}

/** Closes a ticket: generates transcripts, delivers them, locks the channel/thread, and schedules deletion. */
export async function closeTicketCore(ctx: PluginContext, params: CloseTicketParams): Promise<Ticket> {
  const ticket = await ctx.prisma.ticket.findFirst({
    where: { id: params.ticketId, guildId: params.guildId },
  });
  if (!ticket) throw new NotFoundError('Ticket not found.');
  if (ticket.status === 'CLOSED') throw new ValidationError('This ticket is already closed.');

  const config = await ctx.getConfig<TicketsConfig>(params.guildId);
  const guild = await ctx.client.guilds.fetch(params.guildId);

  const messages = await fetchTicketMessages(guild, ticket);
  const meta = {
    number: ticket.number,
    guildId: ticket.guildId,
    openerId: ticket.openerId,
    subject: ticket.subject,
    status: 'CLOSED',
    mode: ticket.mode,
    createdAt: ticket.createdAt.toISOString(),
    closedAt: new Date().toISOString(),
    closedBy: params.closedBy,
    closeReason: params.reason ?? null,
    tags: ticket.tags,
    intake: (ticket.intake as Record<string, string> | null) ?? null,
  };
  const jsonTranscript = buildJsonTranscript(meta, messages);
  const htmlTranscript = buildHtmlTranscript(meta, messages);
  const expiresAt = config.transcriptRetentionDays
    ? new Date(Date.now() + config.transcriptRetentionDays * 86_400_000)
    : null;

  await ctx.prisma.ticketTranscript.upsert({
    where: { ticketId: ticket.id },
    create: {
      ticketId: ticket.id,
      htmlContent: htmlTranscript,
      jsonContent: jsonTranscript as unknown as Prisma.InputJsonValue,
      messageCount: messages.length,
      expiresAt,
    },
    update: {
      htmlContent: htmlTranscript,
      jsonContent: jsonTranscript as unknown as Prisma.InputJsonValue,
      messageCount: messages.length,
      generatedAt: new Date(),
      expiresAt,
    },
  });

  const updated = await ctx.prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      closedBy: params.closedBy,
      closeReason: params.reason ?? null,
    },
  });

  const filename = `${sanitizeFilename(`ticket-${updated.number}-transcript`)}.html`;

  if (config.transcriptChannelId) {
    const channel = await resolveTextChannel(guild, config.transcriptChannelId);
    if (channel) {
      await channel
        .send({
          embeds: [buildClosingSummaryEmbed(updated, params.reason)],
          files: [new AttachmentBuilder(Buffer.from(htmlTranscript, 'utf8'), { name: filename })],
        })
        .catch((err) =>
          ctx.logger.warn({ err, ticketId: updated.id }, 'tickets: failed to post closing summary'),
        );
    }
  }

  if (config.dmTranscript) {
    const openerUser = await ctx.client.users.fetch(ticket.openerId).catch(() => null);
    if (openerUser) {
      await safeDm(openerUser, {
        embeds: [buildClosingSummaryEmbed(updated, params.reason)],
        files: [new AttachmentBuilder(Buffer.from(htmlTranscript, 'utf8'), { name: filename })],
      });
    }
  }

  if (ticket.threadId) {
    const thread = await guild.channels.fetch(ticket.threadId).catch(() => null);
    if (thread?.isThread()) {
      await thread
        .send({ components: [buildReopenButton(ticket.id)], content: 'This ticket is now closed.' })
        .catch(() => undefined);
      await thread.setLocked(true, params.reason).catch(() => undefined);
      await thread.setArchived(true, params.reason).catch(() => undefined);
    }
  } else if (ticket.channelId) {
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (channel && channel.type === ChannelType.GuildText) {
      await channel
        .send({ components: [buildReopenButton(ticket.id)], content: 'This ticket is now closed.' })
        .catch(() => undefined);
      await channel.permissionOverwrites.delete(ticket.openerId, params.reason).catch(() => undefined);
      if (!config.keepClosedChannels) {
        const delaySeconds = Math.max(0, config.deleteAfterCloseSeconds);
        await ctx
          .queue('delete-channel')
          .add(
            'delete-channel',
            { guildId: params.guildId, ticketId: ticket.id, channelId: ticket.channelId },
            { delay: delaySeconds * 1000, jobId: `delete-${ticket.id}` },
          )
          .catch((err) =>
            ctx.logger.warn({ err, ticketId: updated.id }, 'tickets: failed to schedule channel deletion'),
          );
      }
    }
  }

  await ctx.audit({
    guildId: params.guildId,
    actorId: params.closedBy,
    actorType: 'user',
    action: 'ticket.close',
    targetType: 'ticket',
    targetId: ticket.id,
    reason: params.reason,
    source: params.source,
  });
  ctx.events.emit('ticket.closed', { guildId: params.guildId, ticketId: ticket.id, userId: ticket.openerId });

  return updated;
}

export interface ReopenTicketParams {
  guildId: string;
  ticketId: string;
  reopenedBy: string;
}

/** Reopens a recently-closed ticket within its guild's configured window: restores perms/unarchives, sets status OPEN. */
export async function reopenTicketCore(ctx: PluginContext, params: ReopenTicketParams): Promise<Ticket> {
  const ticket = await ctx.prisma.ticket.findFirst({
    where: { id: params.ticketId, guildId: params.guildId },
  });
  if (!ticket) throw new NotFoundError('Ticket not found.');
  if (ticket.status !== 'CLOSED' || !ticket.closedAt) throw new ValidationError('This ticket is not closed.');

  const config = await ctx.getConfig<TicketsConfig>(params.guildId);
  if (!isWithinReopenWindow(ticket.closedAt, config.reopenWindowHours)) {
    throw new ValidationError(
      `This ticket's reopen window (${config.reopenWindowHours}h after close) has passed. Open a new ticket instead.`,
    );
  }

  const guild = await ctx.client.guilds.fetch(params.guildId);

  await ctx
    .queue('delete-channel')
    .getJob(`delete-${ticket.id}`)
    .then((job) => job?.remove())
    .catch(() => undefined);

  if (ticket.threadId) {
    const thread = await guild.channels.fetch(ticket.threadId).catch(() => null);
    if (thread?.isThread()) {
      await thread.setArchived(false).catch(() => undefined);
      await thread.setLocked(false).catch(() => undefined);
    }
  } else if (ticket.channelId) {
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new ValidationError('The ticket channel no longer exists and cannot be reopened.');
    }
    await channel.permissionOverwrites.edit(ticket.openerId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true,
    });
  } else {
    throw new ValidationError('This ticket has no channel or thread to restore.');
  }

  const updated = await ctx.prisma.ticket.update({
    where: { id: ticket.id },
    data: { status: 'OPEN', closedAt: null, closedBy: null, closeReason: null },
  });

  await ctx.audit({
    guildId: params.guildId,
    actorId: params.reopenedBy,
    actorType: 'user',
    action: 'ticket.reopen',
    targetType: 'ticket',
    targetId: ticket.id,
    source: 'bot',
  });

  return updated;
}

/** Posts (or re-posts) a ticket panel's embed + Open button to its configured channel. */
export async function postPanelMessage(
  ctx: PluginContext,
  panel: TicketPanel,
): Promise<{ messageId: string }> {
  const guild = await ctx.client.guilds.fetch(panel.guildId);
  const channel = await resolveTextChannel(guild, panel.channelId);
  if (!channel) {
    throw new AppError(
      'ticket_panel_channel_unavailable',
      'The panel channel no longer exists, or I lack permission to post there.',
      { status: 422, expose: true },
    );
  }

  const message = await channel.send({
    embeds: [buildPanelEmbed(panel)],
    components: [buildPanelButtons(panel.id, panel.buttonLabel)],
  });
  await ctx.prisma.ticketPanel.update({ where: { id: panel.id }, data: { messageId: message.id } });
  return { messageId: message.id };
}

/** Assigns (or clears, when `assigneeId` is null) a ticket's staff assignee. */
export async function assignTicket(
  ctx: PluginContext,
  guildId: string,
  ticketId: string,
  assigneeId: string | null,
  actorId: string,
): Promise<Ticket> {
  const ticket = await ctx.prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
  if (!ticket) throw new NotFoundError('Ticket not found.');
  const updated = await ctx.prisma.ticket.update({ where: { id: ticketId }, data: { assigneeId } });
  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: 'ticket.assign',
    targetType: 'ticket',
    targetId: ticketId,
    after: { assigneeId },
    source: 'bot',
  });
  return updated;
}

/** Adds a participant to a ticket (channel-permission overwrite or thread member) and records `TicketParticipant`. */
export async function addTicketParticipant(
  ctx: PluginContext,
  guildId: string,
  ticketId: string,
  userId: string,
  addedBy: string,
): Promise<void> {
  const ticket = await ctx.prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
  if (!ticket) throw new NotFoundError('Ticket not found.');
  if (ticket.status !== 'OPEN') throw new ValidationError('This ticket is closed.');

  const guild = await ctx.client.guilds.fetch(guildId);
  if (ticket.threadId) {
    const thread = await guild.channels.fetch(ticket.threadId).catch(() => null);
    if (thread?.isThread()) await thread.members.add(userId);
  } else if (ticket.channelId) {
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (channel && channel.type === ChannelType.GuildText) {
      await channel.permissionOverwrites.edit(userId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
      });
    }
  }

  await ctx.prisma.ticketParticipant.upsert({
    where: { ticketId_userId: { ticketId, userId } },
    create: { ticketId, userId, addedBy },
    update: {},
  });
  await ctx.audit({
    guildId,
    actorId: addedBy,
    actorType: 'user',
    action: 'ticket.participant.add',
    targetType: 'ticket',
    targetId: ticketId,
    after: { userId },
    source: 'bot',
  });
}

/** Removes a participant from a ticket. */
export async function removeTicketParticipant(
  ctx: PluginContext,
  guildId: string,
  ticketId: string,
  userId: string,
  removedBy: string,
): Promise<void> {
  const ticket = await ctx.prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
  if (!ticket) throw new NotFoundError('Ticket not found.');
  if (userId === ticket.openerId) throw new ValidationError("You can't remove the ticket opener.");

  const guild = await ctx.client.guilds.fetch(guildId);
  if (ticket.threadId) {
    const thread = await guild.channels.fetch(ticket.threadId).catch(() => null);
    if (thread?.isThread()) await thread.members.remove(userId).catch(() => undefined);
  } else if (ticket.channelId) {
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (channel && channel.type === ChannelType.GuildText) {
      await channel.permissionOverwrites.delete(userId).catch(() => undefined);
    }
  }

  await ctx.prisma.ticketParticipant.deleteMany({ where: { ticketId, userId } });
  await ctx.audit({
    guildId,
    actorId: removedBy,
    actorType: 'user',
    action: 'ticket.participant.remove',
    targetType: 'ticket',
    targetId: ticketId,
    after: { userId },
    source: 'bot',
  });
}

/** Adds a tag to a ticket (no-op if already present), capped at 10 tags. */
export async function addTicketTag(
  ctx: PluginContext,
  guildId: string,
  ticketId: string,
  tag: string,
  actorId: string,
): Promise<Ticket> {
  const ticket = await ctx.prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
  if (!ticket) throw new NotFoundError('Ticket not found.');
  const normalized = tag.trim().toLowerCase().slice(0, 32);
  if (!normalized) throw new ValidationError('Tag cannot be empty.');
  if (ticket.tags.includes(normalized)) return ticket;
  if (ticket.tags.length >= 10) throw new ValidationError('This ticket already has the maximum of 10 tags.');

  const updated = await ctx.prisma.ticket.update({
    where: { id: ticketId },
    data: { tags: { push: normalized } },
  });
  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: 'ticket.tag.add',
    targetType: 'ticket',
    targetId: ticketId,
    after: { tag: normalized },
    source: 'bot',
  });
  return updated;
}

/** Removes a tag from a ticket. */
export async function removeTicketTag(
  ctx: PluginContext,
  guildId: string,
  ticketId: string,
  tag: string,
  actorId: string,
): Promise<Ticket> {
  const ticket = await ctx.prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
  if (!ticket) throw new NotFoundError('Ticket not found.');
  const normalized = tag.trim().toLowerCase();
  const updated = await ctx.prisma.ticket.update({
    where: { id: ticketId },
    data: { tags: ticket.tags.filter((t) => t !== normalized) },
  });
  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: 'ticket.tag.remove',
    targetType: 'ticket',
    targetId: ticketId,
    after: { tag: normalized },
    source: 'bot',
  });
  return updated;
}

/** Finds the ticket (any status) whose channel or thread is `channelId`, most-recent first. */
export async function findTicketForChannel(
  ctx: PluginContext,
  guildId: string,
  channelId: string,
): Promise<Ticket | null> {
  return ctx.prisma.ticket.findFirst({
    where: { guildId, OR: [{ channelId }, { threadId: channelId }] },
    orderBy: { createdAt: 'desc' },
  });
}

async function postPanelCore(ctx: PluginContext, guildId: string, panelId: string): Promise<void> {
  const panel = await ctx.prisma.ticketPanel.findFirst({ where: { id: panelId, guildId, deletedAt: null } });
  if (!panel) throw new NotFoundError('Ticket panel not found.');
  await postPanelMessage(ctx, panel);
}

// --- Dual-calling-convention wrappers -------------------------------------------------------------------
// apps/bot/src/host/bot-actions.ts dispatches every dashboard-queued `bot-actions` job by calling the target
// service method with a SINGLE merged object argument `{ guildId, payload, requestedBy }`, not the positional
// arguments `TicketsService` declares. In-process callers (other plugins holding a real `TicketsService`
// reference) still call positionally per the declared type. Both shapes are supported here, matching the
// pattern already established in roles/service.ts, ai/service.ts, integrations/service.ts, and enforcer/service.ts.
function isBotActionObjectCall(
  args: unknown[],
): args is [{ guildId: string; payload?: unknown; requestedBy?: string }] {
  return (
    args.length === 1 && typeof args[0] === 'object' && args[0] !== null && 'guildId' in (args[0] as object)
  );
}

/** Builds the `TicketsService` (ARCHITECTURE.md §7.5) — the narrow cross-plugin/bot-action-facing surface. Richer flows (panel-aware opening, assign, tags, participants) are called directly by this plugin's own commands/components. */
export function createTicketsService(ctx: PluginContext): TicketsService {
  const postPanel = ((...args: unknown[]) => {
    if (isBotActionObjectCall(args)) {
      const { guildId, payload } = args[0];
      const panelId = (payload as { panelId?: string } | undefined)?.panelId ?? '';
      return postPanelCore(ctx, guildId, panelId);
    }
    const [guildId, panelId] = args as [string, string];
    return postPanelCore(ctx, guildId, panelId);
  }) as TicketsService['postPanel'];

  const closeTicketFromDashboard = ((...args: unknown[]) => {
    if (isBotActionObjectCall(args)) {
      const { guildId, payload } = args[0];
      const p = payload as { ticketId: string; closedBy?: string; reason?: string };
      return closeTicketCore(ctx, {
        guildId,
        ticketId: p.ticketId,
        closedBy: p.closedBy ?? 'system',
        reason: p.reason,
        source: 'dashboard',
      });
    }
    const [guildId, ticketId, closedBy, reason] = args as [string, string, string, string?];
    return closeTicketCore(ctx, { guildId, ticketId, closedBy, reason, source: 'dashboard' });
  }) as unknown as TicketsService['closeTicketFromDashboard'];

  return {
    async createTicket(input: CreateTicketInput) {
      const ticket = await openTicket(ctx, {
        guildId: input.guildId,
        openerId: input.openerId,
        subject: input.subject ?? null,
        intake: (input.intake as Record<string, string> | undefined) ?? null,
        panel: null,
        parentChannelId: input.channelId ?? null,
      });
      return { id: ticket.id, number: ticket.number };
    },

    async closeTicket(guildId, ticketId, closedBy, reason) {
      await closeTicketCore(ctx, { guildId, ticketId, closedBy, reason, source: 'bot' });
    },

    postPanel,
    closeTicketFromDashboard,
  };
}

export { TICKETS_PLUGIN_ID, fetchTicketMessages };
