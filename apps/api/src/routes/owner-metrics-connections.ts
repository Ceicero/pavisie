import { buildPaginated, paginate } from '@pavisie/core';
import type {
  OwnerMetricsIntegrationProviderDto,
  OwnerMetricsIntegrationsDto,
  OwnerMetricsStatusCountsDto,
  OwnerMetricsTwitchChannelDto,
  OwnerMetricsTwitchDto,
  OwnerMetricsTwitchPointDto,
  Paginated,
} from '@pavisie/types';
import { requireBotOwner } from '../lib/bot-owner';
import type { ZodFastifyInstance } from '../lib/http';
import {
  ownerMetricsTwitchChannelsQuerySchema,
  ownerMetricsTwitchQuerySchema,
} from '../lib/owner-metrics/schemas';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_MIN = 1;
const DAYS_MAX = 365;
const DAYS_DEFAULT = 30;
/** Defensive cap — a provider's error string could be arbitrarily long (same bound as `lib/owner-metrics/dto.ts`). */
const ERROR_MESSAGE_MAX_CHARS = 500;

type StatusKey = keyof OwnerMetricsStatusCountsDto;

function emptyStatusCounts(): OwnerMetricsStatusCountsDto {
  return { connected: 0, disconnected: 0, error: 0, pending: 0 };
}

/** Prisma `ConnectionStatus` (`CONNECTED`) → the DTO's lower-case key. */
function toStatusKey(status: string): StatusKey {
  return status.toLowerCase() as StatusKey;
}

function tallyStatuses(groups: { status: string; _count: { _all: number } }[]): OwnerMetricsStatusCountsDto {
  const counts = emptyStatusCounts();
  for (const group of groups) {
    const key = toStatusKey(group.status);
    if (key in counts) counts[key] += group._count._all;
  }
  return counts;
}

function capMessage(message: string | null): string | null {
  if (message === null) return null;
  return message.length > ERROR_MESSAGE_MAX_CHARS ? `${message.slice(0, ERROR_MESSAGE_MAX_CHARS)}…` : message;
}

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC on the day `date` falls on. */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * `/owner/metrics/twitch*` and `/owner/metrics/integrations` — the "connections" half of the owner-only ops
 * metrics (the Discord half is `routes/owner-metrics.ts`). Same rules as that file: gated on bot-owner identity
 * (`requireBotOwner`), intentionally cross-guild, read-only. Aggregate counts and public channel logins only —
 * never a viewer id, chat content, or any token/credential column.
 */
