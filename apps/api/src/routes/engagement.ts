import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { NotFoundError, ValidationError, buildPaginated, paginate } from '@pavisie/core';
import { levelFromXp } from '@pavisie/plugins/engagement/service';
import type {
  LevelProfileDto,
  LevelRewardDto,
  ReputationLeaderboardEntryDto,
} from '@pavisie/types/engagement';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, paginationQuerySchema, snowflakeSchema } from '../lib/schemas';
import { writeDashboardAudit } from '../lib/audit';

const ENGAGEMENT_PLUGIN_ID = 'engagement' as const;

const rewardBodySchema = z.object({ level: z.number().int().min(1).max(1000), roleId: snowflakeSchema });
const rewardParamSchema = guildIdParamSchema.extend({ rewardId: z.string().min(1) });

const xpAdjustBodySchema = z.object({
  userId: snowflakeSchema,
  mode: z.enum(['give', 'remove', 'set']),
  amount: z.number().int().min(0).max(1_000_000_000),
  reason: z.string().trim().max(500).optional(),
});

function toLevelProfileDto(row: {
  userId: string;
  xp: number;
  level: number;
  messages: number;
  voiceMinutes: number;
}): LevelProfileDto {
  return {
    userId: row.userId,
    xp: row.xp,
    level: row.level,
    messages: row.messages,
    voiceMinutes: row.voiceMinutes,
  };
}

function toLevelRewardDto(row: {
  id: string;
  guildId: string;
  level: number;
  roleId: string;
  createdAt: Date;
}): LevelRewardDto {
  return {
    id: row.id,
    guildId: row.guildId,
    level: row.level,
    roleId: row.roleId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `/guilds/:guildId/engagement` — leveling/reputation/starboard/temp-voice settings (all live in one
 * `PluginConfig` JSON blob, so a single get/put config endpoint covers every sub-feature's settings —
 * ARCHITECTURE.md §7.4), the leaderboard, level-role rewards CRUD, an audited XP adjustment endpoint,
 * and the reputation leaderboard (ARCHITECTURE.md §10).
 */
export default async function engagementRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/engagement/config',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      return app.configStore.getConfig(request.guildId!, ENGAGEMENT_PLUGIN_ID);
    },
  );

  app.put(
    '/:guildId/engagement/config',
    {
      schema: { params: guildIdParamSchema, body: z.record(z.string(), z.unknown()) },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const updated = await app.configStore.setConfig(guildId, ENGAGEMENT_PLUGIN_ID, request.body, {
        id: session.userId,
        source: 'dashboard',
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'engagement.config.update',
        targetType: 'plugin_config',
        targetId: ENGAGEMENT_PLUGIN_ID,
      });
      return updated;
    },
  );

  app.get(
    '/:guildId/engagement/leaderboard',
    {
      schema: { params: guildIdParamSchema, querystring: paginationQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.levelProfile.findMany({
        where: { guildId },
        orderBy: [{ xp: 'desc' }],
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toLevelProfileDto), limit, offset);
    },
  );

  app.get(
    '/:guildId/engagement/rewards',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const rows = await app.prisma.levelReward.findMany({
        where: { guildId: request.guildId! },
        orderBy: { level: 'asc' },
      });
      return rows.map(toLevelRewardDto);
    },
  );

  app.post(
    '/:guildId/engagement/rewards',
    { schema: { params: guildIdParamSchema, body: rewardBodySchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const existing = await app.prisma.levelReward.findFirst({
        where: { guildId, level: request.body.level, roleId: request.body.roleId },
      });
      if (existing) throw new ValidationError('That level already has this role as a reward.');

      const row = await app.prisma.levelReward.create({ data: { guildId, ...request.body } });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'engagement.reward.create',
        targetType: 'level_reward',
        targetId: row.id,
        after: { level: row.level, roleId: row.roleId },
      });
      reply.status(201);
      return toLevelRewardDto(row);
    },
  );

  app.delete(
    '/:guildId/engagement/rewards/:rewardId',
    { schema: { params: rewardParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { rewardId } = request.params as { rewardId: string };
      const existing = await app.prisma.levelReward.findFirst({ where: { id: rewardId, guildId } });
      if (!existing) throw new NotFoundError('Level reward not found.');

      await app.prisma.levelReward.delete({ where: { id: rewardId } });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'engagement.reward.delete',
        targetType: 'level_reward',
        targetId: rewardId,
      });
      reply.status(204);
      return null;
    },
  );

  /** Dashboard-issued XP adjustment. Writes `LevelProfile` directly (no Discord round-trip needed for the number itself); role-reward reconciliation for the new level happens next time the member is active, or via `/level rewards sync` in Discord. */
  app.post(
    '/:guildId/engagement/xp-adjust',
    { schema: { params: guildIdParamSchema, body: xpAdjustBodySchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { userId, mode, amount, reason } = request.body;

      const existing = await app.prisma.levelProfile.findUnique({
        where: { guildId_userId: { guildId, userId } },
      });
      const currentXp = existing?.xp ?? 0;
      const nextXp =
        mode === 'give'
          ? currentXp + amount
          : mode === 'remove'
            ? Math.max(0, currentXp - amount)
            : Math.max(0, amount);
      const nextLevel = levelFromXp(nextXp);

      const row = await app.prisma.levelProfile.upsert({
        where: { guildId_userId: { guildId, userId } },
        create: { guildId, userId, xp: nextXp, level: nextLevel },
        update: { xp: nextXp, level: nextLevel },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: `engagement.xp.${mode}`,
        targetType: 'level_profile',
        targetId: userId,
        before: { xp: currentXp },
        after: { xp: nextXp, level: nextLevel },
        reason,
      });

      return toLevelProfileDto(row);
    },
  );

  app.get(
    '/:guildId/engagement/rep/leaderboard',
    {
      schema: { params: guildIdParamSchema, querystring: paginationQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });

      const grouped = await app.prisma.reputationEvent.groupBy({
        by: ['toUserId'],
        where: { guildId },
        _sum: { amount: true },
        _count: { _all: true },
        orderBy: { _sum: { amount: 'desc' } },
        skip: offset,
        take: limit + 1,
      });

      const items: ReputationLeaderboardEntryDto[] = grouped.map((g) => ({
        userId: g.toUserId,
        total: g._sum.amount ?? 0,
        eventCount: g._count._all,
      }));
      return buildPaginated(items, limit, offset);
    },
  );
}
