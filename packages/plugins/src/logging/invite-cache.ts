import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';

export interface InviteUseSnapshot {
  code: string;
  uses: number;
}

export interface InviteUseDiff {
  code: string;
  usesBefore: number;
  usesAfter: number;
}

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // a week of inactivity is plenty before this can safely expire

function cacheKey(guildId: string): string {
  return redisKey('logging', 'invites', guildId);
}

/** Reads the last-cached invite-use snapshot for `guildId` (empty array if never cached). */
export async function readInviteSnapshot(redis: Redis, guildId: string): Promise<InviteUseSnapshot[]> {
  const raw = await redis.get(cacheKey(guildId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InviteUseSnapshot[]) : [];
  } catch {
    return [];
  }
}

/** Overwrites the cached invite-use snapshot for `guildId`. */
export async function writeInviteSnapshot(
  redis: Redis,
  guildId: string,
  snapshot: InviteUseSnapshot[],
): Promise<void> {
  await redis.set(cacheKey(guildId), JSON.stringify(snapshot), 'EX', CACHE_TTL_SECONDS);
}

/**
 * Finds the single invite whose use count increased between two snapshots — Discord's `guildMemberAdd` doesn't
 * say which invite a member used, so invite attribution works by diffing a freshly-fetched snapshot against the
 * last one cached in Redis. Returns `null` if no invite's count increased (vanity URL, invite attribution
 * unavailable, or nothing changed). If multiple invites increased at once (a race between two joins), the
 * largest delta wins — a reasonable best-effort tiebreak for a feature that is inherently best-effort.
 */
export function diffInviteUses(
  before: InviteUseSnapshot[],
  after: InviteUseSnapshot[],
): InviteUseDiff | null {
  const beforeUses = new Map(before.map((invite) => [invite.code, invite.uses]));
  let best: InviteUseDiff | null = null;

  for (const invite of after) {
    const usesBefore = beforeUses.get(invite.code) ?? 0;
    const delta = invite.uses - usesBefore;
    if (delta > 0 && (!best || delta > best.usesAfter - best.usesBefore)) {
      best = { code: invite.code, usesBefore, usesAfter: invite.uses };
    }
  }

  return best;
}
