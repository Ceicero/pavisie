import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import type { GuildConfigDto, GuildOverviewDto, GuildSummary } from '@pavisie/types';
import { decryptAccessToken } from '../lib/session';
import { buildGuildIconUrl, getCachedUserGuilds, hasManageAccess } from '../lib/discord';
import { requireAuth, requireGuildAccess } from '../lib/guild-access';
import { buildPluginSummaries } from '../lib/plugin-summaries';
import { guildIdParamSchema } from '../lib/schemas';

function toGuildConfigDto(
  guildId: string,
  data: Awaited<ReturnType<ZodFastifyInstance['configStore']['getGuildConfig']>>,
): GuildConfigDto {
  return {
    guildId,
    locale: data.locale,
    timezone: data.timezone,
    adminRoleIds: data.adminRoleIds,
    modRoleIds: data.modRoleIds,
    helperRoleIds: data.helperRoleIds,
    modLogChannelId: data.modLogChannelId,
    staffChannelId: data.staffChannelId,
    fastActions: data.fastActions,
    dataCollectionEnabled: data.dataCollectionEnabled,
    logMessageContent: data.logMessageContent,
    dmOnModeration: data.dmOnModeration,
  };
}

const configPatchSchema = z.object({
  locale: z.string().min(2).max(10).optional(),
  timezone: z.string().min(1).max(64).optional(),
  adminRoleIds: z.array(z.string()).optional(),
  modRoleIds: z.array(z.string()).optional(),
  helperRoleIds: z.array(z.string()).optional(),
  modLogChannelId: z.string().nullable().optional(),
  staffChannelId: z.string().nullable().optional(),
  fastActions: z.boolean().optional(),
  dataCollectionEnabled: z.boolean().optional(),
  logMessageContent: z.boolean().optional(),
  dmOnModeration: z.boolean().optional(),
});

/** `/guilds` — guild selector list, per-guild overview, and core `GuildConfig` get/patch (ARCHITECTURE.md §10). */
export default async function guildsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireAuth }, async (request): Promise<GuildSummary[]> => {
    const session = request.session!;
    const accessToken = decryptAccessToken(session);
    const discordGuilds = await getCachedUserGuilds(app.redis, session.userId, accessToken);
    const manageable = discordGuilds.filter((g) => hasManageAccess(g.permissions, g.owner));

    if (manageable.length === 0) return [];

    const knownGuilds = await app.prisma.guild.findMany({
      where: { id: { in: manageable.map((g) => g.id) }, botPresent: true },
      select: { id: true, iconHash: true },
    });
    const botPresentIds = new Set(knownGuilds.map((g) => g.id));

    return manageable.map((g): GuildSummary => ({
      id: g.id,
      name: g.name,
      iconUrl: buildGuildIconUrl(g.id, g.icon),
      botPresent: botPresentIds.has(g.id),
      canManage: true,
      owner: g.owner,
    }));
  });

  // `allowBotAbsent`: unlike every other `/:guildId/*` route, the overview must still render (with
  // `guild.botPresent: false` and a setup issue) for a guild the user manages but hasn't added the bot to yet —
  // the dashboard lands here first, before "Add to server". The default `requireGuildAccess()` 404s in that
  // case, which would leave the page with nothing to show.
  app.get(
    '/:guildId',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess({ allowBotAbsent: true }) },
    async (request): Promise<GuildOverviewDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [guildRow, config, plugins, openTickets, pendingReviews, moderationCasesLast7d] = await Promise.all([
        app.prisma.guild.findUnique({ where: { id: guildId } }),
        app.configStore.getGuildConfig(guildId),
        buildPluginSummaries(app, guildId),
        app.prisma.ticket.count({ where: { guildId, status: 'OPEN' } }),
        app.prisma.enforcerRecord.count({ where: { guildId, kind: 'FLAG', status: 'PENDING' } }),
        app.prisma.moderationCase.count({ where: { guildId, createdAt: { gte: sevenDaysAgo } } }),
      ]);

      const botPresent = Boolean(guildRow?.botPresent);
      const guild: GuildOverviewDto['guild'] = guildRow
        ? {
            id: guildRow.id,
            name: guildRow.name,
            iconUrl: buildGuildIconUrl(guildRow.id, guildRow.iconHash),
            memberCount: guildRow.memberCount,
            ownerId: guildRow.ownerId,
            joinedAt: guildRow.joinedAt.toISOString(),
            botPresent,
            canManage: true,
            owner: guildRow.ownerId === session.userId,
          }
        : {
            id: guildId,
            name: 'Unknown server',
            iconUrl: null,
            memberCount: null,
            ownerId: null,
            joinedAt: null,
            botPresent: false,
            canManage: true,
            owner: false,
          };

      const pluginsEnabled = plugins.filter((p) => p.enabled).length;
      const pluginCount = plugins.length;

      const setupIssues: string[] = [];
      if (config.modLogChannelId === null) {
        setupIssues.push('No mod-log channel configured (set one under Settings).');
      }
      if (config.modRoleIds.length === 0) {
        setupIssues.push('No moderator roles configured (set them under Settings).');
      }
      if (!botPresent) {
        setupIssues.push('Pavisie is not in this server yet — invite it from the server list.');
      }

      return {
        guild,
        config: toGuildConfigDto(guildId, config),
        stats: {
          memberCount: guild.memberCount ?? undefined,
          pluginsEnabled,
          pluginCount,
          openTickets,
          pendingReviews,
          moderationCasesLast7d,
        },
        plugins,
        setupIncomplete: setupIssues.length > 0,
        setupIssues,
        pluginCount,
        pluginsEnabled,
      };
    },
  );

  app.get(
    '/:guildId/config',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<GuildConfigDto> => {
      const guildId = request.guildId!;
      const config = await app.configStore.getGuildConfig(guildId);
      return toGuildConfigDto(guildId, config);
    },
  );

  app.patch(
    '/:guildId/config',
    { schema: { params: guildIdParamSchema, body: configPatchSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<GuildConfigDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      // `configStore.updateGuildConfig` writes its own audit entry (before/after, source 'dashboard').
      const after = await app.configStore.updateGuildConfig(guildId, request.body, {
        id: session.userId,
        source: 'dashboard',
      });
      return toGuildConfigDto(guildId, after);
    },
  );
}
