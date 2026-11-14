import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { NotFoundError, buildPaginated, paginate } from '@pavisie/core';
import type { Paginated, RaidModeRiskLevel, RaidModeRiskMemberDto, RaidModeRiskReason } from '@pavisie/types';
import { requireGuildAccess } from '../lib/guild-access';

/** Scores at or above this are "high"; stored scores below it are "medium" (low scores are never stored). */
const HIGH_RISK_SCORE = 60;
const MEDIUM_RISK_SCORE = 30;
/** Smaller than the usual page cap: this is per-member data, so a page stays small. */
const MAX_PAGE = 50;

const KNOWN_REASONS: ReadonlySet<string> = new Set<RaidModeRiskReason>([
  'discord_spammer_flag',
  'account_age_lt_1h',
  'account_age_lt_1d',
  'account_age_lt_7d',
  'default_avatar',
  'numbered_username',
]);

const paramsSchema = z.object({
  guildId: z.string().regex(/^\d{17,20}$/),
  incidentId: z.string().min(1).max(64),
});

const querySchema = z.object({
  minRisk: z.enum(['medium', 'high']).default('medium'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
});

/**
 * `/guilds/:guildId/raid-mode` — raid mode's per-member drill-down. Read-only. The incident list itself is
 * `/threats/incidents` (counts only); this route is separate so per-member data has its own review and access.
 */
export default async function raidModeRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/raid-mode/incidents/:incidentId/members',
    { schema: { params: paramsSchema, querystring: querySchema }, preHandler: requireGuildAccess() },
    async (request): Promise<Paginated<RaidModeRiskMemberDto>> => {
      const guildId = request.guildId!;
      const { incidentId } = request.params;
      const { minRisk, cursor, limit: rawLimit } = request.query;
      const { limit, offset } = paginate({ cursor, limit: Math.min(rawLimit ?? 25, MAX_PAGE) });

      // Scoped by guild as well as id: an incident id from another server is a 404, never a leak.
      const incident = await app.prisma.raidModeIncident.findFirst({
        where: { id: incidentId, guildId },
        select: { id: true },
      });
      if (!incident) throw new NotFoundError('Raid incident not found.');

      const rows = await app.prisma.raidModeRiskScore.findMany({
        where: {
          incidentId,
          guildId,
          score: { gte: minRisk === 'high' ? HIGH_RISK_SCORE : MEDIUM_RISK_SCORE },
        },
        select: { userId: true, score: true, reasons: true, joinedAt: true },
        orderBy: [{ score: 'desc' }, { joinedAt: 'asc' }],
        skip: offset,
        take: limit + 1,
      });
      const items: RaidModeRiskMemberDto[] = rows.map((row) => ({
        userId: row.userId,
        score: row.score,
        level: (row.score >= HIGH_RISK_SCORE ? 'high' : 'medium') satisfies RaidModeRiskLevel,
        reasons: row.reasons.filter((r): r is RaidModeRiskReason => KNOWN_REASONS.has(r)),
        joinedAt: row.joinedAt.toISOString(),
      }));
      return buildPaginated(items, limit, offset);
    },
  );
}
