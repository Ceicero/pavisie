// Redis state for raid mode, and the one call each join makes.
//
// The join path must not slow down a raid (the #25 benchmark is the gate), so a join costs exactly one Redis
// round trip: a Lua script that adds the join to the sliding window, returns the window totals, and — only while
// an incident is active — adds the join to that incident's counters and queues its score. Database writes happen
// in the incident's update job, in batches, never per join.
import { redisKey } from '@pavisie/core';
import type { PluginContext } from '../sdk';
import type { RiskLevel } from './scoring';

/** Window buckets are this wide; the window is a whole number of buckets. */
const BUCKET_MS = 5_000;

export function windowKey(guildId: string): string {
  return redisKey('raidmode', 'window', guildId);
}
/** Holds the active incident's id. Its existence is what "an incident is active" means. */
export function activeKey(guildId: string): string {
  return redisKey('raidmode', 'active', guildId);
}
export function countsKey(guildId: string): string {
  return redisKey('raidmode', 'counts', guildId);
}
export function pendingScoresKey(guildId: string): string {
  return redisKey('raidmode', 'scores', guildId);
}

/**
 * KEYS: window, active, counts, pending scores.
 * ARGV: now, bucketMs, windowMs, isNewAccount (0/1), level, scorePayload ('' when nothing to store), stateTtlSec.
 * Returns { windowTotal, windowNew, activeIncidentId or '' }.
 */
const RECORD_JOIN_SCRIPT = `
local now = tonumber(ARGV[1])
local bucketMs = tonumber(ARGV[2])
local buckets = math.ceil(tonumber(ARGV[3]) / bucketMs)
local b = math.floor(now / bucketMs)
redis.call('HINCRBY', KEYS[1], 't' .. b, 1)
if ARGV[4] == '1' then redis.call('HINCRBY', KEYS[1], 'n' .. b, 1) end
redis.call('HDEL', KEYS[1], 't' .. (b - buckets), 'n' .. (b - buckets))
if redis.call('HLEN', KEYS[1]) > (buckets * 2 + 8) then
  for _, field in ipairs(redis.call('HKEYS', KEYS[1])) do
    if tonumber(string.sub(field, 2)) <= b - buckets then redis.call('HDEL', KEYS[1], field) end
  end
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) + bucketMs)
local total = 0
local newc = 0
for i = b - buckets + 1, b do
  total = total + tonumber(redis.call('HGET', KEYS[1], 't' .. i) or '0')
  newc = newc + tonumber(redis.call('HGET', KEYS[1], 'n' .. i) or '0')
end
local active = redis.call('GET', KEYS[2])
if active then
  redis.call('HINCRBY', KEYS[3], 'joins', 1)
  redis.call('HINCRBY', KEYS[3], ARGV[5], 1)
  if ARGV[5] ~= 'low' then redis.call('HINCRBY', KEYS[3], 'flagged', 1) end
  redis.call('HSET', KEYS[3], 'lastJoinAt', ARGV[1])
  if ARGV[6] ~= '' then redis.call('RPUSH', KEYS[4], ARGV[6]) end
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[7]))
  redis.call('EXPIRE', KEYS[4], tonumber(ARGV[7]))
else
  active = ''
end
return {total, newc, active}
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
  params: { now: number; windowMs: number; isNewAccount: boolean; level: RiskLevel; scorePayload: string },
): Promise<JoinRecordResult> {
  const [total, newc, active] = (await ctx.redis.eval(
    RECORD_JOIN_SCRIPT,
    4,
    windowKey(guildId),
    activeKey(guildId),
    countsKey(guildId),
    pendingScoresKey(guildId),
    params.now,
    BUCKET_MS,
    params.windowMs,
    params.isNewAccount ? '1' : '0',
    params.level,
    params.scorePayload,
    STATE_TTL_SECONDS,
  )) as [number, number, string];
  return { windowTotal: Number(total), windowNew: Number(newc), activeIncidentId: active || null };
}

/**
 * Claims the "active incident" slot for `incidentId`, seeding its counters from the window that triggered it.
 * Atomic, so two joins crossing the threshold together start one incident. Returns false if one is active.
 */
const START_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', tonumber(ARGV[2])) == false then return 0 end
redis.call('DEL', KEYS[2], KEYS[3])
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
    3,
    activeKey(guildId),
    countsKey(guildId),
    pendingScoresKey(guildId),
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
    countsKey(guildId),
    pendingScoresKey(guildId),
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
 * Reads the incident's counters and takes every queued score in one step. When `closeIfQuietMs` is given and no
 * join has arrived for that long, it also ends the incident in Redis (deletes the active slot) in that same step,
 * so a join landing at the same moment is either counted in this incident or starts cleanly after it.
 * KEYS: active, counts, pending. ARGV: incidentId, now, quietMs (0 = never close).
 */
const DRAIN_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {0, {}, {}} end
local counts = redis.call('HGETALL', KEYS[2])
local scores = redis.call('LRANGE', KEYS[3], 0, -1)
redis.call('DEL', KEYS[3])
local closed = 0
local quiet = tonumber(ARGV[3])
if quiet > 0 then
  local last = tonumber(redis.call('HGET', KEYS[2], 'lastJoinAt') or '0')
  if tonumber(ARGV[2]) - last >= quiet then
    redis.call('DEL', KEYS[1], KEYS[2])
    closed = 1
  end
end
return {1 + closed, counts, scores}
`;

export interface DrainResult {
  /** False when the incident is no longer the active one in Redis (already closed, or expired). */
  current: boolean;
  closed: boolean;
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
    countsKey(guildId),
    pendingScoresKey(guildId),
    incidentId,
    now,
    closeIfQuietMs,
  )) as [number, string[], string[]];
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < flat.length; i += 2) map.set(String(flat[i]), String(flat[i + 1]));
  const num = (key: string) => Number(map.get(key) ?? 0);
  return {
    current: Number(state) > 0,
    closed: Number(state) === 2,
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

/** A per-incident lease so two clicks on "Lock down" or "Restore" cannot run at once (never a global lock). */
export async function withIncidentLease<T>(
  ctx: PluginContext,
  incidentId: string,
  fn: () => Promise<T>,
): Promise<T | 'busy'> {
  const key = redisKey('raidmode', 'lease', incidentId);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if ((await ctx.redis.set(key, token, 'PX', 120_000, 'NX')) !== 'OK') return 'busy';
  try {
    return await fn();
  } finally {
    if ((await ctx.redis.get(key)) === token) await ctx.redis.del(key);
  }
}
