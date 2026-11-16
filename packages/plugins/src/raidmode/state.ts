// Redis state for raid mode, and the one call each join makes.
//
// The join path must not slow down a raid (the #25 benchmark is the gate), so a join costs exactly one Redis
// round trip: a Lua script that adds the join to the sliding window, returns the window totals, and — only while
// an incident is active — adds the join to that incident's counters and queues its score. Database writes happen
// in the incident's update job, in batches, never per join.
//
// The window counts distinct members, not join events: a member leaving and rejoining inside the window is only
// counted once, so a few accounts looping leave/join cannot fake a raid.
//
// Counters and queued scores are keyed by incident id, not by guild. Ending one incident and starting the next
// can therefore never mix or wipe the other's data, and a failed flush can be retried from the same keys.
import { redisKey } from '@pavisie/core';
import type { PluginContext } from '../sdk';
import type { RiskLevel } from './scoring';

/** Window buckets are this wide; the window is a whole number of buckets. */
const BUCKET_MS = 5_000;

export function windowKey(guildId: string): string {
  return redisKey('raidmode', 'window', guildId);
}
/** "This member was already counted in the current window." Expires with the window. */
export function seenKey(guildId: string, userId: string): string {
  return redisKey('raidmode', 'seen', guildId, userId);
}
/** Holds the active incident's id. Its existence is what "an incident is active" means. */
export function activeKey(guildId: string): string {
  return redisKey('raidmode', 'active', guildId);
}
/** Prefix of the per-incident keys; the Lua scripts append the incident id. */
function countsPrefix(): string {
  return `${redisKey('raidmode', 'counts')}:`;
}
function scoresPrefix(): string {
  return `${redisKey('raidmode', 'scores')}:`;
}
export function countsKey(incidentId: string): string {
  return `${countsPrefix()}${incidentId}`;
}
export function pendingScoresKey(incidentId: string): string {
  return `${scoresPrefix()}${incidentId}`;
}
/** Set after an incident ends or a lockdown is restored: while it exists, a new incident alerts but never auto-locks. */
export function cooldownKey(guildId: string): string {
  return redisKey('raidmode', 'cooldown', guildId);
}

/**
 * KEYS: window, active, seen-member.
 * ARGV: now, bucketMs, windowMs, isNewAccount (0/1), level, scorePayload ('' when nothing to store), stateTtlSec,
 *       countsPrefix, scoresPrefix.
 * Returns { windowTotal, windowNew, activeIncidentId or '' }.
 */
const RECORD_JOIN_SCRIPT = `
local now = tonumber(ARGV[1])
local bucketMs = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])
local buckets = math.ceil(windowMs / bucketMs)
local b = math.floor(now / bucketMs)
local firstSight = redis.call('SET', KEYS[3], '1', 'NX', 'PX', windowMs)
if firstSight then
  redis.call('HINCRBY', KEYS[1], 't' .. b, 1)
  if ARGV[4] == '1' then redis.call('HINCRBY', KEYS[1], 'n' .. b, 1) end
end
redis.call('HDEL', KEYS[1], 't' .. (b - buckets), 'n' .. (b - buckets))
if redis.call('HLEN', KEYS[1]) > (buckets * 2 + 8) then
  for _, field in ipairs(redis.call('HKEYS', KEYS[1])) do
    if tonumber(string.sub(field, 2)) <= b - buckets then redis.call('HDEL', KEYS[1], field) end
  end
end
redis.call('PEXPIRE', KEYS[1], windowMs + bucketMs)
local total = 0
local newc = 0
for i = b - buckets + 1, b do
  total = total + tonumber(redis.call('HGET', KEYS[1], 't' .. i) or '0')
  newc = newc + tonumber(redis.call('HGET', KEYS[1], 'n' .. i) or '0')
end
local active = redis.call('GET', KEYS[2])
if active and firstSight then
  local counts = ARGV[8] .. active
  local scores = ARGV[9] .. active
  redis.call('HINCRBY', counts, 'joins', 1)
  redis.call('HINCRBY', counts, ARGV[5], 1)
  if ARGV[5] ~= 'low' then redis.call('HINCRBY', counts, 'flagged', 1) end
  redis.call('HSET', counts, 'lastJoinAt', ARGV[1])
  if ARGV[6] ~= '' then redis.call('RPUSH', scores, ARGV[6]) end
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))
  redis.call('EXPIRE', counts, tonumber(ARGV[7]))
  redis.call('EXPIRE', scores, tonumber(ARGV[7]))
end
return {total, newc, active or ''}
`;

