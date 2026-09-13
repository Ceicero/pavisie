import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, redisKey } from '@pavisie/core';
import { buildTestApp, loginAs } from './helpers/build-test-app';
import { exchangeProviderCode } from '../src/lib/integrations/providers';

const GUILD_ID = '888888888888888888';
const INITIATOR_ID = '111111111111111111';
const VICTIM_ID = '222222222222222222';
const STATE = 'test-integration-state-token';

async function seedPendingState(redis: any, overrides: Record<string, unknown> = {}) {
  await redis.set(
    redisKey('oauthstate', 'integration', STATE),
    JSON.stringify({ guildId: GUILD_ID, provider: 'twitch', userId: INITIATOR_ID, ...overrides }),
    'EX',
    600,
  );
}

describe('GET /integrations/:provider/callback — account-linking CSRF guard', () => {
  it('rejects the callback when there is no session at all', async () => {
    const { app, redis } = await buildTestApp();
    await seedPendingState(redis);

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${STATE}`,
    });

    expect(res.statusCode).toBe(401);
    // The state must still be consumable — it should NOT have been deleted by an unauthenticated attempt.
    expect(await redis.get(redisKey('oauthstate', 'integration', STATE))).not.toBeNull();
  });

  it('rejects the callback when the logged-in user is not the one who started the flow', async () => {
    const { app, redis } = await buildTestApp();
    await seedPendingState(redis);
    const { cookieHeader } = await loginAs(app, redis, { userId: VICTIM_ID });

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${STATE}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(403);

    const { prisma } = await buildTestApp();
    const connections = await prisma.integrationConnection.findMany({ where: { guildId: GUILD_ID } });
    expect(connections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Generic connect flow — Twitch account identity (defect 2). Before this fix, the generic (no-`kind`) branch
// never looked up the account at all: `GET /:guildId/integrations` had nothing but the `Account <id>`
// fallback to show, and `GET /:guildId/integrations/live` (which resolves a login from `externalAccountName`
// for exactly these rows once alert-watch rows are excluded — see integrations-live.test.ts) could never find
// one either. See the generic-flow comment in routes/oauth-integrations.ts.
// ---------------------------------------------------------------------------------------------------------

/** In-memory `integrationConnection` fake covering just what the generic connect flow needs:
 * `create`/`update` (the re-connect dedup writes one or the other) and `findFirst` (the dedup lookup by
 * `externalAccountId`), matched generically by plain key equality — every `where` this flow builds is a flat
 * object of simple equality checks, no nested operators. */
function integrationConnectionOverrides() {
  const rows = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  const overrides = {
    integrationConnection: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake, args shape mirrors Prisma's generated types
      create: async (args: any) => {
        const id = `conn${nextId++}`;
        const row = {
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSyncAt: null,
          lastError: null,
          externalAccountId: null,
          externalAccountName: null,
          label: null,
          deletedAt: null,
          ...args.data,
        };
        rows.set(id, row);
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async (args: any) => {
        const where = (args?.where ?? {}) as Record<string, unknown>;
        return (
          [...rows.values()].find((r) => Object.entries(where).every(([key, value]) => r[key] === value)) ??
          null
        );
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async (args: any) => {
        const existing = rows.get(args.where.id)!;
        const updated = { ...existing, ...args.data };
        rows.set(args.where.id, updated);
        return updated;
      },
    },
  };
  return { overrides, rows };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Stubs both Helix calls the generic Twitch connect flow makes: the token exchange, and the `/users`
 * identify lookup (`identifyTwitchUser`). `userOverrides` lets a test control the returned Twitch user. */
function stubTwitchFetch(userOverrides: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      if (urlStr.startsWith('https://id.twitch.tv/oauth2/token')) {
        return jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 14400,
          token_type: 'bearer',
          scope: ['user:read:email'],
        });
      }
      if (urlStr.startsWith('https://api.twitch.tv/helix/users')) {
        return jsonResponse({
          data: [{ id: 'twitch-user-1', login: 'shroud', display_name: 'Shroud', ...userOverrides }],
        });
      }
      throw new Error(`Unexpected fetch in test: ${urlStr}`);
    }),
  );
}

describe('GET /integrations/twitch/callback — generic connect flow account identity', () => {
  const ORIGINAL_TWITCH_CLIENT_ID = env.TWITCH_CLIENT_ID;
  const ORIGINAL_TWITCH_CLIENT_SECRET = env.TWITCH_CLIENT_SECRET;

  afterEach(() => {
    env.TWITCH_CLIENT_ID = ORIGINAL_TWITCH_CLIENT_ID;
    env.TWITCH_CLIENT_SECRET = ORIGINAL_TWITCH_CLIENT_SECRET;
    vi.unstubAllGlobals();
  });

  function configureTwitchEnv(): void {
    env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
    env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
  }

  it('stores externalAccountId and externalAccountName (the login, lowercased — not displayName)', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    const { app, redis } = await buildTestApp(overrides);
    await seedPendingState(redis);
    const { cookieHeader } = await loginAs(app, redis, { userId: INITIATOR_ID });
    configureTwitchEnv();
    // display_name deliberately differs from login by more than case, proving the login is what gets stored.
    stubTwitchFetch({ login: 'shroud', display_name: 'ShroudDisplay' });

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${STATE}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(302);
    const created = [...rows.values()];
    expect(created).toHaveLength(1);
    expect(created[0]!.externalAccountId).toBe('twitch-user-1');
    expect(created[0]!.externalAccountName).toBe('shroud');
    await app.close();
  });

  it('a second callback for the same account updates the existing row instead of duplicating it', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    const { app, redis } = await buildTestApp(overrides);
    configureTwitchEnv();
    stubTwitchFetch();

    await seedPendingState(redis);
    const { cookieHeader } = await loginAs(app, redis, { userId: INITIATOR_ID });
    const first = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${STATE}`,
      headers: { cookie: cookieHeader },
    });
    expect(first.statusCode).toBe(302);
    expect(rows.size).toBe(1);
    const firstId = [...rows.keys()][0];

    const STATE_2 = 'test-integration-state-token-2';
    await redis.set(
      redisKey('oauthstate', 'integration', STATE_2),
      JSON.stringify({ guildId: GUILD_ID, provider: 'twitch', userId: INITIATOR_ID }),
      'EX',
      600,
    );
    const second = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=def&state=${STATE_2}`,
      headers: { cookie: cookieHeader },
    });
    expect(second.statusCode).toBe(302);

    expect(rows.size).toBe(1);
    expect([...rows.keys()][0]).toBe(firstId);
    expect(rows.get(firstId)?.externalAccountName).toBe('shroud');
    expect(rows.get(firstId)?.status).toBe('CONNECTED');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// `exchangeProviderCode` scope normalization — root cause of the `token.scope.split is not a function`
// production bug (Twitch's real `POST /oauth2/token` returns `scope` as a JSON array of strings, not a
// space-delimited string like every other provider here). Covers both shapes so a regression on either one
// fails a unit test instead of only surfacing in production.
// ---------------------------------------------------------------------------

describe('exchangeProviderCode — scope normalization', () => {
  const ORIGINAL_REDDIT_CLIENT_ID = env.REDDIT_CLIENT_ID;
  const ORIGINAL_REDDIT_CLIENT_SECRET = env.REDDIT_CLIENT_SECRET;
  const ORIGINAL_TWITCH_CLIENT_ID = env.TWITCH_CLIENT_ID;
  const ORIGINAL_TWITCH_CLIENT_SECRET = env.TWITCH_CLIENT_SECRET;

  afterEach(() => {
    env.REDDIT_CLIENT_ID = ORIGINAL_REDDIT_CLIENT_ID;
    env.REDDIT_CLIENT_SECRET = ORIGINAL_REDDIT_CLIENT_SECRET;
    env.TWITCH_CLIENT_ID = ORIGINAL_TWITCH_CLIENT_ID;
    env.TWITCH_CLIENT_SECRET = ORIGINAL_TWITCH_CLIENT_SECRET;
    vi.unstubAllGlobals();
  });

  function stubTokenResponse(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
  }

  it('normalizes a space-delimited string scope (Reddit, and every other non-Twitch provider here) into string[]', async () => {
    env.REDDIT_CLIENT_ID = 'test-reddit-client-id';
    env.REDDIT_CLIENT_SECRET = 'test-reddit-client-secret';
    stubTokenResponse({
      access_token: 'reddit-access-token',
      refresh_token: 'reddit-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
      scope: 'identity read', // Reddit's real token response shape: a space-delimited string.
    });

    const token = await exchangeProviderCode(
      'reddit',
      'code123',
      'https://api.example.com/integrations/reddit/callback',
    );
    expect(token.scopes).toEqual(['identity', 'read']);
  });

  it("normalizes a JSON array scope (Twitch's real shape — the bug this covers) into the same string[] shape", async () => {
    env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
    env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
    stubTokenResponse({
      access_token: 'twitch-access-token',
      refresh_token: 'twitch-refresh-token',
      expires_in: 14400,
      token_type: 'bearer',
      scope: ['user:read:chat', 'user:write:chat', 'user:bot'], // Twitch always returns an array, never a string.
    });

    const token = await exchangeProviderCode(
      'twitch',
      'code456',
      'https://api.example.com/integrations/twitch/callback',
    );
    expect(token.scopes).toEqual(['user:read:chat', 'user:write:chat', 'user:bot']);
  });

  it('normalizes an absent scope into an empty array', async () => {
    env.REDDIT_CLIENT_ID = 'test-reddit-client-id';
    env.REDDIT_CLIENT_SECRET = 'test-reddit-client-secret';
    stubTokenResponse({ access_token: 'tok', expires_in: 3600, token_type: 'bearer' });

    const token = await exchangeProviderCode(
      'reddit',
      'code789',
      'https://api.example.com/integrations/reddit/callback',
    );
    expect(token.scopes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Instagram's two-leg OAuth. Its authorization-code grant hands back a token good for ONE HOUR, with no
// `refresh_token` and no `expires_in`. Persisting that as-is looks like a successful connect and then rots:
// `expiresAt` lands as null, so `jobs/token-refresh.ts` (selecting on `expiresAt: { not: null, ... }`) never
// revisits the row, and `ig_refresh_token` only accepts long-lived tokens anyway. These pin the second leg.
// ---------------------------------------------------------------------------------------------------------

describe('exchangeProviderCode — Instagram long-lived token exchange', () => {
  const ORIGINAL_ID = env.INSTAGRAM_CLIENT_ID;
  const ORIGINAL_SECRET = env.INSTAGRAM_CLIENT_SECRET;

  afterEach(() => {
    env.INSTAGRAM_CLIENT_ID = ORIGINAL_ID;
    env.INSTAGRAM_CLIENT_SECRET = ORIGINAL_SECRET;
    vi.unstubAllGlobals();
  });

  /** Leg 1 = api.instagram.com/oauth/access_token (short-lived), leg 2 = graph.instagram.com/access_token. */
  function stubBothLegs(secondLeg: unknown) {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('graph.instagram.com/access_token')) {
        return new Response(JSON.stringify(secondLeg), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        // Instagram's real short-lived shape: `permissions`, not `scope`, and no expiry or refresh token.
        JSON.stringify({ access_token: 'IG-SHORT-LIVED', user_id: 178414, permissions: ['instagram_business_basic'] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function configure() {
    env.INSTAGRAM_CLIENT_ID = 'test-instagram-client-id';
    env.INSTAGRAM_CLIENT_SECRET = 'test-instagram-client-secret';
  }

  it('trades the one-hour token for the ~60-day one and returns that, never the short-lived token', async () => {
    configure();
    const fetchMock = stubBothLegs({
      access_token: 'IG-LONG-LIVED',
      token_type: 'bearer',
      expires_in: 5183944, // ~60 days
    });

    const token = await exchangeProviderCode(
      'instagram',
      'code-ig',
      'https://api.example.com/integrations/instagram/callback',
    );

    expect(token.accessToken).toBe('IG-LONG-LIVED');
    expect(token.accessToken).not.toBe('IG-SHORT-LIVED');
    // The whole point: a real expiry, so `jobs/token-refresh.ts` will actually revisit this row.
    expect(token.expiresIn).toBe(5183944);
    // Instagram issues no refresh token — the long-lived access token re-issues itself.
    expect(token.refreshToken).toBeUndefined();
    // `permissions` from leg 1 survives, since leg 2 doesn't echo it back.
    expect(token.scopes).toEqual(['instagram_business_basic']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondLegUrl = String(fetchMock.mock.calls[1]![0]);
    expect(secondLegUrl).toContain('grant_type=ig_exchange_token');
    expect(secondLegUrl).toContain('access_token=IG-SHORT-LIVED');
  });

  it('fails the connect outright when the long-lived exchange fails, rather than storing the 1-hour token', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes('graph.instagram.com/access_token')) {
          return new Response('{"error":{"message":"bad"}}', { status: 400 });
        }
        return new Response(JSON.stringify({ access_token: 'IG-SHORT-LIVED', permissions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await expect(
      exchangeProviderCode('instagram', 'code-ig', 'https://api.example.com/integrations/instagram/callback'),
    ).rejects.toThrow(/Instagram long-lived token exchange failed/);
  });
});
