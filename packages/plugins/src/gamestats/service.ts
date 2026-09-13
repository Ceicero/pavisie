// gamestats service — the glue between the Steam client, the game descriptor framework, and Prisma.
// `buildLeaderboard` and `formatStatValue` are pure and unit-tested directly; `refreshMemberStats` is the one
// impure entry point, shared by `jobs/refresh.ts` and the future `/dbd` commands so there is exactly one code
// path that writes a `GameStatSnapshot`.
import type { GameAccountLink } from '@pavisie/database';
import type { PluginContext } from '../sdk';
import { curateStats, providerStatKeys, type GameDescriptor, type GameStatDef } from './games';
import { getGameStats, getPlayerSummary } from './steam';

export type RefreshOutcome = { ok: true } | { ok: false; reason: 'private' | 'no_game' | 'error' | 'transient' };

export interface RefreshMemberStatsOptions {
  /** Forces a live Steam fetch instead of serving `getGameStats`'s Redis cache — set by `/dbd refresh` (a member
   *  explicitly asking to see their current state right now) and `/dbd link` via its own direct `getGameStats`
   *  validation call. The scheduled `gamestats-refresh` job deliberately leaves this unset: it runs every 30
   *  minutes against a cache TTL of 10, so a cache hit there is still recent enough. */
  bypassCache?: boolean;
}

/**
 * Fetches `link`'s current stats for `game`, curates them down to the descriptor's stat ids, and upserts the
 * `GameStatSnapshot` row (latest snapshot only — no history, per SPEC.md "Non-negotiables"). On a fetch
 * failure the PREVIOUS stats are kept untouched — only `lastError` and `fetchedAt` change — so a stat card
 * degrades to "stale + reason", never blank. Refreshing the cached persona name is best-effort: a summary
 * failure never blocks or fails the stats refresh itself.
 */
export async function refreshMemberStats(
  ctx: PluginContext,
  link: GameAccountLink,
  game: GameDescriptor,
  options: RefreshMemberStatsOptions = {},
): Promise<RefreshOutcome> {
  const result = await getGameStats(ctx, link.externalId, game.steamAppId, {
    bypassCache: options.bypassCache,
    keepKeys: providerStatKeys(game),
  });
  const now = new Date();
  const where = { guildId_userId_game: { guildId: link.guildId, userId: link.userId, game: game.key } };

  // The Steam round-trip above can take a moment; re-verify the link row wasn't removed (`/dbd unlink`, or a
  // guild data-export deletion) while it was in flight. Without this check a refresh that started just before
  // an unlink could still land a snapshot write afterward, resurrecting data the member just asked to delete.
  const stillLinked = await ctx.prisma.gameAccountLink.findUnique({ where: { id: link.id } });
  if (!stillLinked) return { ok: false, reason: 'error' };

  if (!result.ok) {
    await ctx.prisma.gameStatSnapshot.upsert({
      where,
      // No prior snapshot to keep stats from — record the failure with an empty curated payload.
      create: { guildId: link.guildId, userId: link.userId, game: game.key, stats: {}, fetchedAt: now, lastError: result.reason },
      // `stats` is intentionally omitted here — Prisma leaves the column as-is, keeping whatever was last
      // fetched successfully.
      update: { fetchedAt: now, lastError: result.reason },
    });
    return { ok: false, reason: result.reason };
  }

  const curated = curateStats(game, result.stats);
  await ctx.prisma.gameStatSnapshot.upsert({
    where,
    create: { guildId: link.guildId, userId: link.userId, game: game.key, stats: curated, fetchedAt: now, lastError: null },
    update: { stats: curated, fetchedAt: now, lastError: null },
  });

  const summary = await getPlayerSummary(ctx, link.externalId);
  if (summary?.personaName && summary.personaName !== link.externalName) {
    await ctx.prisma.gameAccountLink.update({
      where: { id: link.id },
      data: { externalName: summary.personaName },
    });
  }

  return { ok: true };
}

export interface LeaderboardSnapshot {
  userId: string;
  /** The curated `{ statId: number }` stats blob — i.e. `GameStatSnapshot.stats` as read back from Prisma. */
  stats: Record<string, number>;
}

export interface LeaderboardRow {
  rank: number;
  userId: string;
  value: number;
}

export interface LeaderboardPage {
  rows: LeaderboardRow[];
  total: number;
  /** The page actually returned — clamped into `[1, totalPages]`, so an out-of-range request never yields an
   *  empty page when rows exist. */
  page: number;
  totalPages: number;
}

/**
 * Sorts `snapshots` descending by `statDef`'s value (missing stat = 0, same "treat as zero" rule as the
 * descriptor framework) and returns one page of `{ rank, userId, value }` rows plus paging metadata. Pure —
 * guild snapshot counts are bounded, so a plain JS sort is fine; no Prisma/Discord dependency, so this is
 * fully unit-tested on its own.
 */
export function buildLeaderboard(
  snapshots: LeaderboardSnapshot[],
  statDef: GameStatDef,
  page: number,
  pageSize: number,
): LeaderboardPage {
  const ranked = snapshots
    .map((s) => ({ userId: s.userId, value: s.stats[statDef.id] ?? 0 }))
    .sort((a, b) => b.value - a.value);

  const total = ranked.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
  const offset = (clampedPage - 1) * pageSize;

  const rows = ranked
    .slice(offset, offset + pageSize)
    .map((r, i) => ({ rank: offset + i + 1, userId: r.userId, value: r.value }));

  return { rows, total, page: clampedPage, totalPages };
}

/** Renders one stat value for display: `'int'` stats round to a whole number with thousands separators;
 *  `'float'` stats always show exactly 1 decimal place. */
export function formatStatValue(value: number, kind: GameStatDef['kind']): string {
  if (kind === 'float') {
    return value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  return Math.round(value).toLocaleString('en-US');
}
