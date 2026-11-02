import { createHash } from 'node:crypto';
import type { Guild } from 'discord.js';
import { redisKey } from '@pavisie/core';
import type { PluginContext, PluginJob } from '../../sdk';
import type { CommunityConfig } from '../manifest';
import {
  CHANNEL_RENAME_INTERVAL_MS,
  collectCounts,
  renderStatsName,
  type GuildCounts,
} from '../stats-channels';

/** Redis key holding the ISO timestamp of a guild's last stats refresh; doubles as the periodic-job gate (TTL = `statsRefreshMinutes`). */
export function statsLastKey(guildId: string): string {
  return redisKey('community', 'stats-last', guildId);
}

/**
 * Redis key set when a rename hits a permission error. Its value is `statsPermissionFingerprint` at that moment;
 * the periodic job skips the guild while the fingerprint still matches, i.e. until the stats config or the bot's
 * permissions on those channels change. Without it a guild that hid a stats channel from the bot got two failed
 * API calls (and two log lines) every refresh, forever.
 */
export function statsBlockedKey(guildId: string): string {
  return redisKey('community', 'stats-blocked', guildId);
}

/**
 * Redis NX key throttling renames of ONE channel — Discord allows 2 renames per 10 minutes PER CHANNEL, but
 * `statsLastKey` above only gates how often a whole GUILD's refresh pass runs. That's not the same budget: a
 * guild with several stats channels, or an admin's manual `/statschannel refresh` landing between periodic
 * passes, could still push a single channel over its own 10-minute limit even while the guild-level gate holds.
 * The value is the ISO time of the last rename and the TTL is `CHANNEL_RENAME_INTERVAL_MS` (10 min), or Discord's
 * `retry_after` when a rename was rate limited.
 */
export function statsChannelRenameKey(guildId: string, channelId: string): string {
  return redisKey('community', 'stats-rename', guildId, channelId);
}

const MISSING_ACCESS_CODE = 50001;
const MISSING_PERMISSIONS_CODE = 50013;
/** Safety-net expiry for `statsBlockedKey` so a guild the bot left doesn't keep a key forever. */
const BLOCKED_TTL_SECONDS = 30 * 24 * 3600;

/**
 * Short hash of everything that decides whether this guild's renames can succeed: each configured channel, its
 * template, and the bot's computed permissions on it. Changing the config or fixing a role/overwrite changes it.
 */
export function statsPermissionFingerprint(
  guild: Guild,
  statsChannels: CommunityConfig['statsChannels'],
): string {
  const me = guild.members.me;
  const parts = statsChannels.map((entry) => {
    const channel = guild.channels.cache.get(entry.channelId);
    const perms = me && channel ? (channel.permissionsFor(me)?.bitfield.toString() ?? '') : '';
    return `${entry.channelId}\t${entry.template}\t${perms}`;
  });
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

function discordErrorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

/**
 * How long Discord told us to wait, in ms, if `err` is a rate limit: `@discordjs/rest`'s RateLimitError carries
 * `retryAfter` (ms) / `sublimitTimeout`, a raw 429 response carries `retry_after` (seconds). `null` otherwise.
 */
export function rateLimitRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    status?: unknown;
    retryAfter?: unknown;
    sublimitTimeout?: unknown;
    rawError?: { retry_after?: unknown };
  };
  if (typeof e.retryAfter === 'number') {
    return Math.max(e.retryAfter, typeof e.sublimitTimeout === 'number' ? e.sublimitTimeout : 0);
  }
  if (e.status === 429) {
    const seconds = e.rawError?.retry_after;
    return typeof seconds === 'number' ? Math.ceil(seconds * 1000) : CHANNEL_RENAME_INTERVAL_MS;
  }
  return null;
}

