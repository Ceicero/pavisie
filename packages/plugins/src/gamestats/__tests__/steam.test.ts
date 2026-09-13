import { afterEach, describe, expect, it, vi } from 'vitest';
import { env as coreEnv, redisKey } from '@pavisie/core';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { getGameStats, getPlayerSummary, resolveSteamId } from '../steam';

/** Routes the shared `globalThis.fetch` mock by endpoint — several tests below need `GetUserStatsForGame` and
 *  `GetPlayerSummaries` (the 500 cross-check calls both) to answer differently. */
function fetchByEndpoint(handlers: { statsForGame?: () => Response; playerSummaries?: () => Response }) {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('GetUserStatsForGame') && handlers.statsForGame) return handlers.statsForGame();
    if (u.includes('GetPlayerSummaries') && handlers.playerSummaries) return handlers.playerSummaries();
    throw new Error(`unexpected fetch url in test: ${u}`);
  });
}

function playerSummaryResponse(visibility: number): Response {
  return new Response(
    JSON.stringify({
      response: {
        players: [
          { steamid: TEST_STEAM_ID, personaname: 'X', profileurl: 'https://steamcommunity.com/id/x', communityvisibilitystate: visibility },
        ],
      },
    }),
    { status: 200 },
  );
}

const TEST_APP_ID = 381210;
const TEST_STEAM_ID = '76561197960287930'; // arbitrary 17-digit id64 shape

function ctxWithKey(apiKey = 'test-steam-key', overrides: Partial<PluginContext> = {}) {
  return createTestContext({ overrides: { env: { ...coreEnv, STEAM_API_KEY: apiKey }, ...overrides } });
}

function ctxWithoutKey() {
  return createTestContext({ overrides: { env: { ...coreEnv, STEAM_API_KEY: undefined } } });
}

describe('resolveSteamId', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('accepts a bare SteamID64 without any network call', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    const result = await resolveSteamId(ctx, TEST_STEAM_ID);

    expect(result).toEqual({ ok: true, steamId64: TEST_STEAM_ID });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('extracts the id64 from a steamcommunity.com/profiles/<id64> URL without a network call', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    const result = await resolveSteamId(ctx, `https://steamcommunity.com/profiles/${TEST_STEAM_ID}/`);

    expect(result).toEqual({ ok: true, steamId64: TEST_STEAM_ID });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves a steamcommunity.com/id/<vanity> URL via ResolveVanityURL', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ response: { success: 1, steamid: TEST_STEAM_ID } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    const result = await resolveSteamId(ctx, 'https://steamcommunity.com/id/somevanity');

    expect(result).toEqual({ ok: true, steamId64: TEST_STEAM_ID });
    expect(capturedUrl).toContain('vanityurl=somevanity');
  });

  it('resolves a bare vanity name via ResolveVanityURL', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ response: { success: 1, steamid: TEST_STEAM_ID } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await resolveSteamId(ctx, 'somevanity')).toEqual({ ok: true, steamId64: TEST_STEAM_ID });
  });

  it('returns not_found when Steam cannot resolve the vanity name', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ response: { success: 42, message: 'No match' } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await resolveSteamId(ctx, 'nosuchvanity')).toEqual({ ok: false, error: 'not_found' });
  });

  it('returns error without a network call when STEAM_API_KEY is unset and vanity resolution would be needed', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = ctxWithoutKey();

    expect(await resolveSteamId(ctx, 'somevanity')).toEqual({ ok: false, error: 'error' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('getPlayerSummary', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns persona name + visibility on success', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            response: {
              players: [
                {
                  steamid: TEST_STEAM_ID,
                  personaname: 'TestSurvivor',
                  profileurl: 'https://steamcommunity.com/id/testsurvivor/',
                  communityvisibilitystate: 3,
                },
              ],
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await getPlayerSummary(ctx, TEST_STEAM_ID)).toEqual({
      steamId: TEST_STEAM_ID,
      personaName: 'TestSurvivor',
      profileUrl: 'https://steamcommunity.com/id/testsurvivor/',
      visibility: 3,
    });
  });

  it('returns null without a network call when STEAM_API_KEY is unset', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = ctxWithoutKey();

    expect(await getPlayerSummary(ctx, TEST_STEAM_ID)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null on a non-2xx response rather than throwing', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await getPlayerSummary(ctx, TEST_STEAM_ID)).toBeNull();
  });

  it('returns null when the request throws (network error)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await getPlayerSummary(ctx, TEST_STEAM_ID)).toBeNull();
  });
});

