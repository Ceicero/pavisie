import type { Guild } from 'discord.js';
import { redisKey } from '@pavisie/core';
import type { PluginContext, PluginJob } from '../../sdk';
import type { CommunityConfig } from '../manifest';
import { collectCounts, renderStatsName, RENAME_BUDGET_MS, type GuildCounts } from '../stats-channels';

/** Redis key holding the ISO timestamp of a guild's last stats refresh; doubles as the periodic-job gate (TTL = `statsRefreshMinutes`). */
export function statsLastKey(guildId: string): string {
  return redisKey('community', 'stats-last', guildId);
}

/** Redis NX key that throttles the "missing Manage Channels" warning to once per hour per guild. */
function statsNoPermKey(guildId: string): string {
  return redisKey('community', 'stats-noperm', guildId);
}

/**
 * Redis NX key throttling renames of ONE channel — Discord allows 2 renames per 10 minutes PER CHANNEL, but
 * `statsLastKey` above only gates how often a whole GUILD's refresh pass runs. That's not the same budget: a
 * guild with several stats channels, or an admin's manual `/statschannel refresh` landing between periodic
 * passes, could still push a single channel over its own 10-minute limit even while the guild-level gate holds.
 * TTL mirrors `RENAME_BUDGET_MS` (5 min) so at most ~2 renames land on one channel in any 10-minute window.
 */
export function statsChannelRenameKey(guildId: string, channelId: string): string {
  return redisKey('community', 'stats-rename', guildId, channelId);
}

const MISSING_PERMISSIONS_CODE = 50013;

export interface StatsRefreshResult {
  counts: GuildCounts;
  /** Channels whose name was changed. */
  renamed: number;
  /** Channels already showing the right name (no API call made). */
  unchanged: number;
  /** Config entries dropped because their channel no longer exists. */
  dropped: number;
  /** True if at least one rename failed with Missing Permissions (50013). */
  missingPermission: boolean;
}

/** Resolves the guild's configured timezone via the host service (falls back to UTC in tests / before the host registers). */
export async function guildTimezone(ctx: PluginContext, guildId: string): Promise<string> {
  const host = ctx.services.get('host');
  if (!host) return 'UTC';
  try {
    return (await host.getGuildConfig(guildId)).timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Renames every configured stats channel of `guild` to its rendered template. Missing channels are dropped from
 * config (info log). Rename failures never throw: 50013 is warned once per hour per guild; 429s are left to
 * discord.js's own queue (no manual retry). Records the refresh timestamp under `statsLastKey` with a TTL of
 * `cfg.statsRefreshMinutes` so the periodic job waits a full interval before the next automatic pass.
 */
export async function refreshGuildStats(
  ctx: PluginContext,
  guild: Guild,
  cfg: CommunityConfig,
  now = new Date(),
): Promise<StatsRefreshResult> {
  const tz = await guildTimezone(ctx, guild.id);
  const counts = collectCounts(guild, tz, { guildMembersIntent: ctx.intentsEnabled.guildMembers, now });
  const result: StatsRefreshResult = {
    counts,
    renamed: 0,
    unchanged: 0,
    dropped: 0,
    missingPermission: false,
  };

  await ctx.redis.set(statsLastKey(guild.id), now.toISOString(), 'EX', cfg.statsRefreshMinutes * 60);

  const kept: CommunityConfig['statsChannels'] = [];
  for (const entry of cfg.statsChannels) {
    const channel = guild.channels.cache.get(entry.channelId);
    if (!channel) {
      result.dropped += 1;
      ctx.logger.info(
        { guildId: guild.id, channelId: entry.channelId },
        'community: stats channel no longer exists — removing it from config',
      );
      continue;
    }
    kept.push(entry);

    const name = renderStatsName(entry.template, counts);
    if (channel.name === name) {
      result.unchanged += 1;
      continue;
    }

    const claimedBudget = await ctx.redis.set(
      statsChannelRenameKey(guild.id, entry.channelId),
      '1',
      'EX',
      Math.floor(RENAME_BUDGET_MS / 1000),
      'NX',
    );
    if (!claimedBudget) {
      // This channel was already renamed within the last RENAME_BUDGET_MS — try again next pass rather than
      // risk Discord's per-channel rename limit.
      result.unchanged += 1;
      continue;
    }

    try {
      await channel.setName(name, 'Server stats');
      result.renamed += 1;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === MISSING_PERMISSIONS_CODE) {
        result.missingPermission = true;
        const first = await ctx.redis.set(statsNoPermKey(guild.id), '1', 'EX', 3600, 'NX');
        if (first) {
          ctx.logger.warn(
            { guildId: guild.id, channelId: entry.channelId },
            'community: cannot rename stats channel — missing Manage Channels',
          );
        }
      } else {
        // 429s are queued/retried by discord.js's REST layer; anything else is logged and skipped this tick.
        ctx.logger.warn(
          {
            guildId: guild.id,
            channelId: entry.channelId,
            err: err instanceof Error ? err.message : String(err),
          },
          'community: stats channel rename failed',
        );
      }
    }
  }

  if (result.dropped > 0) {
    await ctx.setConfig<CommunityConfig>(
      guild.id,
      { statsChannels: kept },
      { id: ctx.client.user.id, source: 'system' },
    );
  }

  return result;
}

/**
 * Periodic pass over every guild with stats channels. Runs every 5 minutes but each guild is refreshed at most
 * once per `statsRefreshMinutes` (min 10) via a Redis `SET NX EX` gate — Discord allows only 2 channel renames
 * per 10 minutes per channel, and member join/leave events deliberately do NOT trigger a refresh.
 */
export const statsRefreshJob: PluginJob<Record<string, never>> = {
  name: 'stats-refresh',
  repeat: { pattern: '*/5 * * * *' },
  concurrency: 1,
  async processor(ctx) {
    for (const guild of ctx.client.guilds.cache.values()) {
      // An unavailable guild (regional Discord outage) has an empty channel cache — without this check its
      // stats channels would all look "deleted" and get wiped from config.
      if (!guild.available) continue;
      try {
        if (!(await ctx.isEnabled(guild.id))) continue;
        const cfg = await ctx.getConfig<CommunityConfig>(guild.id);
        if (!cfg.statsChannels || cfg.statsChannels.length === 0) continue;

        const claimed = await ctx.redis.set(
          statsLastKey(guild.id),
          new Date().toISOString(),
          'EX',
          cfg.statsRefreshMinutes * 60,
          'NX',
        );
        if (!claimed) continue;

        await refreshGuildStats(ctx, guild, cfg);
      } catch (err) {
        ctx.logger.error(
          { guildId: guild.id, err: err instanceof Error ? err.message : String(err) },
          'community: stats-refresh failed for a guild',
        );
      }
    }
  },
};
