import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '@pavisie/core';
import type { PrismaStubOverrides } from '@pavisie/plugins/sdk/testing';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '500000000000000001';
const USER_ID = '500000000000000002';
const OUTSIDER_ID = '500000000000000003';

const ORIGINAL_TWITCH_CLIENT_ID = env.TWITCH_CLIENT_ID;
const ORIGINAL_TWITCH_CLIENT_SECRET = env.TWITCH_CLIENT_SECRET;

afterEach(() => {
  env.TWITCH_CLIENT_ID = ORIGINAL_TWITCH_CLIENT_ID;
  env.TWITCH_CLIENT_SECRET = ORIGINAL_TWITCH_CLIENT_SECRET;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function configureTwitchEnv(): void {
  env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
}

// ---------------------------------------------------------------------------------------------------------
// Minimal in-memory `integrationConnection` fake — same recording-`Proxy`-over-a-`Map` shape as
// `integrations.test.ts`'s `integrationConnectionOverrides`, trimmed to just `findMany` (the only delegate
// method `GET /guilds/:guildId/integrations/live` calls, both for the main list and — via
// `nonGenericConnectionIds`'s `chatConnectionIds`/`alertWatchConnectionIds` — the chat-kind and alert-watch
// exclusion queries). Must understand all three `where` shapes that route relies on, or a naive stub would
// silently break one of those exclusions and every test below.
// ---------------------------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture row, mirrors Prisma's row shape
function connectionRow(overrides: Record<string, unknown>): any {
  return {
    status: 'CONNECTED',
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSyncAt: null,
    lastError: null,
    externalAccountId: null,
    externalAccountName: null,
    deletedAt: null,
    label: null,
    connectedBy: USER_ID,
    config: {},
    ...overrides,
  };
}

function integrationConnectionOverrides() {
  const rows = new Map<string, Record<string, unknown>>();
  const overrides = {
    integrationConnection: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async (args: any) => {
        const where = args?.where ?? {};
        let list = [...rows.values()];
        if (where.guildId !== undefined) list = list.filter((r) => r.guildId === where.guildId);
        if (where.deletedAt !== undefined) list = list.filter((r) => r.deletedAt === where.deletedAt);
        // JSON-path filter shapes (routes/integrations.ts): `chatConnectionIds`'s `{ path: [...], equals }`
        // and `alertWatchConnectionIds`'s `{ path: [...], not: Prisma.DbNull }` — "this path resolves to
        // something, i.e. isn't SQL NULL", modeled here as "the path resolves to a defined value".
        if (where.config?.path) {
          const { path } = where.config as { path: string[]; equals?: unknown };
          const isPresenceCheck = 'not' in where.config;
          list = list.filter((r) => {
            let val: unknown = r.config;
            for (const key of path) val = (val as Record<string, unknown> | undefined)?.[key];
            if (isPresenceCheck) return val !== undefined;
            return val === (where.config as { equals?: unknown }).equals;
          });
        }
        if (where.id?.notIn) {
          const excluded: string[] = where.id.notIn;
          list = list.filter((r) => !excluded.includes(r.id as string));
        }
        return list;
      },
    },
    guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
  };
  return { overrides, rows };
}

async function setupAuthedApp(overrides: PrismaStubOverrides) {
  const { app, redis, ...rest } = await buildTestApp(overrides);
  const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  return { app, redis, cookieHeader, ...rest };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface StubFetchOptions {
  streamsHandler?: (url: URL) => Response;
}

/** Stubs both Helix calls the live route can make: the app-credential token exchange (`getTwitchAppToken`)
 * and `/streams`. `streamsHandler` lets each test control what Helix "sees" as live. */
function stubFetch(opts: StubFetchOptions = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    if (urlStr.startsWith('https://id.twitch.tv/oauth2/token')) {
      return jsonResponse({ access_token: 'app-token', expires_in: 14400 });
    }
    if (urlStr.startsWith('https://api.twitch.tv/helix/streams')) {
      return opts.streamsHandler ? opts.streamsHandler(new URL(urlStr)) : jsonResponse({ data: [] });
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

interface LiveEntry {
  connectionId: string;
  live: boolean | null;
  title: string | null;
  startedAt: string | null;
}

describe('GET /guilds/:guildId/integrations/live', () => {
  it('401s with no session', async () => {
    const { app } = await buildTestApp(integrationConnectionOverrides().overrides);
    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/integrations/live` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('403s for a user without manage access on the guild', async () => {
    const { app, redis } = await buildTestApp(integrationConnectionOverrides().overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: OUTSIDER_ID });
    await seedUserGuilds(redis, OUTSIDER_ID, []); // not in any guilds
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/live`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('reports live: null for a provider with no live concept at all (e.g. GitHub), without calling Twitch', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set('conn-github', connectionRow({ id: 'conn-github', guildId: GUILD_ID, provider: 'GITHUB' }));
    configureTwitchEnv();
    const fetchMock = stubFetch();
    const { app, cookieHeader } = await setupAuthedApp(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/live`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { connectionId: 'conn-github', live: null, title: null, startedAt: null },
    ]);
    // Never a fabricated on/off state, and never even worth a Twitch app-token round trip for a provider
    // with no live concept.
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('reports live: true with title/startedAt for a Twitch connection Helix reports as live', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set(
      'conn-1',
      connectionRow({
        id: 'conn-1',
        guildId: GUILD_ID,
        provider: 'TWITCH',
        config: {},
        externalAccountName: 'streamer-onair',
      }),
    );
    configureTwitchEnv();
    stubFetch({
      streamsHandler: () =>
        jsonResponse({
          data: [{ user_login: 'streamer-onair', title: 'Ranked grind', started_at: '2026-01-01T00:00:00Z' }],
        }),
    });
    const { app, cookieHeader } = await setupAuthedApp(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/live`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LiveEntry[];
    expect(body).toEqual([
      { connectionId: 'conn-1', live: true, title: 'Ranked grind', startedAt: '2026-01-01T00:00:00Z' },
    ]);
    await app.close();
  });

  // -------------------------------------------------------------------------------------------------------
  // Defect 1 regression: an alert-watch row (`config.channelId` set) must be hidden from this endpoint too,
  // same as the generic `GET /:guildId/integrations` list — it belongs to `GET .../integrations/alerts`.
  // Before the fix, this row would render (Twitch is `kind: 'oauth'`) and resolve a login from its
  // `config.target`, reporting `live: false` instead of being absent altogether.
  // -------------------------------------------------------------------------------------------------------

  it('excludes an alert-watch row (config.channelId) from the live list, without even calling Helix for it', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set(
      'conn-alert',
      connectionRow({
        id: 'conn-alert',
        guildId: GUILD_ID,
        provider: 'TWITCH',
        config: { target: 'shroud', channelId: '900000000000000001', roleId: null, template: null },
      }),
    );
    configureTwitchEnv();
    const fetchMock = stubFetch();
    const { app, cookieHeader } = await setupAuthedApp(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/live`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  // -------------------------------------------------------------------------------------------------------
  // Defect 2's other half: once alert watches are excluded (above), the only Twitch rows left in this list
  // are generic OAuth connections — and their only possible source of a login is `externalAccountName` (the
  // OAuth callback now populates it; see oauth-integrations.test.ts). This confirms that once it's populated,
  // this route actually resolves and reports `live` from it — the path the spec calls out as previously dead.
  // -------------------------------------------------------------------------------------------------------

  it('resolves a login from externalAccountName (no config.target at all) and reports live: true', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set(
      'conn-1',
      connectionRow({
        id: 'conn-1',
        guildId: GUILD_ID,
        provider: 'TWITCH',
        config: {}, // generic OAuth connection — never carries `target`
        externalAccountName: 'streamer-viaaccountname',
      }),
    );
    configureTwitchEnv();
    stubFetch({
      streamsHandler: () =>
        jsonResponse({
          data: [
            {
              user_login: 'streamer-viaaccountname',
              title: 'Live via account name',
              started_at: '2026-01-01T00:00:00Z',
            },
          ],
        }),
    });
    const { app, cookieHeader } = await setupAuthedApp(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/live`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LiveEntry[];
    expect(body).toEqual([
      { connectionId: 'conn-1', live: true, title: 'Live via account name', startedAt: '2026-01-01T00:00:00Z' },
    ]);
    await app.close();
  });

  it('serves a second request from the 60s cache without a second Helix /streams fetch', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    // A login not reused by any other test in this file — `ioredis-mock` shares its in-memory store across
    // every instance built the same way (see `build-test-app.ts`'s `overlaySubscriber` comment), so a login
    // reused across tests would read this test's cached result in an unrelated one.
    rows.set(
      'conn-1',
      connectionRow({
        id: 'conn-1',
        guildId: GUILD_ID,
        provider: 'TWITCH',
        config: {},
        externalAccountName: 'streamer-cachecheck',
      }),
    );
    configureTwitchEnv();
    const fetchMock = stubFetch({
      streamsHandler: () =>
        jsonResponse({
          data: [{ user_login: 'streamer-cachecheck', title: 'Live', started_at: '2026-01-01T00:00:00Z' }],
        }),
    });
    const { app, cookieHeader } = await setupAuthedApp(overrides);

    const first = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/live`,
      headers: { cookie: cookieHeader },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as LiveEntry[])[0]!.live).toBe(true);

    const streamsCallsAfterFirst = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/helix/streams'),
    ).length;
    expect(streamsCallsAfterFirst).toBe(1);

    const second = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/live`,
      headers: { cookie: cookieHeader },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as LiveEntry[])[0]!.live).toBe(true);

    const streamsCallsAfterSecond = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/helix/streams'),
    ).length;
    // Still 1 — the second request's login was served from the 60s Redis cache, not a fresh Helix fetch.
    expect(streamsCallsAfterSecond).toBe(1);
    await app.close();
  });

  it('reports live: null (never false) when the Helix /streams request fails, instead of guessing offline', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set(
      'conn-1',
      connectionRow({
        id: 'conn-1',
        guildId: GUILD_ID,
        provider: 'TWITCH',
        config: {},
        externalAccountName: 'streamer-failcheck',
      }),
    );
    configureTwitchEnv();
    stubFetch({ streamsHandler: () => new Response('', { status: 500 }) });
    const { app, cookieHeader } = await setupAuthedApp(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/live`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LiveEntry[];
    expect(body[0]!.live).toBeNull();
    await app.close();
  });

  it('batches Helix /streams at up to 100 user_login params per request for >100 Twitch connections', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    const CONNECTION_COUNT = 150;
    for (let i = 0; i < CONNECTION_COUNT; i++) {
      rows.set(
        `conn-${i}`,
        connectionRow({
          id: `conn-${i}`,
          guildId: GUILD_ID,
          provider: 'TWITCH',
          config: {},
          externalAccountName: `streamer${i}`,
        }),
      );
    }
    configureTwitchEnv();
    const fetchMock = stubFetch({ streamsHandler: () => jsonResponse({ data: [] }) });
    const { app, cookieHeader } = await setupAuthedApp(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/live`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LiveEntry[];
    expect(body).toHaveLength(CONNECTION_COUNT);
    expect(body.every((entry) => entry.live === false)).toBe(true);

    const streamsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/helix/streams'));
    expect(streamsCalls).toHaveLength(2);
    const loginCounts = streamsCalls
      .map(([url]) => new URL(String(url)).searchParams.getAll('user_login').length)
      .sort((a, b) => b - a);
    expect(loginCounts).toEqual([100, 50]);
    await app.close();
  });
});