export default async function ownerMetricsConnectionsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/metrics/twitch',
    { schema: { querystring: ownerMetricsTwitchQuerySchema }, preHandler: requireBotOwner() },
    async (request): Promise<OwnerMetricsTwitchDto> => {
      const days = Math.min(Math.max(request.query.days ?? DAYS_DEFAULT, DAYS_MIN), DAYS_MAX);
      const now = Date.now();
      const since = startOfUtcDay(new Date(now - (days - 1) * DAY_MS));
      const sevenDaysAgo = new Date(now - 7 * DAY_MS);
      const thirtyDaysAgo = new Date(now - 30 * DAY_MS);

      const [
        bot,
        channelStatusGroups,
        channelsEnabled,
        channelsGuildLinked,
        channelsLinked7d,
        channelsLinked30d,
        channelsRewardsEnabled,
        channelsBridgeEnabled,
        commands,
        timers,
        rewardActionGroups,
        economies,
        economiesEnabled,
        wallets,
        activeWallets7d,
        activeWallets30d,
        transactions7d,
        transactionTypeGroups,
        alertStatusGroups,
        linkedRows,
      ] = await Promise.all([
        app.prisma.twitchBotIdentity.findFirst({ select: { botLogin: true, status: true, lastError: true } }),
        app.prisma.twitchChatChannel.groupBy({ by: ['status'], _count: { _all: true } }),
        app.prisma.twitchChatChannel.count({ where: { enabled: true } }),
        app.prisma.twitchChatChannel.count({ where: { guildId: { not: null } } }),
        app.prisma.twitchChatChannel.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
        app.prisma.twitchChatChannel.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
        app.prisma.twitchChatChannel.count({ where: { rewardsEnabled: true } }),
        app.prisma.twitchChatChannel.count({
          where: { OR: [{ bridgeDiscordToTwitch: true }, { bridgeTwitchToDiscord: true }] },
        }),
        app.prisma.twitchChatCommand.count({ where: { enabled: true } }),
        app.prisma.twitchChatTimer.count({ where: { enabled: true } }),
        app.prisma.twitchChatReward.groupBy({
          by: ['action'],
          where: { enabled: true },
          _count: { _all: true },
        }),
        app.prisma.channelEconomy.count(),
        app.prisma.channelEconomy.count({ where: { enabled: true } }),
        app.prisma.channelWallet.count(),
        app.prisma.channelWallet.count({ where: { updatedAt: { gte: sevenDaysAgo } } }),
        app.prisma.channelWallet.count({ where: { updatedAt: { gte: thirtyDaysAgo } } }),
        app.prisma.channelTransaction.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
        // Grouped in the database: the ledger gets a row per earning chat message, so it is far too large to
        // pull into memory. The 30-day total below is just the sum of these groups.
        app.prisma.channelTransaction.groupBy({
          by: ['type'],
          where: { createdAt: { gte: thirtyDaysAgo } },
          _count: { _all: true },
        }),
        app.prisma.integrationConnection.groupBy({
          by: ['status'],
          where: { provider: 'TWITCH', deletedAt: null },
          _count: { _all: true },
        }),
        // Bucketed by UTC day in memory, like `/metrics/growth`: only the rows inside the window, and channel
        // links are low-volume (one row per streamer, ever).
        app.prisma.twitchChatChannel.findMany({
          where: { createdAt: { gte: since } },
          select: { createdAt: true },
        }),
      ]);

      const channelStatus = tallyStatuses(channelStatusGroups);
      const channelTotal =
        channelStatus.connected + channelStatus.disconnected + channelStatus.error + channelStatus.pending;

      const rewardsByAction = { sound: 0, tts: 0, chat: 0, discord: 0 };
      for (const group of rewardActionGroups) {
        const key = group.action.toLowerCase() as keyof typeof rewardsByAction;
        if (key in rewardsByAction) rewardsByAction[key] += group._count._all;
      }

      const transactionsByType30d = transactionTypeGroups
        .map((group) => ({ type: group.type, count: group._count._all }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

      const alertStatus = tallyStatuses(alertStatusGroups);

      const linkedByDay = new Map<string, number>();
      for (const row of linkedRows) {
        const key = toUtcDateString(row.createdAt);
        linkedByDay.set(key, (linkedByDay.get(key) ?? 0) + 1);
      }
      const points: OwnerMetricsTwitchPointDto[] = [];
      let runningTotal = 0;
      for (let i = 0; i < days; i++) {
        const date = toUtcDateString(new Date(since.getTime() + i * DAY_MS));
        const linked = linkedByDay.get(date) ?? 0;
        runningTotal += linked;
        points.push({ date, linked, runningTotal });
      }

      return {
        bot: bot
          ? {
              configured: true,
              login: bot.botLogin,
              status: toStatusKey(bot.status),
              lastError: capMessage(bot.lastError),
            }
          : { configured: false, login: null, status: null, lastError: null },
        channels: {
          total: channelTotal,
          enabled: channelsEnabled,
          status: channelStatus,
          guildLinked: channelsGuildLinked,
          standalone: channelTotal - channelsGuildLinked,
          linked7d: channelsLinked7d,
          linked30d: channelsLinked30d,
          rewardsEnabled: channelsRewardsEnabled,
          bridgeEnabled: channelsBridgeEnabled,
        },
        features: {
          commands,
          timers,
          rewards:
            rewardsByAction.sound + rewardsByAction.tts + rewardsByAction.chat + rewardsByAction.discord,
          rewardsByAction,
        },
        economy: {
          economies,
          enabled: economiesEnabled,
          wallets,
          activeWallets7d,
          activeWallets30d,
          transactions7d,
          transactions30d: transactionsByType30d.reduce((sum, row) => sum + row.count, 0),
          transactionsByType30d,
        },
        alerts: {
          total: alertStatus.connected + alertStatus.disconnected + alertStatus.error + alertStatus.pending,
          status: alertStatus,
        },
        points,
      };
    },
  );

  app.get(
    '/metrics/twitch/channels',
    { schema: { querystring: ownerMetricsTwitchChannelsQuerySchema }, preHandler: requireBotOwner() },
    async (request): Promise<Paginated<OwnerMetricsTwitchChannelDto>> => {
      const { cursor, limit: rawLimit, query, status } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });

      const rows = await app.prisma.twitchChatChannel.findMany({
        where: {
          ...(query ? { broadcasterLogin: { contains: query, mode: 'insensitive' as const } } : {}),
          ...(status ? { status: status.toUpperCase() as Uppercase<typeof status> } : {}),
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
        // An explicit `select`, not `include`: this model carries four encrypted secret columns, and naming
        // the fields means none of them is ever read out of the database for this list.
        select: {
          id: true,
          broadcasterLogin: true,
          enabled: true,
          status: true,
          guildId: true,
          rewardsEnabled: true,
          bridgeDiscordToTwitch: true,
          bridgeTwitchToDiscord: true,
          lastConnectedAt: true,
          lastError: true,
          createdAt: true,
          guild: { select: { name: true } },
          _count: { select: { commands: true, timers: true, rewards: true } },
        },
      });

      const items = rows.map((row): OwnerMetricsTwitchChannelDto => ({
        id: row.id,
        broadcasterLogin: row.broadcasterLogin,
        enabled: row.enabled,
        status: toStatusKey(row.status),
        guildId: row.guildId,
        guildName: row.guild?.name ?? null,
        commands: row._count.commands,
        timers: row._count.timers,
        rewards: row._count.rewards,
        rewardsEnabled: row.rewardsEnabled,
        bridgeEnabled: row.bridgeDiscordToTwitch || row.bridgeTwitchToDiscord,
        lastConnectedAt: row.lastConnectedAt ? row.lastConnectedAt.toISOString() : null,
        lastError: capMessage(row.lastError),
        linkedAt: row.createdAt.toISOString(),
      }));

      return buildPaginated(items, limit, offset);
    },
  );

  app.get(
    '/metrics/integrations',
    { preHandler: requireBotOwner() },
    async (): Promise<OwnerMetricsIntegrationsDto> => {
      const groups = await app.prisma.integrationConnection.groupBy({
        by: ['provider', 'status'],
        where: { deletedAt: null },
        _count: { _all: true },
      });

      const byProvider = new Map<string, OwnerMetricsIntegrationProviderDto>();
      const totals = { total: 0, status: emptyStatusCounts() };
      for (const group of groups) {
        const key = toStatusKey(group.status);
        if (!(key in totals.status)) continue;
        let row = byProvider.get(group.provider);
        if (!row) {
          row = { provider: group.provider, total: 0, status: emptyStatusCounts() };
          byProvider.set(group.provider, row);
        }
        row.total += group._count._all;
        row.status[key] += group._count._all;
        totals.total += group._count._all;
        totals.status[key] += group._count._all;
      }

      const providers = [...byProvider.values()].sort(
        (a, b) => b.total - a.total || a.provider.localeCompare(b.provider),
      );
      return { providers, totals };
    },
  );
}
