import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { NotFoundError, ValidationError, buildPaginated, paginate, sanitizeFilename } from '@pavisie/core';
import { Prisma } from '@pavisie/database';
import type { Paginated } from '@pavisie/types';
import type { TicketDetailDto, TicketPanelDto, TicketQueueItemDto } from '@pavisie/types/tickets';
import { writeDashboardAudit } from '../lib/audit';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, paginationQuerySchema } from '../lib/schemas';
import { toTicketDetailDto, toTicketPanelDto, toTicketQueueItemDto } from '../lib/tickets/dto';

/** Prisma's nullable `Json` columns need the sentinel `Prisma.JsonNull`, not a bare `null`, to actually store JSON null. */
function toNullableJsonInput(
  value: unknown[] | Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

const TICKETS_PLUGIN_ID = 'tickets' as const;

const intakeFieldBodySchema = z.object({
  label: z.string().trim().min(1).max(100),
  style: z.enum(['short', 'paragraph']).default('short'),
  required: z.boolean().default(true),
});

const panelBodySchema = z.object({
  channelId: z.string().min(1),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2000),
  buttonLabel: z.string().trim().min(1).max(80).default('Open a ticket'),
  categoryId: z.string().nullable().optional(),
  supportRoleIds: z.array(z.string()).max(3).default([]),
  mode: z.enum(['CHANNEL', 'THREAD']).default('CHANNEL'),
  intakeForm: z.array(intakeFieldBodySchema).max(5).nullable().optional(),
  slaMinutes: z.number().int().positive().nullable().optional(),
});
const panelUpdateSchema = panelBodySchema.partial();
const panelParamSchema = guildIdParamSchema.extend({ panelId: z.string().min(1) });

const ticketParamSchema = guildIdParamSchema.extend({ ticketId: z.string().min(1) });
const queueQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['OPEN', 'CLOSED', 'ARCHIVED']).optional(),
  assigneeId: z.string().optional(),
  tag: z.string().optional(),
});
const closeBodySchema = z.object({ reason: z.string().trim().max(1000).optional() });
const assignBodySchema = z.object({ assigneeId: z.string().min(1).nullable() });
const transcriptQuerySchema = z.object({ format: z.enum(['html', 'json']).default('html') });

