import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { Prisma } from '@pavisie/database';
// Pure logic import (no discord.js runtime touched) via the plugins package's `./*` subpath export — see
// ARCHITECTURE.md §3/§10: the API already depends on `@pavisie/plugins` for manifests/sdk, so reusing its
// redaction module here avoids maintaining a second copy of the default patterns in the API layer.
import { testRedactionPatterns } from '@pavisie/plugins/logging/redaction';
import type { LogEventDto, Paginated } from '@pavisie/types';
// `@pavisie/types`'s barrel (`src/index.ts`) doesn't export these — this task's ownership rules put new DTOs in
// `src/logging.ts` and require importing them via the subpath export instead of editing the barrel (the wiring
// stage adds that later).
import type { RedactionTestRequestDto, RedactionTestResponseDto } from '@pavisie/types/logging';
import { toCsv } from '../lib/csv';
import { toLogEventDto } from '../lib/dto';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, paginationQuerySchema } from '../lib/schemas';

const LOGGING_PLUGIN_ID = 'logging' as const;

const redactionTestBodySchema = z.object({ text: z.string().min(1).max(4000) });

const logsQuerySchema = paginationQuerySchema.extend({
  kind: z.string().optional(),
  actorId: z.string().optional(),
  targetId: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

/** Builds the shared `WHERE` predicate (as a `Prisma.sql` fragment) for both the search and CSV export routes. */
function buildLogWhere(guildId: string, filters: z.infer<typeof logsQuerySchema>): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`"guildId" = ${guildId}`];
  if (filters.kind) conditions.push(Prisma.sql`"kind" = ${filters.kind}`);
  if (filters.actorId) conditions.push(Prisma.sql`"actorId" = ${filters.actorId}`);
  if (filters.targetId) conditions.push(Prisma.sql`"targetId" = ${filters.targetId}`);
  if (filters.since) conditions.push(Prisma.sql`"createdAt" >= ${new Date(filters.since)}`);
  if (filters.until) conditions.push(Prisma.sql`"createdAt" <= ${new Date(filters.until)}`);
  if (filters.q) {
    // Cast the relevant Json paths to text and match case-insensitively — Prisma has no native operator
    // for this, so it's a parameterized $queryRaw fragment (never string-concatenated user input).
    conditions.push(
      Prisma.sql`(payload->>'title' ILIKE ${`%${filters.q}%`} OR payload->>'description' ILIKE ${`%${filters.q}%`})`,
    );
  }
  return Prisma.join(conditions, ' AND ');
}

/** `/guilds/:guildId/logging` — log channel settings (via the config store) and searchable log export (ARCHITECTURE.md §10). */
export default async function loggingRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/logging/settings',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      return app.configStore.getConfig(request.guildId!, LOGGING_PLUGIN_ID);
    },
  );

  app.put(
    '/:guildId/logging/settings',
    {
      schema: { params: guildIdParamSchema, body: z.record(z.string(), z.unknown()) },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const session = request.session!;
      return app.configStore.setConfig(request.guildId!, LOGGING_PLUGIN_ID, request.body, {
        id: session.userId,
        source: 'dashboard',
      });
    },
  );

  app.get(
    '/:guildId/logging/logs',
    {
      schema: { params: guildIdParamSchema, querystring: logsQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<LogEventDto>> => {
      const guildId = request.guildId!;
      const limit = Math.min(Math.max(request.query.limit ?? 25, 1), 100);
      const offset = request.query.cursor
        ? Number(Buffer.from(request.query.cursor, 'base64url').toString('utf8')) || 0
        : 0;
      const where = buildLogWhere(guildId, request.query);

      const rows = await app.prisma.$queryRaw<
        { id: string; guildId: string; kind: string; payload: unknown; createdAt: Date }[]
      >(
        Prisma.sql`SELECT "id", "guildId", "kind", "payload", "createdAt" FROM "LogEvent" WHERE ${where} ORDER BY "createdAt" DESC OFFSET ${offset} LIMIT ${limit + 1}`,
      );

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((row) =>
        toLogEventDto({ ...row, payload: row.payload } as Parameters<typeof toLogEventDto>[0]),
      );
      return {
        items,
        nextCursor: hasMore ? Buffer.from(String(offset + limit), 'utf8').toString('base64url') : null,
      };
    },
  );

  app.get(
    '/:guildId/logging/logs/export.csv',
    {
      schema: { params: guildIdParamSchema, querystring: logsQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request, reply) => {
      const guildId = request.guildId!;
      const where = buildLogWhere(guildId, request.query);
      const rows = await app.prisma.$queryRaw<
        {
          id: string;
          kind: string;
          actorId: string | null;
          targetId: string | null;
          payload: unknown;
          createdAt: Date;
        }[]
      >(
        Prisma.sql`SELECT "id", "kind", "actorId", "targetId", "payload", "createdAt" FROM "LogEvent" WHERE ${where} ORDER BY "createdAt" DESC LIMIT 10000`,
      );

      const csv = toCsv(
        rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          actorId: row.actorId ?? '',
          targetId: row.targetId ?? '',
          createdAt: row.createdAt.toISOString(),
          payload: JSON.stringify(row.payload ?? {}),
        })),
        ['id', 'kind', 'actorId', 'targetId', 'createdAt', 'payload'],
      );
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="logs-${guildId}.csv"`);
      return reply.send(csv);
    },
  );

  app.post(
    '/:guildId/logging/redaction/test',
    {
      schema: { params: guildIdParamSchema, body: redactionTestBodySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<RedactionTestResponseDto> => {
      const guildId = request.guildId!;
      const body: RedactionTestRequestDto = request.body;
      const config = await app.configStore.getConfig<{ redactionPatterns: string[] }>(
        guildId,
        LOGGING_PLUGIN_ID,
      );
      return testRedactionPatterns(body.text, config.redactionPatterns);
    },
  );
}