export interface JoinRecordResult {
  windowTotal: number;
  windowNew: number;
  activeIncidentId: string | null;
}

/** Safety net only: Redis drops raid state by itself if nothing ever closes the incident. */
export const STATE_TTL_SECONDS = 6 * 60 * 60;

export async function recordJoin(
  ctx: PluginContext,
  guildId: string,
  params: {
    userId: string;
    now: number;
    windowMs: number;
    isNewAccount: boolean;
    level: RiskLevel;
    scorePayload: string;
  },
): Promise<JoinRecordResult> {
  const [total, newc, active] = (await ctx.redis.eval(
    RECORD_JOIN_SCRIPT,
    3,
    windowKey(guildId),
    activeKey(guildId),
    seenKey(guildId, params.userId),
    params.now,
    BUCKET_MS,
    params.windowMs,
    params.isNewAccount ? '1' : '0',
    params.level,
    params.scorePayload,
    STATE_TTL_SECONDS,
    countsPrefix(),
    scoresPrefix(),
  )) as [number, number, string];
  return { windowTotal: Number(total), windowNew: Number(newc), activeIncidentId: active || null };
}

/**
 * Claims the "active incident" slot for `incidentId`, seeding its counters from the window that triggered it.
 * Atomic, so two joins crossing the threshold together start one incident. Returns false if one is active.
 */
const START_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', tonumber(ARGV[2])) == false then return 0 end
redis.call('HSET', KEYS[2], 'joins', ARGV[3], 'flagged', ARGV[4], 'lastJoinAt', ARGV[5])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
return 1
`;

export async function claimIncident(
  ctx: PluginContext,
  guildId: string,
  incidentId: string,
  seed: { joins: number; newAccounts: number; now: number },
): Promise<boolean> {
  const result = await ctx.redis.eval(
    START_SCRIPT,
    2,
    activeKey(guildId),
    countsKey(incidentId),
    incidentId,
    STATE_TTL_SECONDS,
    seed.joins,
    seed.newAccounts,
    seed.now,
  );
  return Number(result) === 1;
}

/** Gives the slot back after a failed start, but only if it is still ours. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1], KEYS[2], KEYS[3]) return 1 end
return 0
`;

export async function releaseIncident(
  ctx: PluginContext,
  guildId: string,
  incidentId: string,
): Promise<void> {
  await ctx.redis.eval(
    RELEASE_SCRIPT,
    3,
    activeKey(guildId),
    countsKey(incidentId),
    pendingScoresKey(incidentId),
    incidentId,
  );
}

export interface IncidentCounters {
  joins: number;
  flagged: number;
  low: number;
  medium: number;
  high: number;
  lastJoinAt: number;
}

/**
 * Reads the incident's counters and queued scores WITHOUT removing them; they are only trimmed once the database
 * has committed them (`commitDrain`). When the incident has gone quiet it also ends it in Redis (frees the active
 * slot) in the same step, so a join landing at that moment either counts in this incident or starts the next.
 * KEYS: active, counts, pending. ARGV: incidentId, now, quietMs (0 = never close).
 * Returns { state, counts, scores } where state is 1 = still active, 2 = closed just now, 0 = already not active.
 */
