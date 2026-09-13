import { NotFoundError, buildPaginated, paginate } from '@pavisie/core';
import type { DeveloperReportDto, Paginated } from '@pavisie/types';
import { toDeveloperReportDto } from '../lib/developer-reports/dto';
import {
  developerReportIdParamSchema,
  developerReportPatchBodySchema,
  developerReportsQuerySchema,
} from '../lib/developer-reports/schemas';
import { requireBotOwner } from '../lib/bot-owner';
import type { ZodFastifyInstance } from '../lib/http';

/**
 * `/owner/developer-reports` — the ops-console backend for the guild → developer support channel (the
 * `admin` plugin's `/pavisie report`). Every route here is gated on bot-owner identity (`requireBotOwner`),
 * NOT `requireGuildAccess`: this data is intentionally cross-guild (a report from any server the bot is in),
 * which is exactly why it must never be reachable by a regular guild-managing dashboard session.
 */
export default async function developerReportsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/developer-reports',
    { schema: { querystring: developerReportsQuerySchema }, preHandler: requireBotOwner() },
    async (request): Promise<Paginated<DeveloperReportDto>> => {
      const { cursor, limit: rawLimit, status, kind, guildId } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });

      const where = {
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(guildId ? { guildId } : {}),
      };

      const rows = await app.prisma.developerReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toDeveloperReportDto), limit, offset);
    },
  );

  app.get(
    '/developer-reports/:id',
    { schema: { params: developerReportIdParamSchema }, preHandler: requireBotOwner() },
    async (request): Promise<DeveloperReportDto> => {
      const row = await app.prisma.developerReport.findUnique({ where: { id: request.params.id } });
      if (!row) throw new NotFoundError('Report not found.');
      return toDeveloperReportDto(row);
    },
  );

  app.patch(
    '/developer-reports/:id',
    {
      schema: { params: developerReportIdParamSchema, body: developerReportPatchBodySchema },
      preHandler: requireBotOwner(),
    },
    async (request): Promise<DeveloperReportDto> => {
      const existing = await app.prisma.developerReport.findUnique({ where: { id: request.params.id } });
      if (!existing) throw new NotFoundError('Report not found.');

      const { status, notes } = request.body;
      const session = request.session!;

      const updated = await app.prisma.developerReport.update({
        where: { id: request.params.id },
        data: {
          ...(notes !== undefined ? { notes } : {}),
          ...(status === 'HANDLED' ? { status: 'HANDLED', handledAt: new Date(), handledBy: session.userId } : {}),
          ...(status === 'OPEN' ? { status: 'OPEN', handledAt: null, handledBy: null } : {}),
        },
      });

      return toDeveloperReportDto(updated);
    },
  );
}
