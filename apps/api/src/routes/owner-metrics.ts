import { buildPaginated, paginate } from '@pavisie/core';
import type {
  OwnerMetricsErrorDto,
  OwnerMetricsGrowthDto,
  OwnerMetricsGrowthPointDto,
  OwnerMetricsGuildDto,
  OwnerMetricsOverviewDto,
  OwnerMetricsUsageDto,
  OwnerMetricsUsagePointDto,
  Paginated,
} from '@pavisie/types';
import { requireBotOwner } from '../lib/bot-owner';
import type { ZodFastifyInstance } from '../lib/http';
import {
  toDataRequestErrorDto,
  toIntegrationErrorDto,
  toJobErrorDto,
  toOwnerMetricsGuildDto,
  toWebhookErrorDto,
} from '../lib/owner-metrics/dto';
import {
  OWNER_METRICS_ERROR_SOURCES,
  ownerMetricsErrorsQuerySchema,
  ownerMetricsGrowthQuerySchema,
  ownerMetricsGuildsQuerySchema,
  ownerMetricsUsageQuerySchema,
} from '../lib/owner-metrics/schemas';

const DAY_MS = 24 * 60 * 60 * 1000;
const GROWTH_DAYS_MIN = 1;
const GROWTH_DAYS_MAX = 365;
const GROWTH_DAYS_DEFAULT = 30;

/**
 * Hard ceiling on how many rows we'll pull from any single error source for one page of `/owner/metrics/errors`.
 * The merge strategy (see that route) needs `offset + limit + 1` rows from each source to guarantee a correct
 * globally-sorted page; this caps that so a crafted/huge cursor can't force an unbounded per-source fetch. In
 * practice error volume per source is small, so this only bites on pathologically deep pagination.
 */
const MAX_ERROR_ROWS_PER_SOURCE = 1000;

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC on the day `date` falls on. */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * `/owner/metrics` — read-only ops metrics backing the local "Pavisie Dev" desktop app (Electron, owner-only,
 * not part of the web dashboard). Every route here is gated on bot-owner identity (`requireBotOwner`), NOT
 * `requireGuildAccess` — same reasoning as `routes/developer-reports.ts`: this data is intentionally
 * cross-guild, which is exactly why it must never be reachable by a regular guild-managing dashboard session.
 * No mutating routes belong in this file.
 */
