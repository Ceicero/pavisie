import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { AuditAction, NotFoundError, ValidationError, buildPaginated, paginate } from '@pavisie/core';
import { defaultRetentionPolicy } from '@pavisie/database';
import type { DataRequestDto, Paginated, RetentionPolicyDto } from '@pavisie/types';
import { writeDashboardAudit } from '../lib/audit';
import { toDataRequestDto, toRetentionPolicyDto } from '../lib/dto';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, paginationQuerySchema } from '../lib/schemas';

const dataRequestParamSchema = guildIdParamSchema.extend({ requestId: z.string().min(1) });

// Body keys match `RetentionPolicyDto` (what GET returns and what apps/dashboard's useUpdateRetention sends),
// not the underlying Prisma `DataRetentionPolicy` column names directly — mapped onto those columns below.
const retentionPatchSchema = z.object({
  auditLogRetentionDays: z.number().int().min(1).max(3650).optional(),
  logRetentionDays: z.number().int().min(1).max(3650).optional(),
  moderationRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  automodEventRetentionDays: z.number().int().min(1).max(3650).optional(),
  ticketTranscriptRetentionDays: z.number().int().min(1).max(3650).optional(),
  levelInactivityRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  analyticsRetentionDays: z.number().int().min(1).max(3650).optional(),
});

const deleteBodySchema = z.object({ confirm: z.string().min(1) });

/** `/guilds/:guildId/privacy` — retention policy, and data export/delete requests (ARCHITECTURE.md §10). */
export default async function privacyRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/privacy/retention',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<RetentionPolicyDto> => {
      const guildId = request.guildId!;
      const row = await app.prisma.dataRetentionPolicy.upsert({
        where: { guildId },
        create: { guildId, ...defaultRetentionPolicy },
        update: {},
      });
      return toRetentionPolicyDto(row);
    },
  );

  app.put(
    '/:guildId/privacy/retention',
    { schema: { params: guildIdParamSchema, body: retentionPatchSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<RetentionPolicyDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const before = await app.prisma.dataRetentionPolicy.upsert({
        where: { guildId },
        create: { guildId, ...defaultRetentionPolicy },
        update: {},
      });

      const {
        auditLogRetentionDays,
        logRetentionDays,
        moderationRetentionDays,
        automodEventRetentionDays,
        ticketTranscriptRetentionDays,
        levelInactivityRetentionDays,
        analyticsRetentionDays,
      } = request.body;
      const data = {
        ...(auditLogRetentionDays !== undefined && { auditLogDays: auditLogRetentionDays }),
        ...(logRetentionDays !== undefined && { logEventDays: logRetentionDays }),
        ...(moderationRetentionDays !== undefined && { moderationCaseDays: moderationRetentionDays }),
        ...(automodEventRetentionDays !== undefined && { automodEventDays: automodEventRetentionDays }),
        ...(ticketTranscriptRetentionDays !== undefined && {
          ticketTranscriptDays: ticketTranscriptRetentionDays,
        }),
        ...(levelInactivityRetentionDays !== undefined && {
          levelInactivityDays: levelInactivityRetentionDays,
        }),
        ...(analyticsRetentionDays !== undefined && { analyticsDays: analyticsRetentionDays }),
      };

      const after = await app.prisma.dataRetentionPolicy.update({
        where: { guildId },
        data: { ...data, updatedBy: session.userId },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.RetentionUpdate,
        targetType: 'data_retention_policy',
        targetId: guildId,
        before,
        after,
      });

      return toRetentionPolicyDto(after);
    },
  );

  app.post(
    '/:guildId/data/export',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<DataRequestDto> => {
      const guildId = request.guildId!;
      const session = request.session!;

      const row = await app.prisma.dataRequest.create({
        data: { guildId, type: 'EXPORT', status: 'PENDING', requestedBy: session.userId },
      });
      await app.queues
        .dataRequests()
        .add('export', { requestId: row.id, guildId, requestedBy: session.userId });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.DataExportRequest,
        targetType: 'data_request',
        targetId: row.id,
      });

      reply.status(202);
      return toDataRequestDto(row);
    },
  );

  app.post(
    '/:guildId/data/delete',
    { schema: { params: guildIdParamSchema, body: deleteBodySchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<DataRequestDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const guild = await app.prisma.guild.findUnique({ where: { id: guildId } });
      const expected = [guild?.name, guildId].filter(Boolean);
      if (!expected.some((value) => value === request.body.confirm)) {
        throw new ValidationError("Confirmation phrase must exactly match this server's name or id.");
      }

      const row = await app.prisma.dataRequest.create({
        data: { guildId, type: 'DELETE', status: 'PENDING', requestedBy: session.userId },
      });
      await app.queues
        .dataRequests()
        .add('delete', { requestId: row.id, guildId, requestedBy: session.userId });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.DataDeleteRequest,
        targetType: 'data_request',
        targetId: row.id,
      });

      reply.status(202);
      return toDataRequestDto(row);
    },
  );

  app.get(
    '/:guildId/data/requests',
    {
      schema: { params: guildIdParamSchema, querystring: paginationQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<DataRequestDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.dataRequest.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toDataRequestDto), limit, offset);
    },
  );

  app.get(
    '/:guildId/data/requests/:requestId/download',
    { schema: { params: dataRequestParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const { guildId, requestId } = request.params;

      const dataRequest = await app.prisma.dataRequest.findFirst({
        where: { id: requestId, guildId, type: 'EXPORT' },
      });
      if (!dataRequest) throw new NotFoundError('That export could not be found.');
      if (dataRequest.status !== 'DONE') throw new ValidationError('That export is not ready yet.');
      if (dataRequest.resultExpiresAt && dataRequest.resultExpiresAt.getTime() < Date.now()) {
        throw new ValidationError('This export link has expired. Request a new export.');
      }

      const blob = await app.prisma.dataExportBlob.findUnique({ where: { requestId } });
      if (!blob) throw new NotFoundError('That export could not be found.');

      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="pavisie-export-${guildId}.json"`);
      return blob.content;
    },
  );
}