export interface StatsRefreshResult {
  counts: GuildCounts;
  /** Channels whose name was changed. */
  renamed: number;
  /** Channels already showing the right name, or skipped by the per-channel throttle (no API call made). */
  unchanged: number;
  /** Config entries dropped because their channel no longer exists. */
  dropped: number;
  /** True if a rename failed with Missing Permissions (50013) or Missing Access (50001). */
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
 * config (info log). Rename failures never throw:
 * - 50013 Missing Permissions / 50001 Missing Access stop renames for the rest of the guild and set
 *   `statsBlockedKey`, so the periodic job leaves the guild alone until its config or the bot's permissions change
 *   (warned once per change, naming the guild).
 * - A rate limit pushes that channel's throttle out to Discord's `retry_after`; nothing retries early.
 * - Anything else is warned with the Discord error code and skipped this pass.
 * Records the refresh timestamp under `statsLastKey` with a TTL of `cfg.statsRefreshMinutes` so the periodic job
 * waits a full interval before the next automatic pass.
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
  let permissionError: { channelId: string; code: unknown; message: string } | null = null;
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
    // Keep walking the list after a permission error so `kept` stays complete, but make no more API calls.
    if (permissionError) continue;

    const name = renderStatsName(entry.template, counts);
    if (channel.name === name) {
      result.unchanged += 1;
      continue;
    }

    const renameKey = statsChannelRenameKey(guild.id, entry.channelId);
    const claimedBudget = await ctx.redis.set(
      renameKey,
      now.toISOString(),
      'EX',
      Math.floor(CHANNEL_RENAME_INTERVAL_MS / 1000),
      'NX',
    );
    if (!claimedBudget) {
      // This channel was renamed (or rate limited) too recently — try again next pass rather than risk
      // Discord's per-channel rename limit.
      result.unchanged += 1;
      continue;
    }

    try {
      await channel.setName(name, 'Server stats');
      result.renamed += 1;
    } catch (err) {
      const code = discordErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      const retryAfterMs = rateLimitRetryAfterMs(err);
      if (code === MISSING_PERMISSIONS_CODE || code === MISSING_ACCESS_CODE) {
        result.missingPermission = true;
        permissionError = { channelId: entry.channelId, code, message };
      } else if (retryAfterMs !== null) {
        const waitMs = Math.max(retryAfterMs, CHANNEL_RENAME_INTERVAL_MS);
        await ctx.redis.set(renameKey, now.toISOString(), 'EX', Math.ceil(waitMs / 1000));
        ctx.logger.warn(
          { guildId: guild.id, channelId: entry.channelId, code, retryAfterMs },
          'community: stats channel rename rate limited — waiting out retry_after',
        );
      } else {
        ctx.logger.warn(
          { guildId: guild.id, channelId: entry.channelId, code, err },
          `community: stats channel rename failed: ${message}`,
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

  const blockedKey = statsBlockedKey(guild.id);
  if (permissionError) {
    const fingerprint = statsPermissionFingerprint(guild, kept);
    const previous = await ctx.redis.get(blockedKey);
    await ctx.redis.set(blockedKey, fingerprint, 'EX', BLOCKED_TTL_SECONDS);
    if (previous !== fingerprint) {
      ctx.logger.warn(
        { guildId: guild.id, guildName: guild.name, ...permissionError },
        `community: can't rename stats channels in guild "${guild.name}" (${guild.id}) — missing Manage Channels ` +
          "or View Channel. Pausing automatic stats renames there until its stats config or the bot's permissions change",
      );
    }
  } else if (result.renamed > 0) {
    await ctx.redis.del(blockedKey);
  }

  return result;
}

/**
 * Periodic pass over every guild with stats channels. Runs every 5 minutes but each guild is refreshed at most
 * once per `statsRefreshMinutes` (min 10) via a Redis `SET NX EX` gate — Discord allows only 2 channel renames
 * per 10 minutes per channel, and member join/leave events deliberately do NOT trigger a refresh. Guilds paused
 * by a permission error (`statsBlockedKey`) are skipped until their fingerprint changes.
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

        const blocked = await ctx.redis.get(statsBlockedKey(guild.id));
        if (blocked) {
          if (blocked === statsPermissionFingerprint(guild, cfg.statsChannels)) continue;
          await ctx.redis.del(statsBlockedKey(guild.id));
          ctx.logger.info(
            { guildId: guild.id, guildName: guild.name },
            'community: stats config or bot permissions changed — retrying stats channel renames',
          );
        }

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
        ctx.logger.error({ guildId: guild.id, err }, 'community: stats-refresh failed for a guild');
      }
    }
  },
};
