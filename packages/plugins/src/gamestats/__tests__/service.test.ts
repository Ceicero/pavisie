import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameAccountLink } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import { dbd } from '../games/dbd';

// `service.ts` imports `getGameStats`/`getPlayerSummary` directly from `./steam` — mock that module so
// `refreshMemberStats` is tested in isolation from the real Steam HTTP client (which has its own test file).
// `vi.mock` (and `vi.hoisted`) calls are hoisted by Vitest above every import in this file, however far below
// them they're written — so `service.ts`'s own `import ... from './steam'` resolves to this mock. See
// `twitch-chat-manager.test.ts` for the same pattern.
const mocks = vi.hoisted(() => ({
  getGameStats: vi.fn(),
  getPlayerSummary: vi.fn(),
}));
vi.mock('../steam', () => mocks);

import { buildLeaderboard, formatStatValue, refreshMemberStats } from '../service';

function makeLink(overrides: Partial<GameAccountLink> = {}): GameAccountLink {
  return {
    id: 'link-1',
    guildId: 'guild-1',
    userId: 'user-1',
    provider: 'STEAM',
    externalId: '76561197960287930',
    externalName: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as GameAccountLink;
}

describe('refreshMemberStats', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('curates the raw stats down to the descriptor ids and upserts a fresh snapshot', async () => {
    mocks.getGameStats.mockResolvedValue({
      ok: true,
      stats: { DBD_Escape: 5, DBD_SacrificedCampers: 3, DBD_SomeUncuratedInternalStat: 999 },
    });
    mocks.getPlayerSummary.mockResolvedValue({
      steamId: 'x',
      personaName: 'NewName',
      profileUrl: 'u',
      visibility: 3,
    });

    const link = makeLink({ externalName: 'OldName' });
    const upsertCalls: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }[] = [];
    const updateCalls: unknown[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        gameStatSnapshot: {
          upsert: async (args: unknown) => {
            upsertCalls.push(args as (typeof upsertCalls)[number]);
            return {};
          },
        },
        gameAccountLink: {
          findUnique: async () => link,
          update: async (args: unknown) => {
            updateCalls.push(args);
            return {};
          },
        },
      },
    });

    const outcome = await refreshMemberStats(ctx, link, dbd);

    expect(outcome).toEqual({ ok: true });
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.create.stats).toEqual({
      escapes: 5,
      sacrifices: 3,
      kills: 0,
      bloodpoints: 0,
      generators: 0,
      heals: 0,
      'survivor-perfect-games': 0,
    });
    expect(upsertCalls[0]!.create.stats).not.toHaveProperty('DBD_SomeUncuratedInternalStat');
    expect(upsertCalls[0]!.create.lastError).toBeNull();

    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0] as { data: Record<string, unknown> }).data).toEqual({ externalName: 'NewName' });
  });

  it('passes bypassCache through and curates via the descriptor\'s own provider stat keys (keepKeys)', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: {} });
    mocks.getPlayerSummary.mockResolvedValue(null);
    const link = makeLink();
    const { ctx } = createTestContext({
      prismaOverrides: { gameAccountLink: { findUnique: async () => link } },
    });

    await refreshMemberStats(ctx, link, dbd, { bypassCache: true });

    expect(mocks.getGameStats).toHaveBeenCalledWith(ctx, link.externalId, dbd.steamAppId, {
      bypassCache: true,
      keepKeys: dbd.stats.map((s) => s.key),
    });
  });

  it('defaults bypassCache to falsy when no options are passed (the scheduled job\'s call shape)', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: {} });
    mocks.getPlayerSummary.mockResolvedValue(null);
    const link = makeLink();
    const { ctx } = createTestContext({
      prismaOverrides: { gameAccountLink: { findUnique: async () => link } },
    });

    await refreshMemberStats(ctx, link, dbd);

    expect(mocks.getGameStats).toHaveBeenCalledWith(
      ctx,
      link.externalId,
      dbd.steamAppId,
      expect.objectContaining({ bypassCache: undefined }),
    );
  });

  it('does not touch externalName when the persona name is unchanged', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: {} });
    mocks.getPlayerSummary.mockResolvedValue({ steamId: 'x', personaName: 'SameName', profileUrl: 'u', visibility: 3 });
    const link = makeLink({ externalName: 'SameName' });
    const updateCalls: unknown[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        gameAccountLink: {
          findUnique: async () => link,
          update: async (args: unknown) => {
            updateCalls.push(args);
            return {};
          },
        },
      },
    });

    await refreshMemberStats(ctx, link, dbd);

    expect(updateCalls).toHaveLength(0);
  });

  it('does not touch externalName when the summary lookup fails', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: {} });
    mocks.getPlayerSummary.mockResolvedValue(null);
    const link = makeLink();
    const updateCalls: unknown[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        gameAccountLink: {
          findUnique: async () => link,
          update: async (args: unknown) => {
            updateCalls.push(args);
            return {};
          },
        },
      },
    });

    const outcome = await refreshMemberStats(ctx, link, dbd);

    expect(outcome).toEqual({ ok: true });
    expect(updateCalls).toHaveLength(0);
  });

  it('keeps previous stats and records lastError on a private-profile failure, without touching the persona name', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: false, reason: 'private' });
    const link = makeLink();
    const upsertCalls: { update: Record<string, unknown> }[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        gameAccountLink: { findUnique: async () => link },
        gameStatSnapshot: {
          upsert: async (args: unknown) => {
            upsertCalls.push(args as { update: Record<string, unknown> });
            return {};
          },
        },
      },
    });

    const outcome = await refreshMemberStats(ctx, link, dbd);

    expect(outcome).toEqual({ ok: false, reason: 'private' });
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.update).toEqual({ fetchedAt: expect.any(Date), lastError: 'private' });
    expect(upsertCalls[0]!.update).not.toHaveProperty('stats'); // never overwrites the last-known-good stats
    expect(mocks.getPlayerSummary).not.toHaveBeenCalled();
  });

  it('records lastError for a no_game failure the same way', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: false, reason: 'no_game' });
    const link = makeLink();
    const upsertCalls: { update: Record<string, unknown> }[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        gameAccountLink: { findUnique: async () => link },
        gameStatSnapshot: {
          upsert: async (args: unknown) => {
            upsertCalls.push(args as { update: Record<string, unknown> });
            return {};
          },
        },
      },
    });

    const outcome = await refreshMemberStats(ctx, link, dbd);

    expect(outcome).toEqual({ ok: false, reason: 'no_game' });
    expect(upsertCalls[0]!.update.lastError).toBe('no_game');
  });

  it('records lastError for a transient (Steam-hiccup) failure too', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: false, reason: 'transient' });
    const link = makeLink();
    const upsertCalls: { update: Record<string, unknown> }[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        gameAccountLink: { findUnique: async () => link },
        gameStatSnapshot: {
          upsert: async (args: unknown) => {
            upsertCalls.push(args as { update: Record<string, unknown> });
            return {};
          },
        },
      },
    });

    const outcome = await refreshMemberStats(ctx, link, dbd);

    expect(outcome).toEqual({ ok: false, reason: 'transient' });
    expect(upsertCalls[0]!.update.lastError).toBe('transient');
  });

  it('skips the snapshot write entirely when the link was deleted mid-refresh (unlinked while the Steam call was in flight)', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: { DBD_Escape: 9 } });
    const link = makeLink();
    const snapshotUpsert = vi.fn(async () => ({}));
    const linkUpdate = vi.fn(async () => ({}));
    const { ctx } = createTestContext({
      prismaOverrides: {
        // The link is gone by the time refreshMemberStats re-checks — simulates a concurrent `/dbd unlink`.
        gameAccountLink: { findUnique: async () => null, update: linkUpdate },
        gameStatSnapshot: { upsert: snapshotUpsert },
      },
    });

    const outcome = await refreshMemberStats(ctx, link, dbd);

    expect(outcome).toEqual({ ok: false, reason: 'error' });
    expect(snapshotUpsert).not.toHaveBeenCalled();
    expect(linkUpdate).not.toHaveBeenCalled();
  });

  it('also skips the snapshot write for a deleted link on a fetch-failure outcome, not just a success', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: false, reason: 'private' });
    const link = makeLink();
    const snapshotUpsert = vi.fn(async () => ({}));
    const { ctx } = createTestContext({
      prismaOverrides: {
        gameAccountLink: { findUnique: async () => null },
        gameStatSnapshot: { upsert: snapshotUpsert },
      },
    });

    const outcome = await refreshMemberStats(ctx, link, dbd);

    expect(outcome).toEqual({ ok: false, reason: 'error' });
    expect(snapshotUpsert).not.toHaveBeenCalled();
  });
});

