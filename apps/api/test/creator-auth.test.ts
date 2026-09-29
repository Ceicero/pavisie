import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, redisKey } from '@pavisie/core';
import { buildTestApp, loginAs, loginAsCreator, seedUserGuilds } from './helpers/build-test-app';
import { creatorFixture } from './helpers/creator-fakes';

const CREATOR_ID = '810000000001';
const OTHER_CREATOR_ID = '810000000002';
const GUILD_ID = '123456789012345678';
const WEB_BASE = (env.WEB_URL ?? env.DASHBOARD_URL) as string;

const ORIGINAL_TWITCH_CLIENT_ID = env.TWITCH_CLIENT_ID;
const ORIGINAL_TWITCH_CLIENT_SECRET = env.TWITCH_CLIENT_SECRET;

beforeEach(async () => {
  // ioredis-mock instances built with the same options share one in-memory store process-wide (see
  // build-test-app.ts), so wipe it between tests: session/state key counts and the per-IP rate-limit counters
  // must start clean.
  await new RedisMock().flushall();
  env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
});

afterEach(() => {
  env.TWITCH_CLIENT_ID = ORIGINAL_TWITCH_CLIENT_ID;
  env.TWITCH_CLIENT_SECRET = ORIGINAL_TWITCH_CLIENT_SECRET;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Stubs the three Twitch endpoints the creator sign-in touches; `calls` records every URL hit. */
function stubTwitch(user: Record<string, unknown> = {}) {
  const calls: { url: string; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
        return jsonResponse({
          access_token: 'sign-in-access-token',
          refresh_token: 'sign-in-refresh-token',
          expires_in: 14400,
          token_type: 'bearer',
          scope: [],
        });
      }
      if (url.startsWith('https://api.twitch.tv/helix/users')) {
        return jsonResponse({
          data: [
            {
              id: CREATOR_ID,
              login: 'coolstreamer',
              display_name: 'CoolStreamer',
              profile_image_url: 'https://static-cdn.jtvnw.net/avatar.png',
              ...user,
            },
          ],
        });
      }
      if (url.startsWith('https://id.twitch.tv/oauth2/revoke')) return new Response(null, { status: 200 });
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
  return calls;
}

/** `name=value` (the raw, still-signed value) of a cookie the response set, ready to send back as a `Cookie` header. */
function setCookiePair(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  return found ? found.split(';')[0] : null;
}

function setCookieFull(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  return list.find((c) => c.startsWith(`${name}=`)) ?? null;
}

/** Starts a creator login and returns the pieces a browser would hold: the state and the pre-login cookie pair. */
async function startLogin(app: Awaited<ReturnType<typeof buildTestApp>>['app']) {
  const res = await app.inject({ method: 'GET', url: '/creator/auth/twitch/login' });
  const location = res.headers.location as string;
  const state = new URL(location).searchParams.get('state')!;
  return { res, location, state, cookie: setCookiePair(res, 'creator_login_state')! };
}

describe('GET /creator/auth/twitch/login', () => {
  it('redirects to Twitch with the reused redirect URI, NO scopes, and a browser-bound single-use state', async () => {
    const { app, redis } = await buildTestApp();
    const { res, location, state } = await startLogin(app);

    expect(res.statusCode).toBe(302);
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-twitch-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(`${env.API_BASE_URL}/integrations/twitch/callback`);
    expect(url.searchParams.has('scope')).toBe(false); // identity only
    expect(url.searchParams.get('response_type')).toBe('code');

    // State stored under its own namespace, and bound to this browser via a signed lax httpOnly cookie.
    expect(await redis.get(redisKey('creator-login-state', state))).toBe('1');
    expect(await redis.get(redisKey('oauthstate', state))).toBeNull(); // not the Discord login namespace
    const cookie = setCookieFull(res, 'creator_login_state')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    await app.close();
  });

  it('errors (not a redirect) when Twitch is not configured on this deployment', async () => {
    env.TWITCH_CLIENT_ID = undefined;
    env.TWITCH_CLIENT_SECRET = undefined;
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/creator/auth/twitch/login' });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.headers.location).toBeUndefined();
    await app.close();
  });

  it('is rate limited like the Discord login (20/min)', async () => {
    const { app } = await buildTestApp();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({ method: 'GET', url: '/creator/auth/twitch/login' });
      last = res.statusCode;
    }
    expect(last).toBe(429);
    await app.close();
  });
});

describe('GET /integrations/twitch/callback — creator sign-in', () => {
  it('signs the creator in with NO Discord session: creates a csid session, discards the token, redirects to /creator', async () => {
    const fixture = creatorFixture();
    const { app, redis, prismaCalls } = await buildTestApp(fixture.overrides);
    const { state, cookie } = await startLogin(app);
    const calls = stubTwitch();

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${state}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB_BASE}/creator`);

    // The creator session cookie is set, httpOnly, signed; the Discord `sid` cookie is NOT.
    const csid = setCookieFull(res, 'csid')!;
    expect(csid).toMatch(/HttpOnly/i);
    expect(setCookiePair(res, 'sid')).toBeNull();

    // The session holds the Twitch identity and NO token.
    const csidPair = setCookiePair(res, 'csid')!;
    const me = await app.inject({ method: 'GET', url: '/creator/me', headers: { cookie: csidPair } });
    expect(me.statusCode).toBe(200);
    expect(me.json().creator).toEqual({
      platform: 'twitch',
      platformUserId: CREATOR_ID,
      login: 'coolstreamer',
      displayName: 'CoolStreamer',
      avatarUrl: 'https://static-cdn.jtvnw.net/avatar.png',
    });
    const storedKeys = await redis.keys(redisKey('creator-session', '*'));
    expect(storedKeys).toHaveLength(1);
    const stored = (await redis.get(storedKeys[0]))!;
    expect(stored).not.toContain('sign-in-access-token');
    expect(stored).not.toContain('sign-in-refresh-token');

    // Nothing was persisted to Postgres (no IntegrationConnection/OAuthToken/etc).
    expect(prismaCalls).toHaveLength(0);

    // The single-use state is consumed, and the token is revoked best-effort after its one Helix call.
    expect(await redis.get(redisKey('creator-login-state', state))).toBeNull();
    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.startsWith('https://id.twitch.tv/oauth2/token'))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://id.twitch.tv/oauth2/revoke'))).toBe(true);
    expect(calls.find((c) => c.url.startsWith('https://id.twitch.tv/oauth2/revoke'))?.body).toContain(
      'token=sign-in-access-token',
    );
    await app.close();
  });

  it('a failing token revoke does not fail the sign-in', async () => {
    const { app } = await buildTestApp();
    const { state, cookie } = await startLogin(app);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/oauth2/token')) return jsonResponse({ access_token: 't', token_type: 'bearer' });
        if (url.includes('/helix/users')) {
          return jsonResponse({ data: [{ id: CREATOR_ID, login: 'a', display_name: 'A' }] });
        }
        throw new Error('revoke network down');
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(setCookiePair(res, 'csid')).not.toBeNull();
    await app.close();
  });

  it('rejects a callback from a different browser (no/other pre-login cookie) and does NOT consume the state', async () => {
    const { app, redis } = await buildTestApp();
    const { state } = await startLogin(app);
    const other = await startLogin(app); // some other login attempt's cookie
    stubTwitch();

    for (const headers of [{}, { cookie: other.cookie }]) {
      const res = await app.inject({
        method: 'GET',
        url: `/integrations/twitch/callback?code=abc&state=${state}`,
        headers,
      });
      // No cookie at all -> not recognisable as a creator flow by cookie, but the state IS in the creator
      // namespace, so it is still handled by the creator branch and refused for the browser mismatch.
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/does not match the browser/i);
      expect(setCookiePair(res, 'csid')).toBeNull();
    }
    expect(await redis.get(redisKey('creator-login-state', state))).toBe('1');
    await app.close();
  });

  it('rejects a replayed callback (state already used)', async () => {
    const { app } = await buildTestApp();
    const { state, cookie } = await startLogin(app);
    stubTwitch();

    const first = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${state}`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(302);

    const replay = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${state}`,
      headers: { cookie },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.message).toMatch(/expired or was already used/i);
    expect(setCookiePair(replay, 'csid')).toBeNull();
    await app.close();
  });

  it('rejects an expired state', async () => {
    const { app, redis } = await buildTestApp();
    const { state, cookie } = await startLogin(app);
    await redis.del(redisKey('creator-login-state', state)); // TTL elapsed
    stubTwitch();

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/expired or was already used/i);
    await app.close();
  });

  it('never runs the code exchange when the state check fails', async () => {
    const { app } = await buildTestApp();
    const { state } = await startLogin(app);
    const calls = stubTwitch();
    await app.inject({ method: 'GET', url: `/integrations/twitch/callback?code=abc&state=${state}` });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('leaves the guild flow untouched: an unknown state with no Discord session is still a 401', async () => {
    const { app } = await buildTestApp();
    stubTwitch();
    const res = await app.inject({
      method: 'GET',
      url: '/integrations/twitch/callback?code=abc&state=not-a-creator-state',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('a creator-login state is only honoured for the twitch provider', async () => {
    const { app } = await buildTestApp();
    const { state, cookie } = await startLogin(app);
    const res = await app.inject({
      method: 'GET',
      url: `/integrations/google/callback?code=abc&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401); // falls through to the Discord-session gate
    await app.close();
  });

  it('signing in again replaces the browser\'s previous creator session', async () => {
    const { app, redis } = await buildTestApp();
    const old = await loginAsCreator(app, redis, { platformUserId: OTHER_CREATOR_ID });
    const { state, cookie } = await startLogin(app);
    stubTwitch();

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${state}`,
      headers: { cookie: `${cookie}; ${old.cookieHeader}` },
    });
    expect(res.statusCode).toBe(302);
    expect(await redis.get(redisKey('creator-session', old.sid))).toBeNull();
    await app.close();
  });
});

describe('creator session (GET /creator/me, POST /creator/logout)', () => {
  it('401s without a session, and for a tampered cookie', async () => {
    const { app } = await buildTestApp();
    const none = await app.inject({ method: 'GET', url: '/creator/me' });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    const bad = await app.inject({ method: 'GET', url: '/creator/me', headers: { cookie: 'csid=forged.value' } });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it('returns the identity and the csrf token for a live creator session', async () => {
    const { app, redis } = await buildTestApp();
    const { cookieHeader, session } = await loginAsCreator(app, redis, {
      platformUserId: CREATOR_ID,
      login: 'coolstreamer',
      displayName: 'CoolStreamer',
    });
    const res = await app.inject({ method: 'GET', url: '/creator/me', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      creator: {
        platform: 'twitch',
        platformUserId: CREATOR_ID,
        login: 'coolstreamer',
        displayName: 'CoolStreamer',
        avatarUrl: null,
      },
      csrfToken: session.csrfToken,
    });
    await app.close();
  });

  it('the two session types do not authenticate each other', async () => {
    const { app, redis } = await buildTestApp();
    const discord = await loginAs(app, redis, { userId: '111111111111111111' });
    const creator = await loginAsCreator(app, redis, { platformUserId: CREATOR_ID });

    const creatorWithDiscordCookie = await app.inject({
      method: 'GET',
      url: '/creator/me',
      headers: { cookie: discord.cookieHeader },
    });
    expect(creatorWithDiscordCookie.statusCode).toBe(401);

    const discordWithCreatorCookie = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: creator.cookieHeader },
    });
    expect(discordWithCreatorCookie.statusCode).toBe(401);
    await app.close();
  });

  it('logout needs the creator csrf token, then destroys the session and clears the cookie', async () => {
    const { app, redis } = await buildTestApp();
    const { cookieHeader, session, sid } = await loginAsCreator(app, redis, { platformUserId: CREATOR_ID });

    const noToken = await app.inject({ method: 'POST', url: '/creator/logout', headers: { cookie: cookieHeader } });
    expect(noToken.statusCode).toBe(403);
    expect(await redis.get(redisKey('creator-session', sid))).not.toBeNull();

    const ok = await app.inject({
      method: 'POST',
      url: '/creator/logout',
      headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(await redis.get(redisKey('creator-session', sid))).toBeNull();
    expect(setCookieFull(ok, 'csid')).toMatch(/csid=;/);

    const after = await app.inject({ method: 'GET', url: '/creator/me', headers: { cookie: cookieHeader } });
    expect(after.statusCode).toBe(401);
    await app.close();
  });
});

describe('CSRF for creator routes', () => {
  const route = { method: 'PATCH' as const, url: '/creator/twitch/channel', payload: { commandPrefix: '?' } };

  it('rejects a mutating creator request with a missing or wrong token, and a disallowed origin', async () => {
    const fixture = creatorFixture();
    const { app, redis } = await buildTestApp(fixture.overrides);
    const { cookieHeader, session } = await loginAsCreator(app, redis, { platformUserId: CREATOR_ID });

    const missing = await app.inject({ ...route, headers: { cookie: cookieHeader } });
    expect(missing.statusCode).toBe(403);

    const wrong = await app.inject({ ...route, headers: { cookie: cookieHeader, 'x-csrf-token': 'nope' } });
    expect(wrong.statusCode).toBe(403);

    const badOrigin = await app.inject({
      ...route,
      headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken, origin: 'https://evil.example.com' },
    });
    expect(badOrigin.statusCode).toBe(403);

    // With the right token it gets past CSRF (and then 404s: this creator has no channel row).
    const ok = await app.inject({
      ...route,
      headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken, origin: env.DASHBOARD_URL as string },
    });
    expect(ok.statusCode).toBe(404);
    await app.close();
  });

  it('a request carrying BOTH cookies cannot use the Discord token on a creator route', async () => {
    const fixture = creatorFixture();
    const { app, redis } = await buildTestApp(fixture.overrides);
    const discord = await loginAs(app, redis, { userId: '111111111111111111' });
    const creator = await loginAsCreator(app, redis, { platformUserId: CREATOR_ID });

    const res = await app.inject({
      ...route,
      headers: {
        cookie: `${discord.cookieHeader}; ${creator.cookieHeader}`,
        'x-csrf-token': discord.session.csrfToken,
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('a request carrying BOTH cookies cannot use the creator token on a Discord dashboard route', async () => {
    const { app, redis } = await buildTestApp({
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    });
    const discord = await loginAs(app, redis, { userId: '222222222222222222' });
    await seedUserGuilds(redis, '222222222222222222', [{ id: GUILD_ID, owner: true, permissions: '8' }]);
    const creator = await loginAsCreator(app, redis, { platformUserId: CREATOR_ID });
    const cookie = `${discord.cookieHeader}; ${creator.cookieHeader}`;

    const withCreatorToken = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/config`,
      headers: { cookie, 'x-csrf-token': creator.session.csrfToken },
      payload: { fastActions: true },
    });
    expect(withCreatorToken.statusCode).toBe(403);

    const withDiscordToken = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/config`,
      headers: { cookie, 'x-csrf-token': discord.session.csrfToken },
      payload: { fastActions: true },
    });
    expect(withDiscordToken.statusCode).toBe(200);
    await app.close();
  });

  it('a creator-session-only request cannot dodge CSRF with a percent-encoded path', async () => {
    const fixture = creatorFixture();
    const { app, redis } = await buildTestApp(fixture.overrides);
    const { cookieHeader } = await loginAsCreator(app, redis, { platformUserId: CREATOR_ID });

    const res = await app.inject({
      method: 'PATCH',
      url: '/%63reator/twitch/channel', // %63 = "c": the router decodes it to /creator/...
      headers: { cookie: cookieHeader },
      payload: { commandPrefix: '?' },
    });
    // The router DOES route the decoded path to the creator handler, so CSRF must still apply (decided from the
    // matched route pattern, not the raw URL) — a raw-URL prefix check would have let this through unchecked.
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('a Discord session alone does not satisfy a creator route (401, not a CSRF pass-through)', async () => {
    const fixture = creatorFixture();
    const { app, redis } = await buildTestApp(fixture.overrides);
    const discord = await loginAs(app, redis, { userId: '111111111111111111' });
    const res = await app.inject({
      ...route,
      headers: { cookie: discord.cookieHeader, 'x-csrf-token': discord.session.csrfToken },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
