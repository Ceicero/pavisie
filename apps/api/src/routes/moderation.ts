import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { AuditAction, NotFoundError, buildPaginated, paginate } from '@pavisie/core';
import type { ModerationCaseType } from '@pavisie/database';
import type { ModerationCaseDto, ModerationWarningDto, Paginated } from '@pavisie/types';
import type {
  ModerationAppealDto,
  ModerationNoteDto,
  ModerationSettingsDto,
} from '@pavisie/types/moderation';
import { writeDashboardAudit } from '../lib/audit';
import { toCsv } from '../lib/csv';
import { toModerationCaseDto, toModerationWarningDto } from '../lib/dto';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, paginationQuerySchema, reasonSchema } from '../lib/schemas';

const MODERATION_PLUGIN_ID = 'moderation' as const;

const CASE_TYPES = [
  'WARN',
  'TIMEOUT',
  'UNTIMEOUT',
  'KICK',
  'BAN',
  'UNBAN',
  'SOFTBAN',
  'PURGE',
  'LOCK',
  'UNLOCK',
  'SLOWMODE',
  'NICK',
  'ROLE_ADD',
  'ROLE_REMOVE',
  'QUARANTINE',
  'NOTE',
] as const satisfies readonly ModerationCaseType[];

const casesQuerySchema = paginationQuerySchema.extend({
  type: z.enum(CASE_TYPES).optional(),
  targetId: z.string().optional(),
  moderatorId: z.string().optional(),
});

const caseNumberParamSchema = guildIdParamSchema.extend({ caseNumber: z.coerce.number().int().positive() });
const patchReasonSchema = z.object({ reason: reasonSchema });

const noteCreateSchema = z.object({ userId: z.string().min(1), content: z.string().trim().min(1).max(2000) });
const noteParamSchema = guildIdParamSchema.extend({ noteId: z.string().min(1) });

const appealDecideSchema = z.object({
  accept: z.boolean(),
  decisionNote: z.string().trim().max(2000).optional(),
});
const appealParamSchema = guildIdParamSchema.extend({ appealId: z.string().min(1) });

// Loose passthrough — the real shape (and defaults) come from the plugin's own zod `configSchema`, enforced by
// `app.configStore.setConfig` (ARCHITECTURE.md §7.4), same pattern as routes/logging.ts and routes/roles.ts's
// welcome-config endpoint.
const settingsBodySchema = z.record(z.string(), z.unknown());

