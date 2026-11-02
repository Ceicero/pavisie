import { redisKey } from '@pavisie/core';
import type { PluginContext } from '../sdk';
import { CHANNEL_RENAME_INTERVAL_MS } from './stats-channels';

/**
 * The single place that renames a stats channel. Both the periodic `stats-refresh` job and a manual
 * `/statschannel refresh` go through `renameStatsChannel`, so they can't disagree about the rules:
 * - nothing is sent when the channel already shows the right name;
 * - at most one rename per channel per 10 minutes, shared through Redis (Discord allows 2 per 10 minutes per
 *   channel — one is the margin that keeps a manual refresh and the next periodic pass from colliding);
 * - a rate limit is skipped, never waited out, and pushes the channel's Redis key out to Discord's `retry_after`;
 * - a permission error is reported to the caller, which pauses the guild;
 * - any other failure is logged with Discord's error code and message.
 */

const MISSING_ACCESS_CODE = 50001;
const MISSING_PERMISSIONS_CODE = 50013;

/**
 * Redis key throttling renames of ONE channel — Discord allows 2 renames per 10 minutes PER CHANNEL, but
 * `statsLastKey` only gates how often a whole GUILD's refresh pass runs. That's not the same budget: a guild with
 * several stats channels, or an admin's manual `/statschannel refresh` landing between periodic passes, could
 * still push a single channel over its own 10-minute limit even while the guild-level gate holds.
 * The value is the ISO time of the last rename and the TTL is `CHANNEL_RENAME_INTERVAL_MS` (10 min), or Discord's
 * `retry_after` when a rename was rate limited.
 */
export function statsChannelRenameKey(guildId: string, channelId: string): string {
  return redisKey('community', 'stats-rename', guildId, channelId);
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

/** What `renameStatsChannel` did, so the caller can tally it and decide whether to pause the guild. */
export type StatsRenameOutcome =
  /** The channel was renamed. */
  | { status: 'renamed' }
  /** The channel already shows the right name; no API call, no rename budget spent. */
  | { status: 'unchanged' }
  /** The channel was renamed or rate limited too recently (Redis); no API call. */
  | { status: 'throttled' }
  /** Discord rate limited the rename; skipped, and the channel's throttle now lasts at least `retryAfterMs`. */
  | { status: 'rate-limited'; retryAfterMs: number }
  /** 50013 Missing Permissions / 50001 Missing Access: the caller should pause the guild's automatic renames. */
  | { status: 'no-permission'; code: unknown; message: string }
  /** Any other failure; already logged. */
  | { status: 'failed' };

/** The part of a discord.js guild channel (text, voice, category, thread...) a rename needs. */
export interface RenameableChannel {
  id: string;
  name: string;
  setName(name: string, reason?: string): Promise<unknown>;
}

/**
 * Renames `channel` to `name` under the rules in this file's header. Never throws for a failed rename; the only
 * possible rejections are Redis errors. `now` is stamped into the channel's Redis key (defaults to the current time).
 */
export async function renameStatsChannel(
  ctx: Pick<PluginContext, 'redis' | 'logger'>,
  guildId: string,
  channel: RenameableChannel,
  name: string,
  now = new Date(),
): Promise<StatsRenameOutcome> {
  if (channel.name === name) return { status: 'unchanged' };

  const renameKey = statsChannelRenameKey(guildId, channel.id);
  const claimed = await ctx.redis.set(
    renameKey,
    now.toISOString(),
    'EX',
    Math.floor(CHANNEL_RENAME_INTERVAL_MS / 1000),
    'NX',
  );
  // Renamed (or rate limited) too recently — try again on a later pass rather than risk Discord's per-channel limit.
  if (!claimed) return { status: 'throttled' };

  try {
    await channel.setName(name, 'Server stats');
    return { status: 'renamed' };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    const retryAfterMs = rateLimitRetryAfterMs(err);
    if (code === MISSING_PERMISSIONS_CODE || code === MISSING_ACCESS_CODE) {
      return { status: 'no-permission', code, message };
    }
    if (retryAfterMs !== null) {
      const waitMs = Math.max(retryAfterMs, CHANNEL_RENAME_INTERVAL_MS);
      await ctx.redis.set(renameKey, now.toISOString(), 'EX', Math.ceil(waitMs / 1000));
      ctx.logger.warn(
        { guildId, channelId: channel.id, code, retryAfterMs },
        'community: stats channel rename rate limited — waiting out retry_after',
      );
      return { status: 'rate-limited', retryAfterMs };
    }
    ctx.logger.warn(
      { guildId, channelId: channel.id, code, err },
      `community: stats channel rename failed: ${message}`,
    );
    return { status: 'failed' };
  }
}
