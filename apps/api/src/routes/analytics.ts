import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { AppError } from '@pavisie/core';
import type { AnalyticsDto } from '@pavisie/types';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema } from '../lib/schemas';

const RANGE_DAYS: Record<'7d' | '30d' | '90d', number> = { '7d': 7, '30d': 30, '90d': 90 };
const analyticsQuerySchema = z.object({ range: z.enum(['7d', '30d', '90d']).default('7d') });

/** `/guilds/:guildId/analytics` — member growth / moderation volume / message activity, gated on opt-in data collection (ARCHITECTURE.md §10). */
export default async function analyticsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/analytics',
    {
      schema: { params: guildIdParamSchema, querystring: analyticsQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<AnalyticsDto> => {
      const guildId = request.guildId!;
      const range = request.query.range;
      const guildConfig = await app.configStore.getGuildConfig(guildId);

      if (!guildConfig.dataCollectionEnabled) {
        throw new AppError(
          'data_collection_disabled',
          'Analytics are unavailable until this server opts into data collection.',
          {
            status: 403,
            expose: true,
          },
        );
      }

      const days = RANGE_DAYS[range];
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const rows = await app.prisma.guildAnalyticsDaily.findMany({
        where: { guildId, date: { gte: since } },
        orderBy: { date: 'asc' },
      });

      let runningTotal = 0;
      return {
        range,
        memberGrowth: rows.map((row) => {
          runningTotal += row.joins - row.leaves;
          return {
            date: row.date.toISOString().slice(0, 10),
            joins: row.joins,
            leaves: row.leaves,
            total: row.memberCount ?? runningTotal,
          };
        }),
        moderationVolume: rows.map((row) => ({
          date: row.date.toISOString().slice(0, 10),
          count: row.moderationActions,
        })),
        messageActivity: rows.map((row) => ({
          date: row.date.toISOString().slice(0, 10),
          count: row.messages,
        })),
      };
    },
  );
}
