import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { buildPaginated, paginate } from '@pavisie/core';
import type { AuditLogEntryDto, Paginated } from '@pavisie/types';
import { toCsv } from '../lib/csv';
import { toAuditLogEntryDto } from '../lib/dto';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, paginationQuerySchema } from '../lib/schemas';

const listQuerySchema = paginationQuerySchema.extend({
  action: z.string().optional(),
  actorId: z.string().optional(),
});

/** `/guilds/:guildId/audit` — the platform-wide dashboard audit trail, with CSV export (ARCHITECTURE.md §10). */
export default async function auditRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/audit',
    {
      schema: { params: guildIdParamSchema, querystring: listQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<AuditLogEntryDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, action, actorId } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });

      const where = { guildId, ...(action ? { action } : {}), ...(actorId ? { actorId } : {}) };
      const rows = await app.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });

      return buildPaginated(rows.map(toAuditLogEntryDto), limit, offset);
    },
  );

  app.get(
    '/:guildId/audit/export.csv',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const rows = await app.prisma.auditLog.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        take: 10000,
      });
      const csv = toCsv(
        rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          actorId: row.actorId,
          actorType: row.actorType,
          action: row.action,
          targetType: row.targetType ?? '',
          targetId: row.targetId ?? '',
          source: row.source,
          reason: row.reason ?? '',
        })),
        ['id', 'createdAt', 'actorId', 'actorType', 'action', 'targetType', 'targetId', 'source', 'reason'],
      );
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="audit-${guildId}.csv"`);
      return reply.send(csv);
    },
  );
}
