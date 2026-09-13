import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret, env, redisKey } from '@pavisie/core';
import type { PrismaStubOverrides } from '@pavisie/plugins/sdk/testing';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '600000000000000001';
const OTHER_GUILD_ID = '600000000000000009';
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
    rewardsEnabled: false,
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

  const overrides: PrismaStubOverrides = {
    ...guildOverride(guildId),
    twitchChatChannel: makeModel(channels, 'chan', channelDefaults),
    twitchChatCommand: makeModel(commands, 'cmd', commandDefaults),
    twitchChatTimer: makeModel(timers, 'timer', timerDefaults),
    twitchChatReward: makeModel(rewards, 'reward', rewardDefaults),
    integrationConnection: makeModel(connections, 'conn', connectionDefaults),
    oAuthToken: makeModel(oauthTokens, 'token', tokenDefaults),
    twitchBotIdentity: makeModel(botIdentities, 'bot', botIdentityDefaults),
  };

  return { channels, commands, timers, rewards, connections, oauthTokens, botIdentities, overrides };
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
// GET status
// ---------------------------------------------------------------------------

describe('GET /guilds/:guildId/integrations/twitch-chat', () => {
  it('401s with no session', async () => {
    const { app } = await buildTestApp(twitchChatFixture().overrides);
    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/integrations/twitch-chat` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('403s for a user without manage access on the guild', async () => {
    const { app, redis } = await buildTestApp(twitchChatFixture().overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: OUTSIDER_ID });
    await seedUserGuilds(redis, OUTSIDER_ID, []); // not in any guilds
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('reports env/bot not configured and an empty channel list on a fresh guild', async () => {
    const fixture = twitchChatFixture();
    const { app, cookieHeader } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ botConfigured: false, botLogin: null, envConfigured: false, channels: [] });
    await app.close();
  });

  it('reports envConfigured/botConfigured true and lists the guild channel once both exist', async () => {
    configureTwitchEnv();
    const fixture = twitchChatFixture();
    fixture.botIdentities.set(
      'bot1',
      botIdentityDefaults({ id: 'bot1', botUserId: 'bot-uid', botLogin: 'pavisiebot' }),
    );
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 'streamer-1',
        broadcasterLogin: 'coolstreamer',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.botConfigured).toBe(true);
    expect(body.botLogin).toBe('pavisiebot');
    expect(body.envConfigured).toBe(true);
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({
      broadcasterLogin: 'coolstreamer',
      broadcasterUserId: 'streamer-1',
      status: 'pending',
      commandPrefix: '!',
    });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST connect
// ---------------------------------------------------------------------------

describe('POST /guilds/:guildId/integrations/twitch-chat/connect', () => {
  it('502s when TWITCH_CLIENT_ID/SECRET are not set', async () => {
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(twitchChatFixture().overrides);
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/connect`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('requests BOTH chat and channel-point scopes, and stores twitch_chat state in redis', async () => {
    configureTwitchEnv();
    const { app, redis, cookieHeader, csrfToken } = await setupAuthedApp(twitchChatFixture().overrides);
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/connect`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(res.statusCode).toBe(200);
    const { url } = res.json() as { url: string };
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    // Both scopes, every time. `channel:read:redemptions` can only ever come from the broadcaster's own
    // grant, so if this URL omits it, channel points is unreachable and re-linking cannot fix it — the exact
    // bug this assertion previously encoded by expecting 'channel:bot' alone.
    const scopes = (parsed.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toContain('channel:bot');
    expect(scopes).toContain('channel:read:redemptions');
    expect(parsed.searchParams.get('client_id')).toBe('test-twitch-client-id');

    const state = parsed.searchParams.get('state')!;
    const raw = await redis.get(redisKey('oauthstate', 'integration', state));
    expect(JSON.parse(raw!)).toMatchObject({
      guildId: GUILD_ID,
      provider: 'twitch',
      userId: USER_ID,
      kind: 'twitch_chat',
    });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Channel PATCH / DELETE
// ---------------------------------------------------------------------------

describe('channel PATCH/DELETE', () => {
  it('404s PATCH for a channel that does not exist in this guild', async () => {
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(twitchChatFixture().overrides);
    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/missing`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a multi-character command prefix (400)', async () => {
    const fixture = twitchChatFixture();
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { commandPrefix: '!!' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects "/" and " " as a command prefix (400)', async () => {
    const fixture = twitchChatFixture();
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    for (const prefix of ['/', ' ']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1`,
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
        payload: { commandPrefix: prefix },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it('updates enabled + commandPrefix on a valid PATCH', async () => {
    const fixture = twitchChatFixture();
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken, queues } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { enabled: false, commandPrefix: '?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, commandPrefix: '?' });

    // Nudges the bot to reconcile right away rather than wait for its next per-minute tick.
    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);
    await app.close();
  });

  it('404s DELETE for a channel in a different guild', async () => {
    const fixture = twitchChatFixture();
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: OTHER_GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('deletes the channel, disconnects its linked IntegrationConnection, and drops its OAuthToken', async () => {
    const fixture = twitchChatFixture();
    fixture.connections.set(
      'conn1',
      connectionDefaults({
        id: 'conn1',
        guildId: GUILD_ID,
        provider: 'TWITCH',
        status: 'CONNECTED',
        connectedBy: USER_ID,
      }),
    );
    fixture.oauthTokens.set(
      'token1',
      tokenDefaults({ id: 'token1', connectionId: 'conn1', accessTokenEnc: 'enc', scopes: [] }),
    );
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        connectionId: 'conn1',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken, queues } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(res.statusCode).toBe(204);
    expect(fixture.channels.has('chan1')).toBe(false);
    expect(fixture.connections.get('conn1')?.status).toBe('DISCONNECTED');
    expect(fixture.oauthTokens.has('token1')).toBe(false);

    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Commands CRUD
// ---------------------------------------------------------------------------

describe('commands CRUD', () => {
  function fixtureWithChannel() {
    const fixture = twitchChatFixture();
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        createdBy: USER_ID,
      }),
    );
    return fixture;
  }

  it('404s listing/creating commands under a channel that does not exist', async () => {
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(twitchChatFixture().overrides);
    const getRes = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/missing/commands`,
      headers: { cookie: cookieHeader },
    });
    expect(getRes.statusCode).toBe(404);

    const postRes = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/missing/commands`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { name: 'hello', response: 'hi there' },
    });
    expect(postRes.statusCode).toBe(404);
    await app.close();
  });

  it('creates a command (201) and lists it', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken, queues } = await setupAuthedApp(fixture.overrides);

    const create = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/commands`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { name: 'hello', response: 'hi {user}!', cooldownSeconds: 10, minLevel: 'subscriber' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created).toMatchObject({
      name: 'hello',
      response: 'hi {user}!',
      cooldownSeconds: 10,
      minLevel: 'subscriber',
      enabled: true,
    });
    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/commands`,
      headers: { cookie: cookieHeader },
    });
    expect(list.json()).toHaveLength(1);
    await app.close();
  });

  it('rejects a reserved built-in command name (400)', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    for (const name of ['commands', 'uptime', 'title']) {
      const res = await app.inject({
        method: 'POST',
        url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/commands`,
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
        payload: { name, response: 'x' },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it('rejects creating a 51st command (cap 50 per channel)', async () => {
    const fixture = fixtureWithChannel();
    for (let i = 0; i < 50; i++) {
      fixture.commands.set(
        `cmd${i}`,
        commandDefaults({
          id: `cmd${i}`,
          channelId: 'chan1',
          guildId: GUILD_ID,
          name: `cmd${i}`,
          response: 'x',
          createdBy: USER_ID,
        }),
      );
    }
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/commands`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { name: 'onemore', response: 'x' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a duplicate command name in the same channel (409)', async () => {
    const fixture = fixtureWithChannel();
    fixture.commands.set(
      'cmd1',
      commandDefaults({
        id: 'cmd1',
        channelId: 'chan1',
        guildId: GUILD_ID,
        name: 'hello',
        response: 'x',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/commands`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { name: 'hello', response: 'y' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('404s PATCH/DELETE for a command belonging to a different guild', async () => {
    const fixture = fixtureWithChannel();
    fixture.commands.set(
      'cmd1',
      commandDefaults({
        id: 'cmd1',
        channelId: 'chan1',
        guildId: OTHER_GUILD_ID,
        name: 'hello',
        response: 'x',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/commands/cmd1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { response: 'new' },
    });
    expect(patch.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/commands/cmd1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(del.statusCode).toBe(404);
    await app.close();
  });

  it('updates and deletes a command it owns', async () => {
    const fixture = fixtureWithChannel();
    fixture.commands.set(
      'cmd1',
      commandDefaults({
        id: 'cmd1',
        channelId: 'chan1',
        guildId: GUILD_ID,
        name: 'hello',
        response: 'x',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken, queues, prismaCalls } = await setupAuthedApp(fixture.overrides);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/commands/cmd1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { response: 'updated response', enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ response: 'updated response', enabled: false });

    // The audit row carries the old and new values, not just the target id (mirrors the channel PATCH).
    const patchAudit = prismaCalls.find(
      (c) => c.model === 'auditLog' && c.method === 'create',
    ) as unknown as { args: [{ data: { before: unknown; after: unknown } }] };
    expect(patchAudit.args[0].data.before).toMatchObject({ response: 'x', enabled: true });
    expect(patchAudit.args[0].data.after).toMatchObject({ response: 'updated response', enabled: false });

    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/commands/cmd1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(del.statusCode).toBe(204);
    expect(fixture.commands.has('cmd1')).toBe(false);

    // The DELETE nudges too, not just the PATCH above — two reconcile jobs queued in total.
    expect(
      queues.calls.filter(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toHaveLength(2);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Timers CRUD
// ---------------------------------------------------------------------------

describe('timers CRUD', () => {
  function fixtureWithChannel() {
    const fixture = twitchChatFixture();
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        createdBy: USER_ID,
      }),
    );
    return fixture;
  }

  it('creates a timer (201) and lists it', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken, queues } = await setupAuthedApp(fixture.overrides);

    const create = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/timers`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { name: 'discord_plug', message: 'Join our Discord!', intervalMinutes: 30 },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({
      name: 'discord_plug',
      message: 'Join our Discord!',
      intervalMinutes: 30,
      enabled: true,
    });
    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/timers`,
      headers: { cookie: cookieHeader },
    });
    expect(list.json()).toHaveLength(1);
    await app.close();
  });

  it('rejects an interval outside 5..1440 minutes (400)', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    for (const intervalMinutes of [1, 1441]) {
      const res = await app.inject({
        method: 'POST',
        url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/timers`,
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
        payload: { name: 'x', message: 'y', intervalMinutes },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it('rejects creating an 11th timer (cap 10 per channel)', async () => {
    const fixture = fixtureWithChannel();
    for (let i = 0; i < 10; i++) {
      fixture.timers.set(
        `timer${i}`,
        timerDefaults({
          id: `timer${i}`,
          channelId: 'chan1',
          guildId: GUILD_ID,
          name: `timer${i}`,
          message: 'x',
          intervalMinutes: 30,
          createdBy: USER_ID,
        }),
      );
    }
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/timers`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { name: 'onemore', message: 'x', intervalMinutes: 30 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a duplicate timer name in the same channel (409)', async () => {
    const fixture = fixtureWithChannel();
    fixture.timers.set(
      'timer1',
      timerDefaults({
        id: 'timer1',
        channelId: 'chan1',
        guildId: GUILD_ID,
        name: 'plug',
        message: 'x',
        intervalMinutes: 30,
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/timers`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { name: 'plug', message: 'y', intervalMinutes: 15 },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('updates and deletes a timer it owns; 404s for one in a different guild', async () => {
    const fixture = fixtureWithChannel();
    fixture.timers.set(
      'timer1',
      timerDefaults({
        id: 'timer1',
        channelId: 'chan1',
        guildId: GUILD_ID,
        name: 'plug',
        message: 'x',
        intervalMinutes: 30,
        createdBy: USER_ID,
      }),
    );
    fixture.timers.set(
      'timerOther',
      timerDefaults({
        id: 'timerOther',
        channelId: 'chanX',
        guildId: OTHER_GUILD_ID,
        name: 'other',
        message: 'x',
        intervalMinutes: 30,
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken, queues, prismaCalls } = await setupAuthedApp(fixture.overrides);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/timers/timer1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { intervalMinutes: 60, enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ intervalMinutes: 60, enabled: false });

    // The audit row carries the old and new values, not just the target id (mirrors the channel PATCH).
    const patchAudit = prismaCalls.find(
      (c) => c.model === 'auditLog' && c.method === 'create',
    ) as unknown as { args: [{ data: { before: unknown; after: unknown } }] };
    expect(patchAudit.args[0].data.before).toMatchObject({ intervalMinutes: 30, enabled: true });
    expect(patchAudit.args[0].data.after).toMatchObject({ intervalMinutes: 60, enabled: false });

    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);

    const wrongGuild = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/timers/timerOther`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(wrongGuild.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/timers/timer1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(del.statusCode).toBe(204);
    expect(fixture.timers.has('timer1')).toBe(false);

    // The DELETE nudges too (the failed wrongGuild attempt above does not) — two reconcile jobs in total.
    expect(
      queues.calls.filter(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toHaveLength(2);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Channel rewardsEnabled toggle
// ---------------------------------------------------------------------------

describe('channel PATCH rewardsEnabled', () => {
  it('toggles rewardsEnabled and nudges reconcile, leaving other fields untouched', async () => {
    const fixture = twitchChatFixture();
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken, queues, prismaCalls } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { rewardsEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rewardsEnabled: true, enabled: true, commandPrefix: '!' });

    const patchAudit = prismaCalls.find(
      (c) => c.model === 'auditLog' && c.method === 'create',
    ) as unknown as { args: [{ data: { before: unknown; after: unknown } }] };
    expect(patchAudit.args[0].data.before).toMatchObject({ rewardsEnabled: false });
    expect(patchAudit.args[0].data.after).toMatchObject({ rewardsEnabled: true });

    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Rewards CRUD
// ---------------------------------------------------------------------------

describe('rewards CRUD', () => {
  function fixtureWithChannel() {
    const fixture = twitchChatFixture();
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        createdBy: USER_ID,
      }),
    );
    return fixture;
  }

  it('404s listing/creating rewards under a channel that does not exist', async () => {
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(twitchChatFixture().overrides);
    const getRes = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/missing/rewards`,
      headers: { cookie: cookieHeader },
    });
    expect(getRes.statusCode).toBe(404);

    const postRes = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/missing/rewards`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { rewardTitle: 'Hydrate', action: 'chat', chatTemplate: 'Drink water, {user}!' },
    });
    expect(postRes.statusCode).toBe(404);
    await app.close();
  });

  it('creates a CHAT reward (201) and lists it', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken, queues } = await setupAuthedApp(fixture.overrides);

    const create = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/rewards`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { rewardTitle: 'Hydrate', action: 'chat', chatTemplate: 'Drink water, {user}!' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({
      rewardTitle: 'Hydrate',
      action: 'chat',
      chatTemplate: 'Drink water, {user}!',
      enabled: true,
      cooldownSeconds: 0,
    });
    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/rewards`,
      headers: { cookie: cookieHeader },
    });
    expect(list.json()).toHaveLength(1);
    await app.close();
  });

  it('creates a SOUND reward with a public https URL', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    // A public IP literal, not a hostname — `assertPublicHttpUrl` skips DNS resolution entirely for a literal
    // IP (judges it directly), so this doesn't depend on the test sandbox having real DNS/network access.
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/rewards`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: {
        rewardTitle: 'Air horn',
        action: 'sound',
        soundUrl: 'https://1.1.1.1/airhorn.mp3',
        volume: 60,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      action: 'sound',
      soundUrl: 'https://1.1.1.1/airhorn.mp3',
      volume: 60,
    });
    await app.close();
  });

  it('rejects a SOUND reward whose URL resolves to a private/internal address (SSRF guard)', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/rewards`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { rewardTitle: 'Air horn', action: 'sound', soundUrl: 'https://169.254.169.254/steal' },
    });
    expect(res.statusCode).toBe(400);
    const fixtureAfter = fixture.rewards.size;
    expect(fixtureAfter).toBe(0);
    await app.close();
  });

  it('rejects a plain-http sound URL at the schema layer (400)', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/rewards`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { rewardTitle: 'Air horn', action: 'sound', soundUrl: 'http://cdn.example.com/airhorn.mp3' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it.each(['sound', 'tts', 'chat', 'discord'])('rejects a %s reward missing its required field(s) (400)', async (action) => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/rewards`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { rewardTitle: 'Test', action },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a reward whose payload carries fields from a different action (400)', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/rewards`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { rewardTitle: 'Hydrate', action: 'chat', chatTemplate: 'hi', soundUrl: 'https://x.example.com/a.mp3' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects creating a 26th reward (cap 25 per channel)', async () => {
    const fixture = fixtureWithChannel();
    for (let i = 0; i < 25; i++) {
      fixture.rewards.set(
        `reward${i}`,
        rewardDefaults({
          id: `reward${i}`,
          channelId: 'chan1',
          guildId: GUILD_ID,
          rewardTitle: `Reward ${i}`,
          action: 'CHAT',
          chatTemplate: 'x',
          createdBy: USER_ID,
        }),
      );
    }
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/rewards`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { rewardTitle: 'One more', action: 'chat', chatTemplate: 'x' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a duplicate (title, action) pair in the same channel (409)', async () => {
    const fixture = fixtureWithChannel();
    fixture.rewards.set(
      'reward1',
      rewardDefaults({
        id: 'reward1',
        channelId: 'chan1',
        guildId: GUILD_ID,
        rewardTitle: 'Hydrate',
        action: 'CHAT',
        chatTemplate: 'x',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/rewards`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { rewardTitle: 'Hydrate', action: 'chat', chatTemplate: 'y' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('allows the same title under a different action (no clash — unique key includes action)', async () => {
    const fixture = fixtureWithChannel();
    fixture.rewards.set(
      'reward1',
      rewardDefaults({
        id: 'reward1',
        channelId: 'chan1',
        guildId: GUILD_ID,
        rewardTitle: 'Hydrate',
        action: 'CHAT',
        chatTemplate: 'x',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/rewards`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { rewardTitle: 'Hydrate', action: 'tts', ttsTemplate: 'Drink water' },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('404s PATCH/DELETE for a reward belonging to a different guild (guild tenancy)', async () => {
    const fixture = fixtureWithChannel();
    fixture.rewards.set(
      'reward1',
      rewardDefaults({
        id: 'reward1',
        channelId: 'chan1',
        guildId: OTHER_GUILD_ID,
        rewardTitle: 'Hydrate',
        action: 'CHAT',
        chatTemplate: 'x',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/rewards/reward1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { chatTemplate: 'new' },
    });
    expect(patch.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/rewards/reward1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(del.statusCode).toBe(404);
    await app.close();
  });

  it('updates and deletes a reward it owns', async () => {
    const fixture = fixtureWithChannel();
    fixture.rewards.set(
      'reward1',
      rewardDefaults({
        id: 'reward1',
        channelId: 'chan1',
        guildId: GUILD_ID,
        rewardTitle: 'Hydrate',
        action: 'CHAT',
        chatTemplate: 'x',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken, queues, prismaCalls } = await setupAuthedApp(fixture.overrides);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/rewards/reward1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { chatTemplate: 'updated template', enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ chatTemplate: 'updated template', enabled: false });

    const patchAudit = prismaCalls.find(
      (c) => c.model === 'auditLog' && c.method === 'create',
    ) as unknown as { args: [{ data: { before: unknown; after: unknown } }] };
    expect(patchAudit.args[0].data.before).toMatchObject({ enabled: true });
    expect(patchAudit.args[0].data.after).toMatchObject({ enabled: false });

    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/rewards/reward1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(del.statusCode).toBe(204);
    expect(fixture.rewards.has('reward1')).toBe(false);
    await app.close();
  });

  it('rejects switching action to "sound" without also supplying soundUrl in the same PATCH (400)', async () => {
    const fixture = fixtureWithChannel();
    fixture.rewards.set(
      'reward1',
      rewardDefaults({
        id: 'reward1',
        channelId: 'chan1',
        guildId: GUILD_ID,
        rewardTitle: 'Hydrate',
        action: 'CHAT',
        chatTemplate: 'x',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/rewards/reward1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { action: 'sound' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('switching action to "sound" WITH soundUrl clears the old chatTemplate field', async () => {
    const fixture = fixtureWithChannel();
    fixture.rewards.set(
      'reward1',
      rewardDefaults({
        id: 'reward1',
        channelId: 'chan1',
        guildId: GUILD_ID,
        rewardTitle: 'Hydrate',
        action: 'CHAT',
        chatTemplate: 'old template',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/rewards/reward1`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { action: 'sound', soundUrl: 'https://1.1.1.1/a.mp3' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      action: 'sound',
      soundUrl: 'https://1.1.1.1/a.mp3',
      chatTemplate: null,
    });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Overlay token
// ---------------------------------------------------------------------------

describe('overlay token', () => {
  function fixtureWithChannel() {
    const fixture = twitchChatFixture();
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        createdBy: USER_ID,
      }),
    );
    return fixture;
  }

  it('404s for a channel that does not exist', async () => {
    const { app, cookieHeader } = await setupAuthedApp(twitchChatFixture().overrides);
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/missing/overlay`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET reports no token and never auto-generates one', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/overlay`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: null, hasToken: false });
    expect(fixture.channels.get('chan1')?.overlayTokenEnc).toBeNull();
    await app.close();
  });

  it('regenerate stores an encrypted token, writes the Redis index, and returns the URL once', async () => {
    const fixture = fixtureWithChannel();
    const { app, redis, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/overlay/regenerate`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; hasToken: boolean };
    expect(body.hasToken).toBe(true);
    expect(body.url).toMatch(/\/overlay\/[0-9a-f]{48}$/);
    const token = body.url.split('/overlay/')[1];

    // Stored encrypted, never plaintext.
    const stored = fixture.channels.get('chan1')?.overlayTokenEnc as string;
    expect(stored).toBeDefined();
    expect(stored).not.toBe(token);
    expect(decryptSecret(stored)).toBe(token);

    // The durable Redis index the SSE route resolves by, with no TTL.
    expect(await redis.get(redisKey('overlay', 'token', token))).toBe('chan1');
    expect(await redis.ttl(redisKey('overlay', 'token', token))).toBe(-1);

    // A subsequent GET reports hasToken but never the URL again.
    const follow = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/overlay`,
      headers: { cookie: cookieHeader },
    });
    expect(follow.json()).toEqual({ url: null, hasToken: true });
    await app.close();
  });

  it('regenerating replaces the old token: old Redis index gone, new one resolves', async () => {
    const fixture = fixtureWithChannel();
    const { app, redis, cookieHeader, csrfToken } = await setupAuthedApp(fixture.overrides);

    const first = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/overlay/regenerate`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    const firstToken = (first.json() as { url: string }).url.split('/overlay/')[1];

    const second = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/overlay/regenerate`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    const secondToken = (second.json() as { url: string }).url.split('/overlay/')[1];

    expect(secondToken).not.toBe(firstToken);
    expect(await redis.get(redisKey('overlay', 'token', firstToken))).toBeNull();
    expect(await redis.get(redisKey('overlay', 'token', secondToken))).toBe('chan1');
    await app.close();
  });

  it('audits the regeneration without ever writing the token/URL into the audit payload', async () => {
    const fixture = fixtureWithChannel();
    const { app, cookieHeader, csrfToken, prismaCalls } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/overlay/regenerate`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    const { url: overlayUrl } = res.json() as { url: string };
    const token = overlayUrl.split('/overlay/')[1];

    const audit = prismaCalls.find((c) => c.model === 'auditLog' && c.method === 'create') as unknown as {
      args: [{ data: { action: string; before: unknown; after: unknown } }];
    };
    expect(audit.args[0].data.action).toBe('integration.twitch_chat.overlay.regenerate');
    const serializedAudit = JSON.stringify(audit.args[0].data);
    expect(serializedAudit).not.toContain(token);
    expect(serializedAudit).not.toContain(overlayUrl);
    expect(audit.args[0].data.before).toEqual({ configured: false });
    expect(audit.args[0].data.after).toEqual({ configured: true });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Twitch reward picker (GET .../twitch-rewards)
// ---------------------------------------------------------------------------

describe('GET .../twitch-rewards (picker)', () => {
  it('honestly reports itself unavailable rather than inventing cross-process plumbing', async () => {
    const fixture = twitchChatFixture();
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 's1',
        broadcasterLogin: 'streamer',
        createdBy: USER_ID,
      }),
    );
    const { app, cookieHeader } = await setupAuthedApp(fixture.overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/chan1/twitch-rewards`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, rewards: [] });
    await app.close();
  });

  it('404s for a channel that does not exist in this guild', async () => {
    const { app, cookieHeader } = await setupAuthedApp(twitchChatFixture().overrides);
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/missing/twitch-rewards`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

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

describe('GET /integrations/twitch/callback — twitch_chat / twitch_bot purposes', () => {
  async function seedState(
    redis: import('ioredis').default,
    state: string,
    payload: Record<string, unknown>,
  ) {
    await redis.set(redisKey('oauthstate', 'integration', state), JSON.stringify(payload), 'EX', 600);
  }

  it('twitch_chat: creates the connection + token and upserts a PENDING TwitchChatChannel, then redirects', async () => {
    configureTwitchEnv();
    const fixture = twitchChatFixture();
    const { app, redis, queues } = await buildTestApp(fixture.overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedState(redis, 'state-chat-1', {
      guildId: GUILD_ID,
      provider: 'twitch',
      userId: USER_ID,
      kind: 'twitch_chat',
    });
    stubTwitchFetch();

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=state-chat-1`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `${env.DASHBOARD_URL}/dashboard/${GUILD_ID}/integrations?connected=twitch-chat`,
    );

    expect(fixture.connections.size).toBe(1);
    const connection = [...fixture.connections.values()][0];
    expect(connection).toMatchObject({
      guildId: GUILD_ID,
      provider: 'TWITCH',
      status: 'CONNECTED',
      label: 'Twitch chat: coolstreamer',
    });
    expect(connection.config).toEqual({ kind: 'chat' });

    expect(fixture.oauthTokens.size).toBe(1);
    const token = [...fixture.oauthTokens.values()][0];
    expect(token.connectionId).toBe(connection.id);
    expect(token.accessTokenEnc).not.toBe('new-access-token'); // stored encrypted, never plaintext
    // Twitch's real token response sends `scope` as a JSON array (see `stubTwitchFetch`'s default), and it
    // must land here as the same plain string[] a space-delimited-string provider would produce.
    expect(token.scopes).toEqual(['channel:bot']);

    expect(fixture.channels.size).toBe(1);
    const channel = [...fixture.channels.values()][0];
    expect(channel).toMatchObject({
      guildId: GUILD_ID,
      broadcasterUserId: 'twitch-user-1',
      broadcasterLogin: 'coolstreamer',
      status: 'PENDING',
      connectionId: connection.id,
    });

    // The state is single-use.
    expect(await redis.get(redisKey('oauthstate', 'integration', 'state-chat-1'))).toBeNull();

    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
      ),
    ).toBe(true);
    await app.close();
  });

  it('re-linking the same broadcaster retires the old connection + token and repoints the channel at the new one', async () => {
    configureTwitchEnv();
    const fixture = twitchChatFixture();
    fixture.connections.set(
      'conn-old',
      connectionDefaults({
        id: 'conn-old',
        guildId: GUILD_ID,
        provider: 'TWITCH',
        status: 'CONNECTED',
        config: { kind: 'chat' },
        connectedBy: USER_ID,
      }),
    );
    fixture.oauthTokens.set(
      'token-old',
      tokenDefaults({ id: 'token-old', connectionId: 'conn-old', accessTokenEnc: 'old-enc', scopes: [] }),
    );
    fixture.channels.set(
      'chan1',
      channelDefaults({
        id: 'chan1',
        guildId: GUILD_ID,
        broadcasterUserId: 'twitch-user-1',
        broadcasterLogin: 'coolstreamer',
        connectionId: 'conn-old',
        createdBy: USER_ID,
      }),
    );
    const { app, redis } = await buildTestApp(fixture.overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedState(redis, 'state-chat-relink', {
      guildId: GUILD_ID,
      provider: 'twitch',
      userId: USER_ID,
      kind: 'twitch_chat',
    });
    stubTwitchFetch();

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=state-chat-relink`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `${env.DASHBOARD_URL}/dashboard/${GUILD_ID}/integrations?connected=twitch-chat`,
    );

    // The old connection is retired exactly like `routes/twitch-chat.ts`'s DELETE: DISCONNECTED, token gone.
    expect(fixture.connections.get('conn-old')?.status).toBe('DISCONNECTED');
    expect(fixture.oauthTokens.has('token-old')).toBe(false);

    // A brand new connection was created rather than reusing/reviving the old one.
    expect(fixture.connections.size).toBe(2);
    const newConnection = [...fixture.connections.values()].find((c) => c.id !== 'conn-old')!;
    expect(newConnection.status).toBe('CONNECTED');

    // The channel now points at the new connection, not the retired one.
    expect(fixture.channels.size).toBe(1);
    expect(fixture.channels.get('chan1')?.connectionId).toBe(newConnection.id);
    await app.close();
  });

  it('rejects linking a broadcaster that is already linked from a different guild, creating nothing', async () => {
    configureTwitchEnv();
    const fixture = twitchChatFixture();
    fixture.connections.set(
      'conn-other-guild',
      connectionDefaults({
        id: 'conn-other-guild',
        guildId: OTHER_GUILD_ID,
        provider: 'TWITCH',
        status: 'CONNECTED',
        config: { kind: 'chat' },
        connectedBy: USER_ID,
      }),
    );
    fixture.channels.set(
      'chan-other-guild',
      channelDefaults({
        id: 'chan-other-guild',
        guildId: OTHER_GUILD_ID,
        broadcasterUserId: 'twitch-user-1',
        broadcasterLogin: 'coolstreamer',
        connectionId: 'conn-other-guild',
        createdBy: USER_ID,
      }),
    );
    const { app, redis } = await buildTestApp(fixture.overrides);
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedState(redis, 'state-chat-elsewhere', {
      guildId: GUILD_ID,
      provider: 'twitch',
      userId: USER_ID,
      kind: 'twitch_chat',
    });
    stubTwitchFetch();

    const res = await app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=state-chat-elsewhere`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `${env.DASHBOARD_URL}/dashboard/${GUILD_ID}/integrations?error=twitch-chat-already-linked`,
    );

    // Nothing was created for this guild, and the other guild's link is untouched.
    expect(fixture.connections.size).toBe(1);
    expect(fixture.channels.size).toBe(1);
    expect(fixture.connections.get('conn-other-guild')?.status).toBe('CONNECTED');
    await app.close();
  });

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

  it('rejects a twitch_chat callback started from a different account (account-linking CSRF)', async () => {
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