/** `/guilds/:guildId/{cases,warnings,notes,appeals}` — the moderation case viewer (ARCHITECTURE.md §10). */
export default async function moderationRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/moderation/cases',
    {
      schema: { params: guildIdParamSchema, querystring: casesQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<ModerationCaseDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, type, targetId, moderatorId } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });

      const where = {
        guildId,
        deletedAt: null,
        ...(type ? { type } : {}),
        ...(targetId ? { targetId } : {}),
        ...(moderatorId ? { moderatorId } : {}),
      };
      const rows = await app.prisma.moderationCase.findMany({
        where,
        orderBy: { caseNumber: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toModerationCaseDto), limit, offset);
    },
  );

  app.get(
    '/:guildId/moderation/cases/:caseNumber',
    { schema: { params: caseNumberParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<ModerationCaseDto> => {
      const guildId = request.guildId!;
      const { caseNumber } = request.params as { caseNumber: number };
      const row = await app.prisma.moderationCase.findUnique({
        where: { guildId_caseNumber: { guildId, caseNumber } },
      });
      if (!row || row.deletedAt) throw new NotFoundError(`Case #${caseNumber} not found.`);
      return toModerationCaseDto(row);
    },
  );

  app.patch(
    '/:guildId/moderation/cases/:caseNumber',
    { schema: { params: caseNumberParamSchema, body: patchReasonSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<ModerationCaseDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { caseNumber } = request.params as { caseNumber: number };
      const existing = await app.prisma.moderationCase.findUnique({
        where: { guildId_caseNumber: { guildId, caseNumber } },
      });
      if (!existing || existing.deletedAt) throw new NotFoundError(`Case #${caseNumber} not found.`);

      const updated = await app.prisma.moderationCase.update({
        where: { guildId_caseNumber: { guildId, caseNumber } },
        data: { reason: request.body.reason },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.ModerationCaseUpdate,
        targetType: 'moderation_case',
        targetId: updated.id,
        before: { reason: existing.reason },
        after: { reason: updated.reason },
      });

      return toModerationCaseDto(updated);
    },
  );

  app.get(
    '/:guildId/moderation/cases/export.csv',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const rows = await app.prisma.moderationCase.findMany({
        where: { guildId, deletedAt: null },
        orderBy: { caseNumber: 'desc' },
        take: 10000,
      });
      const csv = toCsv(
        rows.map((row) => ({
          caseNumber: row.caseNumber,
          type: row.type,
          targetId: row.targetId,
          moderatorId: row.moderatorId,
          reason: row.reason ?? '',
          durationMs: row.durationMs ?? '',
          source: row.source,
          createdAt: row.createdAt.toISOString(),
        })),
        ['caseNumber', 'type', 'targetId', 'moderatorId', 'reason', 'durationMs', 'source', 'createdAt'],
      );
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="moderation-cases-${guildId}.csv"`);
      return reply.send(csv);
    },
  );

  app.get(
    '/:guildId/moderation/warnings',
    {
      schema: {
        params: guildIdParamSchema,
        querystring: paginationQuerySchema.extend({ userId: z.string().optional() }),
      },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<ModerationWarningDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, userId } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.moderationWarning.findMany({
        where: { guildId, ...(userId ? { userId } : {}) },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toModerationWarningDto), limit, offset);
    },
  );

  app.get(
    '/:guildId/moderation/notes',
    {
      schema: {
        params: guildIdParamSchema,
        querystring: paginationQuerySchema.extend({ userId: z.string().optional() }),
      },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<ModerationNoteDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, userId } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.moderationNote.findMany({
        where: { guildId, deletedAt: null, ...(userId ? { userId } : {}) },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(
        rows.map((row): ModerationNoteDto => ({
          id: row.id,
          guildId: row.guildId,
          userId: row.userId,
          authorId: row.authorId,
          content: row.content,
          createdAt: row.createdAt.toISOString(),
          deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
        })),
        limit,
        offset,
      );
    },
  );

  app.post(
    '/:guildId/moderation/notes',
    { schema: { params: guildIdParamSchema, body: noteCreateSchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<ModerationNoteDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const row = await app.prisma.moderationNote.create({
        data: {
          guildId,
          userId: request.body.userId,
          authorId: session.userId,
          content: request.body.content,
        },
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'moderation.note.create',
        targetType: 'moderation_note',
        targetId: row.id,
        after: { userId: row.userId, content: row.content },
      });
      reply.status(201);
      return {
        id: row.id,
        guildId,
        userId: row.userId,
        authorId: row.authorId,
        content: row.content,
        createdAt: row.createdAt.toISOString(),
        deletedAt: null,
      };
    },
  );

  app.delete(
    '/:guildId/moderation/notes/:noteId',
    { schema: { params: noteParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { noteId } = request.params as { noteId: string };
      const existing = await app.prisma.moderationNote.findFirst({
        where: { id: noteId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Note not found.');

      await app.prisma.moderationNote.update({ where: { id: noteId }, data: { deletedAt: new Date() } });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'moderation.note.delete',
        targetType: 'moderation_note',
        targetId: noteId,
      });
      reply.status(204);
      return null;
    },
  );

  app.get(
    '/:guildId/moderation/appeals',
    {
      schema: {
        params: guildIdParamSchema,
        querystring: paginationQuerySchema.extend({
          status: z.enum(['PENDING', 'ACCEPTED', 'DENIED']).optional(),
        }),
      },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<ModerationAppealDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, status } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.moderationAppeal.findMany({
        where: { guildId, ...(status ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
        include: { case: { select: { caseNumber: true } } },
      });
      return buildPaginated(
        rows.map((row): ModerationAppealDto => ({
          id: row.id,
          guildId: row.guildId,
          caseId: row.caseId,
          caseNumber: row.case?.caseNumber ?? null,
          userId: row.userId,
          content: row.content,
          status: row.status,
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
          decisionNote: row.decisionNote,
          createdAt: row.createdAt.toISOString(),
        })),
        limit,
        offset,
      );
    },
  );

  app.post(
    '/:guildId/moderation/appeals/:appealId/decide',
    { schema: { params: appealParamSchema, body: appealDecideSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { appealId } = request.params as { appealId: string };
      const existing = await app.prisma.moderationAppeal.findFirst({ where: { id: appealId, guildId } });
      if (!existing) throw new NotFoundError('Appeal not found.');
      if (existing.status !== 'PENDING') throw new NotFoundError('This appeal has already been decided.');

      // Discord-side effects (DM, auto-remove an active timeout, offer an "Unban now" button) are applied by the
      // bot's `moderation:appeal-sync` job (every minute) — this process has no Discord client. See the
      // moderation plugin's README ("Appeals") for the full flow and the idempotency-tracking tradeoff.
      const updated = await app.prisma.moderationAppeal.update({
        where: { id: appealId },
        data: {
          status: request.body.accept ? 'ACCEPTED' : 'DENIED',
          reviewedBy: session.userId,
          reviewedAt: new Date(),
          decisionNote: request.body.decisionNote,
        },
        include: { case: { select: { caseNumber: true } } },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: request.body.accept ? AuditAction.ModerationAppealApprove : AuditAction.ModerationAppealDeny,
        targetType: 'moderation_appeal',
        targetId: appealId,
        after: { status: updated.status, decisionNote: updated.decisionNote },
      });

      const dto: ModerationAppealDto = {
        id: updated.id,
        guildId: updated.guildId,
        caseId: updated.caseId,
        caseNumber: updated.case?.caseNumber ?? null,
        userId: updated.userId,
        content: updated.content,
        status: updated.status,
        reviewedBy: updated.reviewedBy,
        reviewedAt: updated.reviewedAt ? updated.reviewedAt.toISOString() : null,
        decisionNote: updated.decisionNote,
        createdAt: updated.createdAt.toISOString(),
      };
      return dto;
    },
  );

  app.get(
    '/:guildId/moderation/settings',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<ModerationSettingsDto> => {
      return app.configStore.getConfig<ModerationSettingsDto>(request.guildId!, MODERATION_PLUGIN_ID);
    },
  );

  app.put(
    '/:guildId/moderation/settings',
    { schema: { params: guildIdParamSchema, body: settingsBodySchema }, preHandler: requireGuildAccess() },
    async (request): Promise<ModerationSettingsDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const updated = await app.configStore.setConfig<ModerationSettingsDto>(
        guildId,
        MODERATION_PLUGIN_ID,
        request.body,
        {
          id: session.userId,
          source: 'dashboard',
        },
      );

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'moderation.settings.update',
        targetType: 'plugin_config',
        targetId: MODERATION_PLUGIN_ID,
      });

      return updated;
    },
  );
}
