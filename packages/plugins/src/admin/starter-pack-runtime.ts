// The bot-side half of the streamer starter pack: builds the real `StarterDeps` (discord.js, Prisma, the host
// service) for one guild and runs `applyStreamerStarter` under a per-guild lock, then audit-logs it. Both
// `/setup streamer` and the dashboard's bot-action (via the `admin` service, see index.ts) call `runStreamerStarter`.
import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { AuditAction, redisKey } from '@pavisie/core';
import type { Prisma } from '@pavisie/database';
import type { StreamerStarterReportDto } from '@pavisie/types';
import type { PluginContext } from '../sdk';
import type { CommunityConfig } from '../community/manifest';
import type { EngagementConfig } from '../engagement/manifest';
import { guildTimezone } from '../community/jobs/stats-refresh';
import { collectCounts, renderStatsName } from '../community/stats-channels';
import { createAlertConnection } from '../integrations/connections';
import { getProvider, PROVIDER_ENUM_MAP } from '../integrations/providers';
import { readAlertConfig } from '../integrations/providers/util';
import { isProviderEnvSatisfied } from '../integrations/providers/types';
import { normalizeTwitchLogin } from '../integrations/providers/twitch';
import { automodRuleConfigSchema } from '../automod/schemas';
import {
  STARTER_STATS_CATEGORY_NAME,
  applyStreamerStarter,
  type StarterDeps,
  type StarterInput,
  type StarterPluginId,
} from './starter-pack';

const LOCK_TTL_SECONDS = 120;

export interface StreamerStarterActor {
  id: string;
  source: 'bot' | 'dashboard';
}

export class StarterAlreadyRunningError extends Error {
  constructor() {
    super('The streamer starter pack is already running for this server.');
    this.name = 'StarterAlreadyRunningError';
  }
}

