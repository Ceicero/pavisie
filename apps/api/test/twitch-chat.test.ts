// The Twitch chat routes that remain on the Discord side after creator-dashboard phase 4 (ARCHITECTURE.md §19e):
// the owner-only bot-identity flow (`/owner/twitch-bot` + the `twitch_bot` OAuth callback) and the refusal of the
// removed `twitch_chat` (Discord-dashboard connect) callback. The Discord dashboard's read-only linked-channel notice
// and the guild-side unlink are tested with the rest of the Discord-link flow in `creator-twitch-discord.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, redisKey } from '@pavisie/core';
import type { PrismaStubOverrides } from '@pavisie/plugins/sdk/testing';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '600000000000000001';
const USER_ID = '600000000000000002';
const OWNER_ID = '600000000000000003';
const OUTSIDER_ID = '600000000000000004';

const ORIGINAL_TWITCH_CLIENT_ID = env.TWITCH_CLIENT_ID;
const ORIGINAL_TWITCH_CLIENT_SECRET = env.TWITCH_CLIENT_SECRET;
const ORIGINAL_BOT_OWNER_IDS = process.env.BOT_OWNER_IDS;

beforeEach(() => {
  process.env.BOT_OWNER_IDS = OWNER_ID;
});

afterEach(() => {
  env.TWITCH_CLIENT_ID = ORIGINAL_TWITCH_CLIENT_ID;
  env.TWITCH_CLIENT_SECRET = ORIGINAL_TWITCH_CLIENT_SECRET;
  if (ORIGINAL_BOT_OWNER_IDS === undefined) delete process.env.BOT_OWNER_IDS;
  else process.env.BOT_OWNER_IDS = ORIGINAL_BOT_OWNER_IDS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function configureTwitchEnv(): void {
  env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
}

// ---------------------------------------------------------------------------
// Generic in-memory Prisma fakes for the Twitch chat models — same recording-`Proxy`-over-a-`Map` shape as
// `integrations.test.ts`'s `integrationConnectionOverrides`/`webhookEndpointOverrides`, generalized once so
// every model here (channel/command/timer/connection/token/bot identity) shares one implementation. `matchWhere`
// additionally understands Prisma's compound-`@@unique` where-shape (e.g. `{ channelId_name: { channelId, name } }`)
// by recursing into the wrapper object's own keys, which happen to be real columns on the row.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, val]) => {
    if (val && typeof val === 'object' && !(val instanceof Date)) {
      if ('in' in (val as Record<string, unknown>)) {
        return (val as { in: unknown[] }).in.includes(row[key]);
      }
      return matchWhere(row, val);
    }
    return row[key] === val;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeModel(store: Map<string, any>, idPrefix: string, applyDefaults: (partial: any) => any) {
  let n = 1;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: async (args: any) => {
      let list = [...store.values()].filter((r) => matchWhere(r, args?.where));
      if (args?.orderBy) {
        const [field, dir] = Object.entries(args.orderBy)[0] as [string, string];
        list = [...list].sort((a, b) => {
          const av = a[field] instanceof Date ? a[field].getTime() : a[field];
          const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
          const cmp = av === bv ? 0 : av < bv ? -1 : 1;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      return list;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst: async (args: any) => [...store.values()].find((r) => matchWhere(r, args?.where)) ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: async (args: any) => [...store.values()].find((r) => matchWhere(r, args?.where)) ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    count: async (args: any) => [...store.values()].filter((r) => matchWhere(r, args?.where)).length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: async (args: any) => {
      const id = `${idPrefix}${n++}`;
      const row = applyDefaults({ id, ...args.data });
      store.set(id, row);
      return row;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: async (args: any) => {
      const id = args.where.id as string;
      const existing = store.get(id)!;
      const updated = { ...existing, ...args.data };
      store.set(id, updated);
      return updated;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete: async (args: any) => {
      const id = args.where.id as string;
      const existing = store.get(id)!;
      store.delete(id);
      return existing;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteMany: async (args: any) => {
      const toDelete = [...store.entries()].filter(([, r]) => matchWhere(r, args?.where));
      for (const [id] of toDelete) store.delete(id);
      return { count: toDelete.length };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert: async (args: any) => {
      const found = [...store.values()].find((r) => matchWhere(r, args.where));
      if (found) {
        const updated = { ...found, ...args.update };
        store.set(found.id, updated);
        return updated;
      }
      // Respect an explicit id on `create` (e.g. a fixed-id singleton upsert) instead of always minting a
      // fresh one — otherwise the row's own `.id` field and its Map key diverge, and a second upsert for the
      // same fixed id would `findMany`-match the row fine but never find it by key, creating a duplicate.
      const id = (args.create && args.create.id) || `${idPrefix}${n++}`;
      const row = applyDefaults({ ...args.create, id });
      store.set(id, row);
      return row;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function channelDefaults(partial: any) {
  return {
    enabled: true,
    status: 'PENDING',
    lastError: null,
    lastConnectedAt: null,
    commandPrefix: '!',
    connectionId: null,
    overlayTokenEnc: null,
    ttsOpenAiKeyEnc: null,
    rewardsEnabled: false,
    bridgeDiscordChannelId: null,
    bridgeDiscordToTwitch: false,
    bridgeTwitchToDiscord: false,
    bridgeWebhookId: null,
    bridgeWebhookTokenEnc: null,
    bridgeLastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function commandDefaults(partial: any) {
  return {
    cooldownSeconds: 5,
    minLevel: 'EVERYONE',
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function timerDefaults(partial: any) {
  return {
    enabled: true,
    lastFiredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rewardDefaults(partial: any) {
  return {
    rewardId: null,
    enabled: true,
    volume: 80,
    ttsTemplate: null,
    chatTemplate: null,
    soundUrl: null,
    discordChannelId: null,
    discordTemplate: null,
    cooldownSeconds: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function connectionDefaults(partial: any) {
  return {
    status: 'PENDING',
    config: {},
    label: null,
    externalAccountId: null,
    externalAccountName: null,
    lastSyncAt: null,
    lastError: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tokenDefaults(partial: any) {
  return { rotatedAt: null, createdAt: new Date(), updatedAt: new Date(), ...partial };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function botIdentityDefaults(partial: any) {
  return {
    scopes: [],
    lastError: null,
    status: 'CONNECTED',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function guildOverride(guildId: string) {
  return { guild: { findUnique: async () => ({ id: guildId, botPresent: true }) } };
}

function twitchChatFixture(guildId: string = GUILD_ID) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channels = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commands = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const timers = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rewards = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connections = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oauthTokens = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const botIdentities = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const broadcasterTokens = new Map<string, any>();

  const overrides: PrismaStubOverrides = {
    ...guildOverride(guildId),
    twitchChatChannel: makeModel(channels, 'chan', channelDefaults),
    twitchChatCommand: makeModel(commands, 'cmd', commandDefaults),
    twitchChatTimer: makeModel(timers, 'timer', timerDefaults),
    twitchChatReward: makeModel(rewards, 'reward', rewardDefaults),
    integrationConnection: makeModel(connections, 'conn', connectionDefaults),
    oAuthToken: makeModel(oauthTokens, 'token', tokenDefaults),
    twitchBotIdentity: makeModel(botIdentities, 'bot', botIdentityDefaults),
    twitchBroadcasterToken: makeModel(broadcasterTokens, 'btok', tokenDefaults),
  };

  return { channels, commands, timers, rewards, connections, oauthTokens, botIdentities, broadcasterTokens, overrides };
}

async function setupAuthedApp(overrides: PrismaStubOverrides, userId: string = USER_ID) {
  const { app, redis, ...rest } = await buildTestApp(overrides);
  const { cookieHeader, session } = await loginAs(app, redis, { userId });
  await seedUserGuilds(redis, userId, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  return { app, redis, cookieHeader, csrfToken: session.csrfToken, ...rest };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubTwitchFetch(
  opts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tokenBody?: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usersBody?: any;
  } = {},
) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('id.twitch.tv/oauth2/token')) {
      return jsonResponse(
        // Twitch's real `POST /oauth2/token` returns `scope` as a JSON array of strings, not a space-delimited
        // string like most other providers — this is the shape that broke the naive `token.scope.split(' ')`
        // in production. Kept as an array here (rather than the old string form) so every test exercising this
        // default goes through the array-normalization path.
        opts.tokenBody ?? {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 14400,
          token_type: 'bearer',
          scope: ['channel:bot'],
        },
      );
    }
    if (url.includes('api.twitch.tv/helix/users')) {
      return jsonResponse(
        opts.usersBody ?? {
          data: [{ id: 'twitch-user-1', login: 'coolstreamer', display_name: 'CoolStreamer' }],
        },
      );
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Owner-only /owner/twitch-bot
// ---------------------------------------------------------------------------

describe('owner /owner/twitch-bot', () => {
  it('401s with no session, 403s for a non-owner, on all three routes', async () => {
    const fixture = twitchChatFixture();
    const { app, redis } = await buildTestApp(fixture.overrides);

    const anon = await app.inject({ method: 'GET', url: '/owner/twitch-bot' });
    expect(anon.statusCode).toBe(401);

    const { cookieHeader, session } = await loginAs(app, redis, { userId: OUTSIDER_ID });
    for (const req of [
      { method: 'GET' as const, url: '/owner/twitch-bot' },
      { method: 'POST' as const, url: '/owner/twitch-bot/connect' },
      { method: 'DELETE' as const, url: '/owner/twitch-bot' },
    ]) {
      const res = await app.inject({
        ...req,
        headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken },
      });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it('GET reports { configured: false } when no bot identity exists', async () => {
    const fixture = twitchChatFixture();
    const { app, redis } = await buildTestApp(fixture.overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: OWNER_ID });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/twitch-bot',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false });
    await app.close();
  });

  it('GET returns the identity DTO (never tokens) once configured', async () => {
    const fixture = twitchChatFixture();
    fixture.botIdentities.set(
      'bot1',
      botIdentityDefaults({
        id: 'bot1',
        botUserId: 'bot-uid',
        botLogin: 'pavisiebot',
        accessTokenEnc: 'enc-a',
        refreshTokenEnc: 'enc-r',
        scopes: ['user:bot'],
      }),
    );
    const { app, redis } = await buildTestApp(fixture.overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: OWNER_ID });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/twitch-bot',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      botLogin: 'pavisiebot',
      botUserId: 'bot-uid',
      status: 'connected',
      scopes: ['user:bot'],
    });
    expect(body.accessTokenEnc).toBeUndefined();
    expect(body.refreshTokenEnc).toBeUndefined();
    await app.close();
  });

  it('POST connect 502s when Twitch env is not configured, else returns the bot-scoped authorize URL with no guildId in state', async () => {
    const fixture = twitchChatFixture();
    const { app, redis } = await buildTestApp(fixture.overrides);
    const { cookieHeader, session } = await loginAs(app, redis, { userId: OWNER_ID });

    const before = await app.inject({
      method: 'POST',
      url: '/owner/twitch-bot/connect',
      headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken },
    });
    expect(before.statusCode).toBe(502);

    configureTwitchEnv();
    const res = await app.inject({
      method: 'POST',
      url: '/owner/twitch-bot/connect',
      headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken },
    });
    expect(res.statusCode).toBe(200);
    const { url } = res.json() as { url: string };
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe('user:read:chat user:write:chat user:bot');

    const state = parsed.searchParams.get('state')!;
    const raw = await redis.get(redisKey('oauthstate', 'integration', state));
    const payload = JSON.parse(raw!);
    expect(payload).toMatchObject({ provider: 'twitch', userId: OWNER_ID, kind: 'twitch_bot' });
    expect(payload.guildId).toBeUndefined();
    await app.close();
  });

  it('DELETE 404s when nothing is configured, else removes the row', async () => {
    const fixture = twitchChatFixture();
    fixture.botIdentities.set(
      'bot1',
      botIdentityDefaults({ id: 'bot1', botUserId: 'bot-uid', botLogin: 'pavisiebot' }),
    );
    const { app, redis, queues } = await buildTestApp(fixture.overrides);
    const { cookieHeader, session } = await loginAs(app, redis, { userId: OWNER_ID });

    const del = await app.inject({
      method: 'DELETE',
      url: '/owner/twitch-bot',
      headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken },
    });
    expect(del.statusCode).toBe(204);
    expect(fixture.botIdentities.has('bot1')).toBe(false);

    // Global nudge (no guildId) — every guild's chat channel just lost its shared credentials.
    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);

    const again = await app.inject({
      method: 'DELETE',
      url: '/owner/twitch-bot',
      headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken },
    });
    expect(again.statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// OAuth callback purpose branches
// ---------------------------------------------------------------------------

describe('GET /integrations/twitch/callback — twitch_bot purpose and the removed twitch_chat purpose', () => {
  async function seedState(
    redis: import('ioredis').default,
    state: string,
    payload: Record<string, unknown>,
  ) {
    await redis.set(redisKey('oauthstate', 'integration', state), JSON.stringify(payload), 'EX', 600);
  }

  it('twitch_bot: upserts the singleton TwitchBotIdentity and never redirects to a guild page', async () => {
    configureTwitchEnv();
    const fixture = twitchChatFixture();
    const { app, redis, queues } = await buildTestApp(fixture.overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: OWNER_ID });
    await seedState(redis, 'state-bot-1', { provider: 'twitch', userId: OWNER_ID, kind: 'twitch_bot' });
    stubTwitchFetch({
      // The real bot-connect flow requests three scopes (`buildProviderAuthorizeUrl`'s `scopeOverride` in
      // `routes/twitch-bot.ts`), and Twitch always returns them back as a JSON array, never a string — exercise
      // that multi-element array shape here rather than the single-scope default.
      tokenBody: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 14400,
        token_type: 'bearer',
        scope: ['user:read:chat', 'user:write:chat', 'user:bot'],
      },
      usersBody: { data: [{ id: 'bot-uid', login: 'pavisiebot', display_name: 'PavisieBot' }] },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=state-bot-1`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('pavisiebot');

    expect(fixture.botIdentities.size).toBe(1);
    const identity = [...fixture.botIdentities.values()][0];
    expect(identity).toMatchObject({
      id: 'twitch-bot-identity',
      botUserId: 'bot-uid',
      botLogin: 'pavisiebot',
      status: 'CONNECTED',
      scopes: ['user:read:chat', 'user:write:chat', 'user:bot'],
    });
    expect(identity.accessTokenEnc).not.toBe('new-access-token');

    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);
    await app.close();
  });

  it('twitch_bot re-auth replaces tokens on the same singleton row rather than creating a second one', async () => {
    configureTwitchEnv();
    const fixture = twitchChatFixture();
    // Seeded under the fixed singleton id (`TWITCH_BOT_IDENTITY_ID` in oauth-integrations.ts) — the upsert
    // looks the row up by that id, not "whatever row happens to exist" (that was the pre-fix behavior; a row
    // under any other id would no longer be found, and this re-auth would create a second row instead).
    fixture.botIdentities.set(
      'twitch-bot-identity',
      botIdentityDefaults({
        id: 'twitch-bot-identity',
        botUserId: 'old-uid',
        botLogin: 'oldlogin',
        accessTokenEnc: 'old-enc',
        refreshTokenEnc: 'old-refresh-enc',
        scopes: ['old:scope'],
      }),
    );
    const { app, redis, queues } = await buildTestApp(fixture.overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: OWNER_ID });
    await seedState(redis, 'state-bot-2', { provider: 'twitch', userId: OWNER_ID, kind: 'twitch_bot' });
    stubTwitchFetch({
      usersBody: { data: [{ id: 'bot-uid', login: 'pavisiebot', display_name: 'PavisieBot' }] },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=state-bot-2`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);

    expect(fixture.botIdentities.size).toBe(1);
    const identity = fixture.botIdentities.get('twitch-bot-identity');
    expect(identity).toMatchObject({ botUserId: 'bot-uid', botLogin: 'pavisiebot' });

    // The bot identity is global, not guild-scoped — the nudge still fires, with no guildId.
    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);
    await app.close();
  });

  it('a legacy twitch_chat state (issued by the removed Discord-dashboard connect) is refused: nothing is written and Twitch is never called', async () => {
    configureTwitchEnv();
    const fixture = twitchChatFixture();
    const { app, redis } = await buildTestApp(fixture.overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedState(redis, 'state-chat-legacy', {
      guildId: GUILD_ID,
      provider: 'twitch',
      userId: USER_ID,
      kind: 'twitch_chat',
    });
    const fetchMock = stubTwitchFetch();

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=state-chat-legacy`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/creator dashboard/i);
    expect(fetchMock).not.toHaveBeenCalled(); // the code is never exchanged
    expect(fixture.connections.size).toBe(0);
    expect(fixture.channels.size).toBe(0);
    expect(fixture.oauthTokens.size).toBe(0);
    expect(fixture.broadcasterTokens.size).toBe(0);
    expect(await redis.get(redisKey('oauthstate', 'integration', 'state-chat-legacy'))).toBeNull(); // consumed
    await app.close();
  });

  it('a legacy twitch_chat callback started from a different account is still refused as a CSRF attempt (403)', async () => {
    configureTwitchEnv();
    const fixture = twitchChatFixture();
    const { app, redis } = await buildTestApp(fixture.overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: OUTSIDER_ID });
    await seedState(redis, 'state-chat-csrf', {
      guildId: GUILD_ID,
      provider: 'twitch',
      userId: USER_ID,
      kind: 'twitch_chat',
    });
    const fetchMock = stubTwitchFetch();

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=state-chat-csrf`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fixture.connections.size).toBe(0);
    await app.close();
  });
});
