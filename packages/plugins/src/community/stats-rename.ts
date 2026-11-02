import { RateLimitError, REST, Routes } from 'discord.js';
import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';
import { CHANNEL_RENAME_INTERVAL_MS } from './stats-channels';

const MISSING_ACCESS_CODE = 50001;
const MISSING_PERMISSIONS_CODE = 50013;
const RENAME_REASON = 'Server stats';

/**
 * Redis NX key throttling renames of ONE channel. Discord allows 2 renames per 10 minutes per channel;
 * the guild-level refresh gate is a different budget. The value is the ISO time of the attempt and the TTL is
 * `CHANNEL_RENAME_INTERVAL_MS` (10 min). A rate limit does not extend that TTL or queue a retry.
 */
export function statsChannelRenameKey(guildId: string, channelId: string): string {
  return redisKey('community', 'stats-rename', guildId, channelId);
}

/** discord.js throws instead of sleeping in the rate-limit queue when this returns true. */
export function rejectStatsRenameRateLimit(): true {
  return true;
}

export interface StatsRenameChannel {
  id: string;
  name: string;
  setName?: (name: string, reason?: string) => Promise<unknown>;
  client?: { token?: string | null } | null;
}

export type StatsRenameStatus =
  | 'renamed'
  | 'unchanged'
  | 'throttled'
  | 'rate_limited'
  | 'missing_permission'
  | 'failed';

export interface StatsRenameResult {
  status: StatsRenameStatus;
  error?: unknown;
}

const restByToken = new Map<string, REST>();

/**
 * REST client used only for stats renames. `rejectOnRateLimit` makes a 429 throw `RateLimitError`
 * instead of waiting out Discord's retry queue (channel-name sublimits can sit there for minutes).
 * Sweepers are off so a short-lived process does not keep interval handles alive.
 */
export function statsRenameRest(token: string): REST {
  let rest = restByToken.get(token);
  if (!rest) {
    rest = new REST({
      rejectOnRateLimit: rejectStatsRenameRateLimit,
      hashSweepInterval: 0,
      handlerSweepInterval: 0,
    }).setToken(token);
    restByToken.set(token, rest);
  }
  return rest;
}

function discordCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function isMissingChannelPermission(err: unknown): boolean {
  const code = discordCode(err);
  return code === MISSING_PERMISSIONS_CODE || code === MISSING_ACCESS_CODE;
}

function isRateLimitError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { name?: string; code?: unknown; status?: unknown };
  return candidate.name === 'RateLimitError' || candidate.code === 429 || candidate.status === 429;
}

async function applyStatsRename(channel: StatsRenameChannel, name: string): Promise<void> {
  const token = channel.client?.token;
  if (token) {
    // A dedicated REST client does not join the bot's shared queue, so a rename already waiting
    // on another channel edit cannot block this one. A 429 rejects immediately.
    await statsRenameRest(token).patch(Routes.channel(channel.id), {
      body: { name },
      reason: RENAME_REASON,
    });
    return;
  }
  if (typeof channel.setName !== 'function') {
    throw new Error('stats channel cannot be renamed');
  }
  await channel.setName(name, RENAME_REASON);
}

/**
 * Renames one stats channel. Skips when the name already matches. Claims the per-channel Redis budget
 * (one rename per `CHANNEL_RENAME_INTERVAL_MS`) before calling Discord. A rate limit is returned as
 * `rate_limited` and is not retried or awaited.
 *
 * Both the periodic stats-refresh job and `/statschannel refresh` go through `refreshGuildStats`, which
 * calls this for every configured channel.
 */
export async function renameStatsChannel(
  redis: Redis,
  guildId: string,
  channel: StatsRenameChannel,
  name: string,
  now = new Date(),
): Promise<StatsRenameResult> {
  if (channel.name === name) return { status: 'unchanged' };

  const claimed = await redis.set(
    statsChannelRenameKey(guildId, channel.id),
    now.toISOString(),
    'EX',
    Math.floor(CHANNEL_RENAME_INTERVAL_MS / 1000),
    'NX',
  );
  if (!claimed) return { status: 'throttled' };

  try {
    await applyStatsRename(channel, name);
    return { status: 'renamed' };
  } catch (err) {
    if (isRateLimitError(err)) return { status: 'rate_limited', error: err };
    if (isMissingChannelPermission(err)) return { status: 'missing_permission', error: err };
    return { status: 'failed', error: err };
  }
}