/** `/guilds/:guildId/tickets` — settings, panel CRUD, queue, close/assign, and transcript download (ARCHITECTURE.md §10). */
export default async function ticketsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/tickets/settings',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      return app.configStore.getConfig(request.guildId!, TICKETS_PLUGIN_ID);
    },
  );

  app.put(
    '/:guildId/tickets/settings',
    {
      schema: { params: guildIdParamSchema, body: z.record(z.string(), z.unknown()) },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const session = request.session!;
      return app.configStore.setConfig(request.guildId!, TICKETS_PLUGIN_ID, request.body, {
        id: session.userId,
        source: 'dashboard',
      });
    },
  );

  app.get(
    '/:guildId/tickets/panels',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TicketPanelDto[]> => {
      const rows = await app.prisma.ticketPanel.findMany({
        where: { guildId: request.guildId!, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toTicketPanelDto);
    },
  );

  app.post(
    '/:guildId/tickets/panels',
    { schema: { params: guildIdParamSchema, body: panelBodySchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<TicketPanelDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { intakeForm, ...rest } = request.body;
      const row = await app.prisma.ticketPanel.create({
        data: { guildId, ...rest, intakeForm: toNullableJsonInput(intakeForm) },
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'ticket.panel.create',
        targetType: 'ticket_panel',
        targetId: row.id,
        after: { title: row.title },
      });
      reply.status(201);
      return toTicketPanelDto(row);
    },
  );

  app.put(
    '/:guildId/tickets/panels/:panelId',
    { schema: { params: panelParamSchema, body: panelUpdateSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TicketPanelDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { panelId } = request.params as { panelId: string };
      const existing = await app.prisma.ticketPanel.findFirst({
        where: { id: panelId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Ticket panel not found.');

      const { intakeForm, ...rest } = request.body;
      const updated = await app.prisma.ticketPanel.update({
        where: { id: panelId },
        data: {
          ...rest,
          ...(intakeForm !== undefined ? { intakeForm: toNullableJsonInput(intakeForm) } : {}),
        },
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'ticket.panel.update',
        targetType: 'ticket_panel',
        targetId: panelId,
      });
      return toTicketPanelDto(updated);
    },
  );

  app.delete(
    '/:guildId/tickets/panels/:panelId',
    { schema: { params: panelParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { panelId } = request.params as { panelId: string };
      const existing = await app.prisma.ticketPanel.findFirst({
        where: { id: panelId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Ticket panel not found.');

      await app.prisma.ticketPanel.update({ where: { id: panelId }, data: { deletedAt: new Date() } });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'ticket.panel.delete',
        targetType: 'ticket_panel',
        targetId: panelId,
      });
      reply.status(204);
      return null;
    },
  );

  app.post(
    '/:guildId/tickets/panels/:panelId/post',
    { schema: { params: panelParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { panelId } = request.params as { panelId: string };
      const existing = await app.prisma.ticketPanel.findFirst({
        where: { id: panelId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Ticket panel not found.');

      await app.queues
        .botActions()
        .add('bot-action', {
          type: 'tickets.postPanel',
          guildId,
          payload: { panelId },
          requestedBy: session.userId,
        });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'ticket.panel.post',
        targetType: 'ticket_panel',
        targetId: panelId,
      });
      return { ok: true, queued: true };
    },
  );

  app.get(
    '/:guildId/tickets/queue',
    {
      schema: { params: guildIdParamSchema, querystring: queueQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<TicketQueueItemDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, status, assigneeId, tag } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.ticket.findMany({
        where: {
          guildId,
          deletedAt: null,
          ...(status ? { status } : {}),
          ...(assigneeId ? { assigneeId } : {}),
          ...(tag ? { tags: { has: tag } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toTicketQueueItemDto), limit, offset);
    },
  );

  app.get(
    '/:guildId/tickets/:ticketId',
    { schema: { params: ticketParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TicketDetailDto> => {
      const guildId = request.guildId!;
      const { ticketId } = request.params as { ticketId: string };
      const row = await app.prisma.ticket.findFirst({
        where: { id: ticketId, guildId },
        include: { participants: { orderBy: { createdAt: 'asc' } } },
      });
      if (!row) throw new NotFoundError('Ticket not found.');
      const transcript = await app.prisma.ticketTranscript.findUnique({
        where: { ticketId },
        select: { id: true },
      });
      return toTicketDetailDto(row, transcript !== null);
    },
  );

  app.post(
    '/:guildId/tickets/:ticketId/close',
    { schema: { params: ticketParamSchema, body: closeBodySchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { ticketId } = request.params as { ticketId: string };
      const existing = await app.prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
      if (!existing) throw new NotFoundError('Ticket not found.');
      if (existing.status === 'CLOSED') throw new ValidationError('Ticket is already closed.');

      // The actual close (transcript generation, posting the summary, locking/deleting the channel or thread, and
      // the final `status: CLOSED` transition) is owned by the `tickets` plugin's `closeTicketFromDashboard`
      // (dispatched via the `bot-actions` queue) so there is exactly one code path that performs a close,
      // whether triggered from Discord or the dashboard — this route only validates and enqueues.
      await app.queues.botActions().add('bot-action', {
        type: 'tickets.close',
        guildId,
        payload: { ticketId, closedBy: session.userId, reason: request.body.reason },
        requestedBy: session.userId,
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'ticket.close',
        targetType: 'ticket',
        targetId: ticketId,
        reason: request.body.reason,
      });
      reply.status(202);
      return { ok: true, queued: true };
    },
  );

  app.post(
    '/:guildId/tickets/:ticketId/assign',
    { schema: { params: ticketParamSchema, body: assignBodySchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TicketQueueItemDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { ticketId } = request.params as { ticketId: string };
      const existing = await app.prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
      if (!existing) throw new NotFoundError('Ticket not found.');

      const updated = await app.prisma.ticket.update({
        where: { id: ticketId },
        data: { assigneeId: request.body.assigneeId },
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'ticket.assign',
        targetType: 'ticket',
        targetId: ticketId,
        after: { assigneeId: updated.assigneeId },
      });
      return toTicketQueueItemDto(updated);
    },
  );

  app.get(
    '/:guildId/tickets/:ticketId/transcript',
    {
      schema: { params: ticketParamSchema, querystring: transcriptQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request, reply) => {
      const guildId = request.guildId!;
      const { ticketId } = request.params as { ticketId: string };
      const ticket = await app.prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
      if (!ticket) throw new NotFoundError('Ticket not found.');
      const transcript = await app.prisma.ticketTranscript.findUnique({ where: { ticketId } });
      if (!transcript) throw new NotFoundError('No transcript has been generated for this ticket yet.');

      const filename = sanitizeFilename(`ticket-${ticket.number}-transcript`);
      if (request.query.format === 'json') {
        reply.header('Content-Type', 'application/json; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="${filename}.json"`);
        return reply.send(JSON.stringify(transcript.jsonContent ?? {}, null, 2));
      }

      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}.html"`);
      return reply.send(
        transcript.htmlContent ??
          '<!doctype html><title>No transcript</title><p>No HTML transcript was generated for this ticket.</p>',
      );
    },
  );
}