export default async function ownerMetricsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/metrics/overview',
    { preHandler: requireBotOwner() },
    async (): Promise<OwnerMetricsOverviewDto> => {
      const now = Date.now();
      const sevenDaysAgo = new Date(now - 7 * DAY_MS);
      const thirtyDaysAgo = new Date(now - 30 * DAY_MS);

      const [
        presenceGroups,
        joined7d,
        joined30d,
        left30d,
        memberSum,
        largestGuild,
        reportGroups,
        moderationCases7d,
        ticketsOpen,
        automodEvents7d,
        enforcerPending,
      ] = await Promise.all([
        app.prisma.guild.groupBy({ by: ['botPresent'], _count: { _all: true } }),
        app.prisma.guild.count({ where: { joinedAt: { gte: sevenDaysAgo } } }),
        app.prisma.guild.count({ where: { joinedAt: { gte: thirtyDaysAgo } } }),
        // `leftAt` is null for every currently-present guild, so `gte` here naturally only matches guilds that
        // are actually gone right now — no explicit null-handling needed (unlike a `not:` filter, which would
        // need care; see the schema comment on `not:` excluding nulls).
        app.prisma.guild.count({ where: { leftAt: { gte: thirtyDaysAgo } } }),
        // Only currently-present guilds: a left guild's last-known `memberCount` is stale and would overstate
        // (or just mislead about) how many members the bot can currently reach.
        app.prisma.guild.aggregate({ where: { botPresent: true }, _sum: { memberCount: true } }),
        app.prisma.guild.findFirst({
          where: { botPresent: true, memberCount: { not: null } },
          orderBy: { memberCount: 'desc' },
        }),
        app.prisma.developerReport.groupBy({ by: ['status'], _count: { _all: true } }),
        app.prisma.moderationCase.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
        app.prisma.ticket.count({ where: { status: 'OPEN' } }),
        app.prisma.automodEvent.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
        app.prisma.enforcerRecord.count({ where: { kind: 'FLAG', status: 'PENDING' } }),
      ]);

      const active = presenceGroups.find((g) => g.botPresent === true)?._count._all ?? 0;
      const inactive = presenceGroups.find((g) => g.botPresent === false)?._count._all ?? 0;
      const reportsOpen = reportGroups.find((g) => g.status === 'OPEN')?._count._all ?? 0;
      const reportsHandled = reportGroups.find((g) => g.status === 'HANDLED')?._count._all ?? 0;

      return {
        guilds: { total: active + inactive, active, inactive, joined7d, joined30d, left30d },
        members: {
          totalAcrossGuilds: memberSum._sum.memberCount ?? 0,
          largestGuild: largestGuild
            ? { id: largestGuild.id, name: largestGuild.name, memberCount: largestGuild.memberCount ?? 0 }
            : null,
        },
        reports: { open: reportsOpen, handled: reportsHandled, total: reportsOpen + reportsHandled },
        activity: { moderationCases7d, ticketsOpen, automodEvents7d, enforcerPending },
      };
    },
  );

  app.get(
    '/metrics/guilds',
    { schema: { querystring: ownerMetricsGuildsQuerySchema }, preHandler: requireBotOwner() },
    async (request): Promise<Paginated<OwnerMetricsGuildDto>> => {
      const { cursor, limit: rawLimit, query, botPresent } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);

      const where = {
        ...(query ? { OR: [{ name: { contains: query, mode: 'insensitive' as const } }, { id: { contains: query } }] } : {}),
        ...(botPresent !== undefined ? { botPresent } : {}),
      };

      const rows = await app.prisma.guild.findMany({
        where,
        orderBy: { joinedAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      const guildIds = rows.map((r) => r.id);

      // Batched per-guild aggregates for this page only (never every guild, never every row of the underlying
      // tables) — one groupBy per stat across the whole page instead of N+1 queries per guild.
      const [pluginGroups, caseGroups, ticketGroups, activityGroups] =
        guildIds.length === 0
          ? [[], [], [], []]
          : await Promise.all([
              app.prisma.pluginState.groupBy({
                by: ['guildId'],
                where: { guildId: { in: guildIds }, enabled: true },
                _count: { _all: true },
              }),
              app.prisma.moderationCase.groupBy({
                by: ['guildId'],
                where: { guildId: { in: guildIds }, createdAt: { gte: thirtyDaysAgo } },
                _count: { _all: true },
              }),
              app.prisma.ticket.groupBy({
                by: ['guildId'],
                where: { guildId: { in: guildIds }, status: 'OPEN' },
                _count: { _all: true },
              }),
              app.prisma.auditLog.groupBy({
                by: ['guildId'],
                where: { guildId: { in: guildIds } },
                _max: { createdAt: true },
              }),
            ]);

      const pluginsEnabledByGuild = new Map(pluginGroups.map((g) => [g.guildId, g._count._all]));
      const casesByGuild = new Map(caseGroups.map((g) => [g.guildId, g._count._all]));
      const ticketsByGuild = new Map(ticketGroups.map((g) => [g.guildId, g._count._all]));
      const lastActivityByGuild = new Map(activityGroups.map((g) => [g.guildId, g._max.createdAt]));

      const items = rows.map((row) =>
        toOwnerMetricsGuildDto(row, {
          pluginsEnabled: pluginsEnabledByGuild.get(row.id) ?? 0,
          moderationCases30d: casesByGuild.get(row.id) ?? 0,
          ticketsOpen: ticketsByGuild.get(row.id) ?? 0,
          lastActivityAt: lastActivityByGuild.get(row.id) ?? null,
        }),
      );

      return buildPaginated(items, limit, offset);
    },
  );

  app.get(
    '/metrics/errors',
    { schema: { querystring: ownerMetricsErrorsQuerySchema }, preHandler: requireBotOwner() },
    async (request): Promise<Paginated<OwnerMetricsErrorDto>> => {
      const { cursor, limit: rawLimit, source, guildId } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const sources = source ? [source] : OWNER_METRICS_ERROR_SOURCES;

      // Merge strategy: there's no single error table to page over (see the DTO source comment), so each
      // requested source is independently fetched newest-first, capped at `offset + limit + 1` rows (enough to
      // guarantee the globally-sorted page is correct — see `MAX_ERROR_ROWS_PER_SOURCE`'s doc comment for why
      // that bound is sufficient), then merged, re-sorted, and sliced to the requested window in memory. Sources
      // outside the `?source=` filter are never queried at all.
      const perSourceTake = Math.min(offset + limit + 1, MAX_ERROR_ROWS_PER_SOURCE);

      const queries: Promise<OwnerMetricsErrorDto[]>[] = [];

      if (sources.includes('integration')) {
        queries.push(
          app.prisma.integrationConnection
            .findMany({
              where: { lastError: { not: null }, ...(guildId ? { guildId } : {}) },
              orderBy: { updatedAt: 'desc' },
              take: perSourceTake,
              include: { guild: { select: { name: true } } },
            })
            .then((rows) => rows.map(toIntegrationErrorDto)),
        );
      }
      if (sources.includes('job')) {
        queries.push(
          app.prisma.scheduledJob
            .findMany({
              where: { lastError: { not: null }, ...(guildId ? { guildId } : {}) },
              orderBy: { updatedAt: 'desc' },
              take: perSourceTake,
              include: { guild: { select: { name: true } } },
            })
            .then((rows) => rows.map(toJobErrorDto)),
        );
      }
      if (sources.includes('webhook')) {
        queries.push(
          app.prisma.webhookDelivery
            .findMany({
              where: { error: { not: null }, ...(guildId ? { endpoint: { guildId } } : {}) },
              orderBy: { createdAt: 'desc' },
              take: perSourceTake,
              include: { endpoint: { include: { guild: { select: { name: true } } } } },
            })
            .then((rows) => rows.map(toWebhookErrorDto)),
        );
      }
      if (sources.includes('data-request')) {
        queries.push(
          app.prisma.dataRequest
            .findMany({
              where: { error: { not: null }, ...(guildId ? { guildId } : {}) },
              orderBy: { updatedAt: 'desc' },
              take: perSourceTake,
              include: { guild: { select: { name: true } } },
            })
            .then((rows) => rows.map(toDataRequestErrorDto)),
        );
      }

      const merged = (await Promise.all(queries))
        .flat()
        .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

      const page = merged.slice(offset, offset + limit + 1);
      return buildPaginated(page, limit, offset);
    },
  );

  app.get(
    '/metrics/growth',
    { schema: { querystring: ownerMetricsGrowthQuerySchema }, preHandler: requireBotOwner() },
    async (request): Promise<OwnerMetricsGrowthDto> => {
      const days = Math.min(Math.max(request.query.days ?? GROWTH_DAYS_DEFAULT, GROWTH_DAYS_MIN), GROWTH_DAYS_MAX);
      const since = startOfUtcDay(new Date(Date.now() - (days - 1) * DAY_MS));

      // Filtered at the DB (only guilds that actually joined/left within the window — never the whole table),
      // then bucketed by UTC day in memory: Prisma's `groupBy` can't truncate a timestamp to a day boundary
      // without raw SQL, and the join/leave volume in any realistic window is small.
      const [joinedRows, leftRows] = await Promise.all([
        app.prisma.guild.findMany({ where: { joinedAt: { gte: since } }, select: { joinedAt: true } }),
        app.prisma.guild.findMany({ where: { leftAt: { gte: since } }, select: { leftAt: true } }),
      ]);

      const joinedByDay = new Map<string, number>();
      for (const row of joinedRows) {
        const key = toUtcDateString(row.joinedAt);
        joinedByDay.set(key, (joinedByDay.get(key) ?? 0) + 1);
      }
      const leftByDay = new Map<string, number>();
      for (const row of leftRows) {
        if (!row.leftAt) continue;
        const key = toUtcDateString(row.leftAt);
        leftByDay.set(key, (leftByDay.get(key) ?? 0) + 1);
      }

      const points: OwnerMetricsGrowthPointDto[] = [];
      let netTotal = 0;
      for (let i = 0; i < days; i++) {
        const date = toUtcDateString(new Date(since.getTime() + i * DAY_MS));
        const joined = joinedByDay.get(date) ?? 0;
        const left = leftByDay.get(date) ?? 0;
        netTotal += joined - left;
        points.push({ date, joined, left, netTotal });
      }

      return { points };
    },
  );

  /**
   * Fleet-wide feature usage: the per-guild daily analytics rollup, summed across every guild.
   *
   * Aggregate counts only — no user ids, no message content. This reads the same
   * `GuildAnalyticsDaily` rows the per-guild dashboard already shows, so it exposes nothing that
   * wasn't already being collected; it just answers "how much is the whole fleet using this?"
   * rather than "what happened in one server?".
   *
   * `date` is a DATE column (already truncated to a UTC day), so unlike /metrics/growth this can
   * group in the database rather than bucketing timestamps in memory.
   */
  app.get(
    '/metrics/usage',
    { schema: { querystring: ownerMetricsUsageQuerySchema }, preHandler: requireBotOwner() },
    async (request): Promise<OwnerMetricsUsageDto> => {
      const days = Math.min(Math.max(request.query.days ?? GROWTH_DAYS_DEFAULT, GROWTH_DAYS_MIN), GROWTH_DAYS_MAX);
      const since = startOfUtcDay(new Date(Date.now() - (days - 1) * DAY_MS));

      const [grouped, activeGuilds] = await Promise.all([
        app.prisma.guildAnalyticsDaily.groupBy({
          by: ['date'],
          where: { date: { gte: since } },
          _sum: {
            messages: true,
            moderationActions: true,
            automodTriggers: true,
            ticketsOpened: true,
            joins: true,
            leaves: true,
          },
        }),
        app.prisma.guildAnalyticsDaily.findMany({
          where: { date: { gte: since } },
          distinct: ['guildId'],
          select: { guildId: true },
        }),
      ]);

      const byDay = new Map(grouped.map((row) => [toUtcDateString(row.date), row._sum]));

      const points: OwnerMetricsUsagePointDto[] = [];
      const totals = {
        messages: 0,
        moderationActions: 0,
        automodTriggers: 0,
        ticketsOpened: 0,
        joins: 0,
        leaves: 0,
        activeGuilds: activeGuilds.length,
      };

      // Zero-fill every day in the window so the client can plot a continuous series.
      for (let i = 0; i < days; i++) {
        const date = toUtcDateString(new Date(since.getTime() + i * DAY_MS));
        const sums = byDay.get(date);
        const point: OwnerMetricsUsagePointDto = {
          date,
          messages: sums?.messages ?? 0,
          moderationActions: sums?.moderationActions ?? 0,
          automodTriggers: sums?.automodTriggers ?? 0,
          ticketsOpened: sums?.ticketsOpened ?? 0,
          joins: sums?.joins ?? 0,
          leaves: sums?.leaves ?? 0,
        };
        totals.messages += point.messages;
        totals.moderationActions += point.moderationActions;
        totals.automodTriggers += point.automodTriggers;
        totals.ticketsOpened += point.ticketsOpened;
        totals.joins += point.joins;
        totals.leaves += point.leaves;
        points.push(point);
      }

      return { points, totals };
    },
  );
}