/** Builds the real dependencies of `applyStreamerStarter` for one guild. Exported for the wiring test. */
export function buildStarterDeps(
  ctx: PluginContext,
  guild: Guild,
  actor: StreamerStarterActor,
  t: StarterDeps['t'],
): StarterDeps {
  const host = ctx.services.require('host');
  const hostActor = { id: actor.id, source: actor.source };
  const guildId = guild.id;

  return {
    t,
    pluginName: (id: StarterPluginId) => host.getManifest(id)?.name ?? id,
    plugins: {
      availability: (id) =>
        host.getPluginAvailability().get(id) ?? { available: false, reason: 'not loaded' },
      isEnabled: (id) => host.isPluginEnabled(guildId, id),
      enable: (id) => host.enable(guildId, id, hostActor),
      getCommunityConfig: () => host.getPluginConfig<CommunityConfig>(guildId, 'community'),
      setCommunityConfig: async (patch) => {
        await host.setPluginConfig<CommunityConfig>(guildId, 'community', patch, hostActor);
      },
      getEngagementConfig: () => host.getPluginConfig<EngagementConfig>(guildId, 'engagement'),
      setEngagementConfig: async (patch) => {
        await host.setPluginConfig<EngagementConfig>(guildId, 'engagement', patch, hostActor);
      },
    },
    twitch: {
      configured: () => {
        const provider = getProvider('twitch');
        return provider ? isProviderEnvSatisfied(provider.requiredEnv, ctx.env) : false;
      },
      normalizeLogin: normalizeTwitchLogin,
      watchedLogins: async () => {
        const rows = await ctx.prisma.integrationConnection.findMany({
          where: {
            guildId,
            provider: PROVIDER_ENUM_MAP.twitch,
            deletedAt: null,
            status: { not: 'DISCONNECTED' },
          },
        });
        return (
          rows
            .map((row) => readAlertConfig(row))
            // Only alert watches carry a posting channel; chat-kind rows on the same provider do not.
            .filter((config) => config.channelId !== '' && config.target !== '')
            .map((config) => config.target.toLowerCase())
        );
      },
      createAlert: async (login, channelId) => {
        // The same call `/integration alerts add` makes, so the login is validated identically and an unknown
        // Twitch user comes back as a `ValidationError` ("Twitch user "x" not found.").
        await createAlertConnection(ctx, guildId, actor.id, actor.source, {
          provider: 'twitch',
          target: login,
          channelId,
        });
      },
      channelProblem: async (channelId) => {
        const me = guild.members.me;
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel) return 'View Channel';
        if (!me) return null;
        const perms = channel.permissionsFor(me);
        const missing = [
          ['View Channel', PermissionFlagsBits.ViewChannel],
          ['Send Messages', PermissionFlagsBits.SendMessages],
          ['Embed Links', PermissionFlagsBits.EmbedLinks],
        ].filter(([, bit]) => !perms?.has(bit as bigint));
        return missing.length > 0 ? missing.map(([name]) => name).join(', ') : null;
      },
    },
    stats: {
      canManageChannels: () => guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false,
      createChannel: async (template) => {
        const tz = await guildTimezone(ctx, guildId);
        const counts = collectCounts(guild, tz, { guildMembersIntent: ctx.intentsEnabled.guildMembers });
        const name = renderStatsName(template, counts);

        const channels = await guild.channels.fetch();
        const existingCategory = channels.find(
          (channel) =>
            channel?.type === ChannelType.GuildCategory && channel.name === STARTER_STATS_CATEGORY_NAME,
        );
        const category =
          existingCategory ??
          (await guild.channels.create({
            name: STARTER_STATS_CATEGORY_NAME,
            type: ChannelType.GuildCategory,
            reason: 'Streamer starter pack: server stats',
          }));

        const voice = await guild.channels.create({
          name,
          type: ChannelType.GuildVoice,
          parent: category.id,
          reason: 'Streamer starter pack: server stats counter',
          // Visible to everyone, joinable by no one — it is only a label in the channel list.
          permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }],
        });
        return { channelId: voice.id };
      },
      deleteChannel: async (channelId) => {
        await guild.channels.delete(channelId, 'Streamer starter pack: could not save the stats channel');
      },
    },
    automod: {
      existingRuleTypes: async () => {
        const rows = await ctx.prisma.automodRule.findMany({
          where: { guildId, deletedAt: null },
          select: { type: true },
        });
        return rows.map((row) => row.type);
      },
      createRule: async (rule) => {
        // Same shape and the same defaults as a rule made with `/automod rule create`: enabled, but in dry-run until
        // the admin clears it, so nothing is deleted before they have seen the matches in the log.
        const config = automodRuleConfigSchema.parse(rule.config);
        const created = await ctx.prisma.automodRule.create({
          data: {
            guildId,
            name: rule.name,
            type: rule.type,
            enabled: true,
            dryRun: true,
            config: config as unknown as Prisma.InputJsonValue,
            actions: rule.actions as unknown as Prisma.InputJsonValue,
            exemptRoleIds: [],
            exemptChannelIds: [],
            exemptUserIds: [],
            trustedDomains: [],
            cooldownSeconds: 0,
            priority: 0,
            createdBy: actor.id,
          },
        });
        await ctx.audit({
          guildId,
          actorId: actor.id,
          actorType: 'user',
          action: AuditAction.AutomodRuleCreate,
          targetType: 'automod_rule',
          targetId: created.id,
          after: { name: created.name, type: created.type },
          source: actor.source,
        });
      },
    },
    logger: { warn: (obj, msg) => ctx.logger.warn(obj, msg) },
  };
}

export interface RunStreamerStarterOptions {
  ctx: PluginContext;
  guild: Guild;
  input: StarterInput;
  actor: StreamerStarterActor;
  t: StarterDeps['t'];
}

/**
 * Runs the preset for a guild: one run at a time per server (a second concurrent run would race the same
 * "does it exist yet" checks and could create duplicate channels), then one audit entry summarising the outcome.
 * Throws `StarterAlreadyRunningError` when another run holds the lock.
 */
export async function runStreamerStarter(opts: RunStreamerStarterOptions): Promise<StreamerStarterReportDto> {
  const { ctx, guild, input, actor, t } = opts;
  const lockKey = redisKey('admin', 'streamer-starter', 'lock', guild.id);
  const acquired = await ctx.redis.set(lockKey, actor.id, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (acquired !== 'OK') throw new StarterAlreadyRunningError();

  try {
    const report = await applyStreamerStarter(buildStarterDeps(ctx, guild, actor, t), guild.id, input);

    await ctx.audit({
      guildId: guild.id,
      actorId: actor.id,
      actorType: 'user',
      action: AuditAction.SetupStreamerStarter,
      targetType: 'guild_config',
      targetId: guild.id,
      after: {
        twitchLogin: input.twitchLogin?.trim() ? input.twitchLogin.trim().slice(0, 60) : null,
        alertChannelId: input.alertChannelId,
        steps: Object.fromEntries(report.steps.map((step) => [step.id, step.status])),
      },
      source: actor.source,
    });
    return report;
  } finally {
    await ctx.redis.del(lockKey).catch(() => undefined);
  }
}