const DRAIN_SCRIPT = `
local counts = redis.call('HGETALL', KEYS[2])
local scores = redis.call('LRANGE', KEYS[3], 0, -1)
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {0, counts, scores} end
local quiet = tonumber(ARGV[3])
if quiet > 0 then
  local last = tonumber(redis.call('HGET', KEYS[2], 'lastJoinAt') or '0')
  if tonumber(ARGV[2]) - last >= quiet then
    redis.call('DEL', KEYS[1])
    return {2, counts, scores}
  end
end
return {1, counts, scores}
`;

export interface DrainResult {
  /** False when the incident is no longer active in Redis: it just went quiet, or it was closed before. */
  stillActive: boolean;
  /** True when this call is the one that just ended it. */
  closedNow: boolean;
  /** False when Redis holds nothing for this incident any more (expired or flushed). */
  hasState: boolean;
  counters: IncidentCounters;
  scorePayloads: string[];
}

export async function drainIncident(
  ctx: PluginContext,
  guildId: string,
  incidentId: string,
  now: number,
  closeIfQuietMs: number,
): Promise<DrainResult> {
  const [state, flat, scores] = (await ctx.redis.eval(
    DRAIN_SCRIPT,
    3,
    activeKey(guildId),
    countsKey(incidentId),
    pendingScoresKey(incidentId),
    incidentId,
    now,
    closeIfQuietMs,
  )) as [number, string[], string[]];
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < flat.length; i += 2) map.set(String(flat[i]), String(flat[i + 1]));
  const num = (key: string) => Number(map.get(key) ?? 0);
  return {
    stillActive: Number(state) === 1,
    closedNow: Number(state) === 2,
    hasState: map.size > 0 || scores.length > 0,
    counters: {
      joins: num('joins'),
      flagged: num('flagged'),
      low: num('low'),
      medium: num('medium'),
      high: num('high'),
      lastJoinAt: num('lastJoinAt'),
    },
    scorePayloads: scores,
  };
}

/** After the database committed a drain: drop the scores it wrote, and all of the incident's keys if it ended. */
const COMMIT_DRAIN_SCRIPT = `
redis.call('LTRIM', KEYS[2], tonumber(ARGV[1]), -1)
if ARGV[2] == '1' then redis.call('DEL', KEYS[1], KEYS[2]) end
return 1
`;

export async function commitDrain(
  ctx: PluginContext,
  incidentId: string,
  scoresWritten: number,
  ended: boolean,
): Promise<void> {
  await ctx.redis.eval(
    COMMIT_DRAIN_SCRIPT,
    2,
    countsKey(incidentId),
    pendingScoresKey(incidentId),
    scoresWritten,
    ended ? '1' : '0',
  );
}

export async function startCooldown(ctx: PluginContext, guildId: string, minutes: number): Promise<void> {
  if (minutes <= 0) return;
  await ctx.redis.set(cooldownKey(guildId), '1', 'PX', minutes * 60_000);
}

export async function inCooldown(ctx: PluginContext, guildId: string): Promise<boolean> {
  return (await ctx.redis.exists(cooldownKey(guildId))) === 1;
}

/**
 * Long enough for a 100-channel lockdown or restore under Discord rate-limit backoff. The final database write
 * is also fenced on the expected lockdown state, so even an expired lease cannot let two runs both commit.
 */
const LEASE_MS = 15 * 60_000;

const RELEASE_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * A per-guild lease so lockdown and restore never run at the same time for one server — two clicks, or a
 * lockdown for a new incident while an older one is being restored, touch the same channels. Never global.
 */
export async function withGuildLease<T>(
  ctx: PluginContext,
  guildId: string,
  fn: () => Promise<T>,
): Promise<T | 'busy'> {
  const key = redisKey('raidmode', 'lease', guildId);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if ((await ctx.redis.set(key, token, 'PX', LEASE_MS, 'NX')) !== 'OK') return 'busy';
  try {
    return await fn();
  } finally {
    await ctx.redis.eval(RELEASE_LEASE_SCRIPT, 1, key, token).catch(() => undefined);
  }
}
