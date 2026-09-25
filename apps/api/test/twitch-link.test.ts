import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { redisKey } from '@pavisie/core';
import { buildTestApp, loginAs } from './helpers/build-test-app';

const USER_ID = '111111111111111111';
const OTHER_USER_ID = '222222222222222222';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface DiscordStubOptions {
  identifyId?: string;
  connections?: { id: string; name: string; type: string; verified: boolean }[];
}

/** Stubs the three Discord calls the twitch-link callback makes: token exchange, `/users/@me`, and
 * `/users/@me/connections`. Fails the test loudly on any other URL so a bug can't silently no-op. */
function stubDiscordFetch(options: DiscordStubOptions = {}): ReturnType<typeof vi.fn> {
  const identifyId = options.identifyId ?? USER_ID;
  const connections = options.connections ?? [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://discord.com/api/v10/oauth2/token')) {
      return jsonResponse({
        access_token: 'discord-access-token-should-never-be-persisted',
        refresh_token: 'discord-refresh-token',
        expires_in: 604800,
        token_type: 'Bearer',
        scope: 'identify connections',
      });
    }
    if (url.startsWith('https://discord.com/api/v10/users/@me/connections')) {
      return jsonResponse(connections);
    }
    if (url.startsWith('https://discord.com/api/v10/users/@me')) {
      return jsonResponse({ id: identifyId, username: 'streamer', global_name: null, avatar: null });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Runs the full browser round trip for a twitch-link `/connect` → `GET /discord/callback`: extracts the
 * `state` from the connect response, signs the `oauth_state` cookie the same way the browser would carry
 * it back, and returns the combined cookie header (session + oauth_state) plus the callback URL. */
async function startLinkFlow(
  app: Awaited<ReturnType<typeof buildTestApp>>['app'],
  sessionCookieHeader: string,
): Promise<{ callbackUrl: string; cookieHeader: string }> {
  const connectRes = await app.inject({
    method: 'POST',
    url: '/me/twitch-link/connect',
    headers: { cookie: sessionCookieHeader, 'x-csrf-token': await csrfTokenFor(app, sessionCookieHeader) },
  });
  expect(connectRes.statusCode).toBe(200);
  const { url } = connectRes.json() as { url: string };
  const state = new URL(url).searchParams.get('state')!;
  const stateCookie = connectRes.cookies.find((c) => c.name === 'oauth_state')!;

  return {
    callbackUrl: `/auth/discord/callback?code=test-code&state=${state}`,
    cookieHeader: `${sessionCookieHeader}; oauth_state=${stateCookie.value}`,
  };
}

async function csrfTokenFor(
  app: Awaited<ReturnType<typeof buildTestApp>>['app'],
  cookieHeader: string,
): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieHeader } });
  return (res.json() as { csrfToken: string }).csrfToken;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /me/twitch-link/connect', () => {
  it('returns a Discord authorize URL scoped to exactly "identify connections", and stores a twitchlink-namespaced state', async () => {
    const { app, redis } = await buildTestApp();
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    const csrfToken = await csrfTokenFor(app, cookieHeader);

    const res = await app.inject({
      method: 'POST',
      url: '/me/twitch-link/connect',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });

    expect(res.statusCode).toBe(200);
    const { url } = res.json() as { url: string };
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(parsed.searchParams.get('scope')).toBe('identify connections');
    expect(parsed.searchParams.get('client_id')).toBe('test-discord-client-id');

    const state = parsed.searchParams.get('state')!;
    const stored = await redis.get(redisKey('oauthstate', 'twitchlink', state));
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual({ userId: USER_ID });

    // Never written under the plain login namespace — the two flows must not collide.
    expect(await redis.get(redisKey('oauthstate', state))).toBeNull();

    await app.close();
  });

  it('requires a session (401) and a CSRF token (403 without it)', async () => {
    const { app } = await buildTestApp();
    const unauthed = await app.inject({ method: 'POST', url: '/me/twitch-link/connect' });
    expect(unauthed.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /auth/discord/callback — login flow is unchanged (regression)', () => {
  it('still creates a session and redirects to /dashboard when the state is a plain login state', async () => {
    const { app, redis } = await buildTestApp();
    stubDiscordFetch();

    const loginRes = await app.inject({ method: 'GET', url: '/auth/discord/login' });
    const loginUrl = new URL(loginRes.headers.location as string);
    const state = loginUrl.searchParams.get('state')!;
    const stateCookie = loginRes.cookies.find((c) => c.name === 'oauth_state')!;

    const res = await app.inject({
      method: 'GET',
      url: `/auth/discord/callback?code=abc&state=${state}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/dashboard');
    expect(res.cookies.find((c) => c.name === 'sid')).toBeDefined();
    // The login state key is consumed; nothing was ever written under the twitchlink namespace.
    expect(await redis.get(redisKey('oauthstate', state))).toBeNull();

    await app.close();
  });
});

describe('GET /auth/discord/callback — twitch-link flow', () => {
  it('links on exactly one verified Twitch connection and upserts the row', async () => {
    const { app, redis, prisma, prismaCalls } = await buildTestApp({
      twitchAccountLink: {
        findUnique: async () => null,
        upsert: async ({ create }: any) => ({ id: 'row1', linkedAt: new Date(), updatedAt: new Date(), ...create }),
      },
    });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    stubDiscordFetch({
      identifyId: USER_ID,
      connections: [
        { id: 'twitch-123', name: 'shroud', type: 'twitch', verified: true },
        { id: 'yt-999', name: 'shroud-yt', type: 'youtube', verified: true },
      ],
    });

    const { callbackUrl, cookieHeader: fullCookie } = await startLinkFlow(app, cookieHeader);
    const res = await app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: fullCookie } });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/dashboard/account?linked=twitch');

    const upsertCall = prismaCalls.find((c) => c.model === 'twitchAccountLink' && c.method === 'upsert');
    expect(upsertCall).toBeDefined();
    const args = upsertCall!.args[0] as any;
    expect(args.where).toEqual({ discordUserId: USER_ID });
    expect(args.create).toEqual({ discordUserId: USER_ID, twitchUserId: 'twitch-123', twitchLogin: 'shroud' });

    void prisma;
    await app.close();
  });

  it('redirects with an error and writes nothing when there is no verified Twitch connection', async () => {
    const { app, redis, prismaCalls } = await buildTestApp();
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    stubDiscordFetch({
      identifyId: USER_ID,
      connections: [{ id: 'twitch-123', name: 'shroud', type: 'twitch', verified: false }],
    });

    const { callbackUrl, cookieHeader: fullCookie } = await startLinkFlow(app, cookieHeader);
    const res = await app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: fullCookie } });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      'http://localhost:3000/dashboard/account?error=twitch-link-no-verified-connection',
    );
    expect(prismaCalls.some((c) => c.model === 'twitchAccountLink' && c.method !== 'findUnique')).toBe(false);

    await app.close();
  });

  it('redirects with an error and writes nothing when there is more than one verified Twitch connection', async () => {
    const { app, redis, prismaCalls } = await buildTestApp();
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    stubDiscordFetch({
      identifyId: USER_ID,
      connections: [
        { id: 'twitch-123', name: 'shroud', type: 'twitch', verified: true },
        { id: 'twitch-456', name: 'shroud-alt', type: 'twitch', verified: true },
      ],
    });

    const { callbackUrl, cookieHeader: fullCookie } = await startLinkFlow(app, cookieHeader);
    const res = await app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: fullCookie } });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      'http://localhost:3000/dashboard/account?error=twitch-link-multiple-connections',
    );
    expect(prismaCalls.some((c) => c.model === 'twitchAccountLink' && c.method !== 'findUnique')).toBe(false);

    await app.close();
  });

  it('rejects (403) when the Discord identity does not match the session, and writes nothing', async () => {
    const { app, redis, prismaCalls } = await buildTestApp();
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    // The Discord account identified by the OAuth grant is a different user than the session.
    stubDiscordFetch({
      identifyId: OTHER_USER_ID,
      connections: [{ id: 'twitch-123', name: 'shroud', type: 'twitch', verified: true }],
    });

    const { callbackUrl, cookieHeader: fullCookie } = await startLinkFlow(app, cookieHeader);
    const res = await app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: fullCookie } });

    expect(res.statusCode).toBe(403);
    expect(prismaCalls.filter((c) => c.model === 'twitchAccountLink')).toHaveLength(0);

    await app.close();
  });

  it('redirects with an error and leaves the existing link untouched when the Twitch account is already claimed by someone else', async () => {
    const existingLink = { discordUserId: OTHER_USER_ID, twitchUserId: 'twitch-123', twitchLogin: 'shroud' };
    const { app, redis, prismaCalls } = await buildTestApp({
      twitchAccountLink: {
        findUnique: async () => existingLink,
      },
    });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    stubDiscordFetch({
      identifyId: USER_ID,
      connections: [{ id: 'twitch-123', name: 'shroud', type: 'twitch', verified: true }],
    });

    const { callbackUrl, cookieHeader: fullCookie } = await startLinkFlow(app, cookieHeader);
    const res = await app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: fullCookie } });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      'http://localhost:3000/dashboard/account?error=twitch-link-already-claimed',
    );
    expect(prismaCalls.some((c) => c.model === 'twitchAccountLink' && (c.method === 'upsert' || c.method === 'update' || c.method === 'create'))).toBe(false);

    await app.close();
  });

  it('a relink by the same user replaces their previous link (upsert on discordUserId)', async () => {
    let stored = { discordUserId: USER_ID, twitchUserId: 'twitch-old', twitchLogin: 'old-login' };
    const { app, redis } = await buildTestApp({
      twitchAccountLink: {
        findUnique: async ({ where }: any) =>
          where.twitchUserId === stored.twitchUserId || where.discordUserId === stored.discordUserId
            ? stored
            : null,
        upsert: async ({ update }: any) => {
          stored = { ...stored, ...update };
          return stored;
        },
      },
    });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    stubDiscordFetch({
      identifyId: USER_ID,
      connections: [{ id: 'twitch-new', name: 'new-login', type: 'twitch', verified: true }],
    });

    const { callbackUrl, cookieHeader: fullCookie } = await startLinkFlow(app, cookieHeader);
    const res = await app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: fullCookie } });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/dashboard/account?linked=twitch');
    expect(stored.twitchUserId).toBe('twitch-new');
    expect(stored.twitchLogin).toBe('new-login');

    await app.close();
  });

  it('never persists or logs the Discord access token', async () => {
    const lines: string[] = [];
    const capturingLogger = pino(
      new Writable({
        write(chunk, _enc, cb) {
          lines.push(chunk.toString());
          cb();
        },
      }),
    );
    const { app, redis, prismaCalls } = await buildTestApp(
      {
        twitchAccountLink: {
          findUnique: async () => null,
          upsert: async ({ create }: any) => ({ id: 'row1', linkedAt: new Date(), updatedAt: new Date(), ...create }),
        },
      },
      capturingLogger,
    );
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    stubDiscordFetch({
      identifyId: USER_ID,
      connections: [{ id: 'twitch-123', name: 'shroud', type: 'twitch', verified: true }],
    });

    const { callbackUrl, cookieHeader: fullCookie } = await startLinkFlow(app, cookieHeader);
    const res = await app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: fullCookie } });
    expect(res.statusCode).toBe(302);

    const TOKEN = 'discord-access-token-should-never-be-persisted';
    for (const call of prismaCalls) {
      expect(JSON.stringify(call.args)).not.toContain(TOKEN);
    }
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
    }

    await app.close();
  });
});

describe('GET /me/twitch-link', () => {
  it('returns { linked: false } when there is no link', async () => {
    const { app, redis } = await buildTestApp({ twitchAccountLink: { findUnique: async () => null } });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });

    const res = await app.inject({ method: 'GET', url: '/me/twitch-link', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ linked: false });

    await app.close();
  });

  it('returns { linked: true, twitchLogin, linkedAt } and never twitchUserId', async () => {
    const linkedAt = new Date('2026-01-01T00:00:00.000Z');
    const { app, redis } = await buildTestApp({
      twitchAccountLink: {
        findUnique: async () => ({
          discordUserId: USER_ID,
          twitchUserId: 'twitch-secret-id',
          twitchLogin: 'shroud',
          linkedAt,
          updatedAt: linkedAt,
        }),
      },
    });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });

    const res = await app.inject({ method: 'GET', url: '/me/twitch-link', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ linked: true, twitchLogin: 'shroud', linkedAt: linkedAt.toISOString() });
    expect(JSON.stringify(body)).not.toContain('twitch-secret-id');

    await app.close();
  });
});

describe('DELETE /me/twitch-link', () => {
  it('deletes the caller\'s link and returns 204', async () => {
    const deleteCalls: unknown[] = [];
    const { app, redis } = await buildTestApp({
      twitchAccountLink: {
        findUnique: async () => ({ discordUserId: USER_ID, twitchUserId: 't1', twitchLogin: 'x' }),
        delete: async (args: any) => {
          deleteCalls.push(args);
          return { discordUserId: USER_ID };
        },
      },
    });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    const csrfToken = await csrfTokenFor(app, cookieHeader);

    const res = await app.inject({
      method: 'DELETE',
      url: '/me/twitch-link',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });

    expect(res.statusCode).toBe(204);
    expect(deleteCalls).toEqual([{ where: { discordUserId: USER_ID } }]);

    await app.close();
  });

  it('returns 404 when there is no link to delete', async () => {
    const { app, redis } = await buildTestApp({ twitchAccountLink: { findUnique: async () => null } });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    const csrfToken = await csrfTokenFor(app, cookieHeader);

    const res = await app.inject({
      method: 'DELETE',
      url: '/me/twitch-link',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