describe('buildLeaderboard', () => {
  const statDef = dbd.stats.find((s) => s.id === 'escapes')!;

  it('sorts descending by the stat value and assigns ranks starting at 1', () => {
    const snapshots = [
      { userId: 'a', stats: { escapes: 10 } },
      { userId: 'b', stats: { escapes: 30 } },
      { userId: 'c', stats: { escapes: 20 } },
    ];

    const page = buildLeaderboard(snapshots, statDef, 1, 10);

    expect(page.total).toBe(3);
    expect(page.totalPages).toBe(1);
    expect(page.rows).toEqual([
      { rank: 1, userId: 'b', value: 30 },
      { rank: 2, userId: 'c', value: 20 },
      { rank: 3, userId: 'a', value: 10 },
    ]);
  });

  it('pages correctly, with ranks reflecting position across the whole leaderboard', () => {
    const snapshots = [
      { userId: 'a', stats: { escapes: 10 } },
      { userId: 'b', stats: { escapes: 30 } },
      { userId: 'c', stats: { escapes: 20 } },
    ];

    const page2 = buildLeaderboard(snapshots, statDef, 2, 2);

    expect(page2.page).toBe(2);
    expect(page2.totalPages).toBe(2);
    expect(page2.rows).toEqual([{ rank: 3, userId: 'a', value: 10 }]);
  });

  it('treats a missing stat entry as 0', () => {
    const snapshots: { userId: string; stats: Record<string, number> }[] = [
      { userId: 'a', stats: {} },
      { userId: 'b', stats: { escapes: 1 } },
    ];

    const page = buildLeaderboard(snapshots, statDef, 1, 10);

    expect(page.rows).toEqual([
      { rank: 1, userId: 'b', value: 1 },
      { rank: 2, userId: 'a', value: 0 },
    ]);
  });

  it('clamps an out-of-range page into [1, totalPages] instead of returning an empty page', () => {
    const snapshots = [{ userId: 'a', stats: { escapes: 1 } }];

    const tooHigh = buildLeaderboard(snapshots, statDef, 99, 10);
    expect(tooHigh.page).toBe(1);
    expect(tooHigh.rows).toHaveLength(1);

    const tooLow = buildLeaderboard(snapshots, statDef, 0, 10);
    expect(tooLow.page).toBe(1);
  });

  it('returns an empty page (not an error) for an empty leaderboard', () => {
    const page = buildLeaderboard([], statDef, 1, 10);
    expect(page).toEqual({ rows: [], total: 0, page: 1, totalPages: 1 });
  });
});

describe('formatStatValue', () => {
  it('formats int stats rounded, with thousands separators', () => {
    expect(formatStatValue(1234567, 'int')).toBe('1,234,567');
    expect(formatStatValue(4.6, 'int')).toBe('5');
    expect(formatStatValue(0, 'int')).toBe('0');
  });

  it('formats float stats with exactly 1 decimal place', () => {
    expect(formatStatValue(3, 'float')).toBe('3.0');
    expect(formatStatValue(3.44, 'float')).toBe('3.4');
    expect(formatStatValue(3.46, 'float')).toBe('3.5');
  });
});