describe('getGameStats', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the parsed stats map on success and Redis-caches it for repeat calls', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            playerstats: {
              steamID: TEST_STEAM_ID,
              gameName: 'Dead by Daylight',
              stats: [
                { name: 'DBD_Escape', value: 12 },
                { name: 'DBD_SacrificedCampers', value: 4 },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const uniqueSteamId = `${TEST_STEAM_ID}1`; // unique per test so the shared ioredis-mock store can't leak a cache hit in
    const { ctx } = ctxWithKey();

    const first = await getGameStats(ctx, uniqueSteamId, TEST_APP_ID);
    expect(first).toEqual({ ok: true, stats: { DBD_Escape: 12, DBD_SacrificedCampers: 4 } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await getGameStats(ctx, uniqueSteamId, TEST_APP_ID);
    expect(second).toEqual({ ok: true, stats: { DBD_Escape: 12, DBD_SacrificedCampers: 4 } });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second call served entirely from the Redis cache
  });

  it('caches per (appId, steamId) — a different app id is not served from another game\'s cache entry', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ playerstats: { steamID: TEST_STEAM_ID, gameName: 'x', stats: [{ name: 'DBD_Escape', value: 1 }] } }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const uniqueSteamId = `${TEST_STEAM_ID}2`;
    const { ctx } = ctxWithKey();

    await getGameStats(ctx, uniqueSteamId, 111);
    await getGameStats(ctx, uniqueSteamId, 222);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('maps a 403 to reason: private (Game details privacy not Public)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await getGameStats(ctx, `${TEST_STEAM_ID}3`, TEST_APP_ID)).toEqual({ ok: false, reason: 'private' });
  });

  // Steam's 500 on this endpoint is its generic "something went wrong" status — it does NOT reliably mean the
  // profile is private (Steam also returns it for its own transient hiccups), unlike a 403 which does. So a 500
  // is cross-checked against `GetPlayerSummaries`' visibility before deciding `private` vs. `transient`.
  it('cross-checks a 500 via getPlayerSummary: not-Public visibility confirms reason: private', async () => {
    globalThis.fetch = fetchByEndpoint({
      statsForGame: () => new Response(null, { status: 500 }),
      playerSummaries: () => playerSummaryResponse(1), // 1 = private
    }) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await getGameStats(ctx, `${TEST_STEAM_ID}4`, TEST_APP_ID)).toEqual({ ok: false, reason: 'private' });
  });

  it('cross-checks a 500 via getPlayerSummary: Public visibility means the 500 was NOT a privacy issue — reason: transient', async () => {
    globalThis.fetch = fetchByEndpoint({
      statsForGame: () => new Response(null, { status: 500 }),
      playerSummaries: () => playerSummaryResponse(3), // 3 = public
    }) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await getGameStats(ctx, `${TEST_STEAM_ID}4b`, TEST_APP_ID)).toEqual({ ok: false, reason: 'transient' });
  });

  it('treats an unavailable player summary on a 500 as inconclusive — reason: transient, never wrongly private', async () => {
    globalThis.fetch = fetchByEndpoint({
      statsForGame: () => new Response(null, { status: 500 }),
      playerSummaries: () => new Response(null, { status: 500 }), // the cross-check lookup itself fails
    }) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await getGameStats(ctx, `${TEST_STEAM_ID}4c`, TEST_APP_ID)).toEqual({ ok: false, reason: 'transient' });
  });

  it('maps any other non-2xx status to reason: error', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 400 })) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await getGameStats(ctx, `${TEST_STEAM_ID}5`, TEST_APP_ID)).toEqual({ ok: false, reason: 'error' });
  });

  it('maps a 2xx response with no stats to reason: no_game', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ playerstats: { steamID: TEST_STEAM_ID, gameName: 'x' } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await getGameStats(ctx, `${TEST_STEAM_ID}6`, TEST_APP_ID)).toEqual({ ok: false, reason: 'no_game' });
  });

  it('maps a network error to reason: error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    const { ctx } = ctxWithKey();

    expect(await getGameStats(ctx, `${TEST_STEAM_ID}7`, TEST_APP_ID)).toEqual({ ok: false, reason: 'error' });
  });

  it('returns reason: error without a network call when STEAM_API_KEY is unset', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = ctxWithoutKey();

    expect(await getGameStats(ctx, `${TEST_STEAM_ID}8`, TEST_APP_ID)).toEqual({ ok: false, reason: 'error' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never logs the API key, on success or failure', async () => {
    const secretKey = 'super-secret-steam-key-should-never-appear-in-logs';
    const warnSpy = vi.fn();
    const fakeLogger = { warn: warnSpy, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as PluginContext['logger'];

    // A status this endpoint doesn't special-case as `private` (that path is deliberately silent — a private
    // profile is an expected, common outcome, not a warning) — 400 exercises the logged `reason: 'error'` path.
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 400 })) as unknown as typeof fetch;
    const { ctx } = ctxWithKey(secretKey, { logger: fakeLogger });

    await getGameStats(ctx, `${TEST_STEAM_ID}9`, TEST_APP_ID);

    expect(warnSpy).toHaveBeenCalled();
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secretKey);
    }
  });

  describe('bypassCache', () => {
    it('skips the Redis read but still writes the fresh result to Redis for later non-bypassing calls', async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ playerstats: { steamID: TEST_STEAM_ID, gameName: 'x', stats: [{ name: 'DBD_Escape', value: 1 }] } }),
            { status: 200 },
          ),
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const uniqueSteamId = `${TEST_STEAM_ID}10`;
      const { ctx } = ctxWithKey();

      // Prime the cache.
      await getGameStats(ctx, uniqueSteamId, TEST_APP_ID);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // bypassCache hits Steam again even though a cache entry already exists.
      const bypassed = await getGameStats(ctx, uniqueSteamId, TEST_APP_ID, { bypassCache: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(bypassed).toEqual({ ok: true, stats: { DBD_Escape: 1 } });

      // The fresh result was still cached — the next non-bypassing call is served from it, not a third fetch.
      const cachedAfter = await getGameStats(ctx, uniqueSteamId, TEST_APP_ID);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(cachedAfter).toEqual({ ok: true, stats: { DBD_Escape: 1 } });
    });
  });

  describe('keepKeys', () => {
    it('curates the stats map down to keepKeys BEFORE caching it — the raw payload never touches Redis', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              playerstats: {
                steamID: TEST_STEAM_ID,
                gameName: 'x',
                stats: [
                  { name: 'DBD_Escape', value: 7 },
                  { name: 'DBD_SomeUncuratedInternalStat', value: 999 },
                ],
              },
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch;
      const uniqueSteamId = `${TEST_STEAM_ID}11`;
      const { ctx } = ctxWithKey();

      const result = await getGameStats(ctx, uniqueSteamId, TEST_APP_ID, { keepKeys: ['DBD_Escape'] });
      expect(result).toEqual({ ok: true, stats: { DBD_Escape: 7 } });

      const cacheKey = redisKey('gamestats', 'steam', 'stats', String(TEST_APP_ID), uniqueSteamId);
      const cachedRaw = await ctx.redis.get(cacheKey);
      expect(JSON.parse(cachedRaw!)).toEqual({ DBD_Escape: 7 });
      expect(cachedRaw).not.toContain('DBD_SomeUncuratedInternalStat');
    });

    it('defensively re-filters a cache hit too, in case an entry was cached uncurated', async () => {
      const uniqueSteamId = `${TEST_STEAM_ID}12`;
      const { ctx } = ctxWithKey();
      const cacheKey = redisKey('gamestats', 'steam', 'stats', String(TEST_APP_ID), uniqueSteamId);
      await ctx.redis.set(cacheKey, JSON.stringify({ DBD_Escape: 3, DBD_SomeUncuratedInternalStat: 1 }), 'EX', 600);

      const result = await getGameStats(ctx, uniqueSteamId, TEST_APP_ID, { keepKeys: ['DBD_Escape'] });
      expect(result).toEqual({ ok: true, stats: { DBD_Escape: 3 } });
    });

    it('is a no-op when omitted — unfiltered callers keep today\'s behavior', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ playerstats: { steamID: TEST_STEAM_ID, gameName: 'x', stats: [{ name: 'DBD_Escape', value: 2 }] } }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch;
      const { ctx } = ctxWithKey();

      expect(await getGameStats(ctx, `${TEST_STEAM_ID}13`, TEST_APP_ID)).toEqual({ ok: true, stats: { DBD_Escape: 2 } });
    });
  });
});
