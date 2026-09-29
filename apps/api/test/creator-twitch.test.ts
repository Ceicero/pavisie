import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, redisKey } from '@pavisie/core';
import { TWITCH_CHAT_RESERVED_COMMAND_NAMES } from '@pavisie/types/integrations';
import { buildTestApp, loginAs, loginAsCreator, seedUserGuilds } from './helpers/build-test-app';
import { creatorFixture, seedChannel, seedCommand, seedTimer } from './helpers/creator-fakes';

const CREATOR_A = '820000000001';
const CREATOR_B = '820000000002';
const GUILD_ID = '820000000000000001';
const WEB_BASE = (env.WEB_URL ?? env.DASHBOARD_URL) as string;

const ORIGINAL_TWITCH_CLIENT_ID = env.TWITCH_CLIENT_ID;
const ORIGINAL_TWITCH_CLIENT_SECRET = env.TWITCH_CLIENT_SECRET;

beforeEach(async () => {
  await new RedisMock().flushall(); // ioredis-mock shares one store process-wide; start each test clean
  env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
});

afterEach(() => {
  env.TWITCH_CLIENT_ID = ORIGINAL_TWITCH_CLIENT_ID;
  env.TWITCH_CLIENT_SECRET = ORIGINAL_TWITCH_CLIENT_SECRET;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Stubs Twitch so the account that "authorizes" is `twitchUserId`. */
function stubTwitchAs(twitchUserId: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
        return jsonResponse({
          access_token: 'broadcaster-access-token',
          refresh_token: 'broadcaster-refresh-token',
          expires_in: 14400,
          token_type: 'bearer',
          scope: ['channel:bot'],
        });
      }
      if (url.startsWith('https://api.twitch.tv/helix/users')) {
        return jsonResponse({ data: [{ id: twitchUserId, login: `login${twitchUserId}`, display_name: 'X' }] });
      }
      if (url.startsWith('https://id.twitch.tv/oauth2/revoke')) return new Response(null, { status: 200 });
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
}

/** Builds an app + one signed-in creator; `mutate` requests carry the creator's csrf token automatically. */
async function setup(creatorId = CREATOR_A) {
  const fixture = creatorFixture();
  const t: TestApp = await buildTestApp(fixture.overrides);
  const creator = await loginAsCreator(t.app, t.redis, { platformUserId: creatorId });
  const headers = { cookie: creator.cookieHeader, 'x-csrf-token': creator.session.csrfToken };
  return { ...t, fixture, creator, headers, read: { cookie: creator.cookieHeader } };
}

describe('every /creator/twitch route: 401 without a creator session', () => {
  const routes: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown }[] = [
    { method: 'GET', url: '/creator/twitch/channel' },
    { method: 'POST', url: '/creator/twitch/channel/connect' },
    { method: 'PATCH', url: '/creator/twitch/channel', payload: { enabled: false } },
    { method: 'DELETE', url: '/creator/twitch/channel' },
    { method: 'GET', url: '/creator/twitch/channel/commands' },
    { method: 'POST', url: '/creator/twitch/channel/commands', payload: { name: 'hi', response: 'hello' } },
    { method: 'PATCH', url: '/creator/twitch/channel/commands/x', payload: { enabled: false } },
    { method: 'DELETE', url: '/creator/twitch/channel/commands/x' },
    { method: 'GET', url: '/creator/twitch/channel/timers' },
    { method: 'POST', url: '/creator/twitch/channel/timers', payload: { name: 't', message: 'm', intervalMinutes: 10 } },
    { method: 'PATCH', url: '/creator/twitch/channel/timers/x', payload: { enabled: false } },
    { method: 'DELETE', url: '/creator/twitch/channel/timers/x' },
  ];

  for (const r of routes) {
    it(`${r.method} ${r.url}`, async () => {
      const { app, redis } = await buildTestApp(creatorFixture().overrides);
      // Even a Discord session must not get through.
      const discord = await loginAs(app, redis, { userId: '111111111111111111' });
      const res = await app.inject({
        method: r.method,
        url: r.url,
        payload: r.payload as object | undefined,
        headers: { cookie: discord.cookieHeader, 'x-csrf-token': discord.session.csrfToken },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  }
});

describe('POST /creator/twitch/channel/connect', () => {
  it('returns the channel:bot authorize URL (reused redirect URI) with a creator-connect state tied to this creator', async () => {
    const { app, redis, headers } = await setup();
    const res = await app.inject({ method: 'POST', url: '/creator/twitch/channel/connect', headers });
    expect(res.statusCode).toBe(200);

    const url = new URL(res.json().url);
    expect(`${url.origin}${url.pathname}`).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(url.searchParams.get('scope')).toBe('channel:bot');
    expect(url.searchParams.get('redirect_uri')).toBe(`${env.API_BASE_URL}/integrations/twitch/callback`);

    const state = url.searchParams.get('state')!;
    expect(JSON.parse((await redis.get(redisKey('creator-connect-state', state)))!)).toEqual({
      platform: 'twitch',
      platformUserId: CREATOR_A,
    });
    // Not a guild-flow state: nothing under the guild integration namespace.
    expect(await redis.get(redisKey('oauthstate', 'integration', state))).toBeNull();
    await app.close();
  });

  it('needs the creator csrf token', async () => {
    const { app, read } = await setup();
    const res = await app.inject({ method: 'POST', url: '/creator/twitch/channel/connect', headers: read });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('GET /integrations/twitch/callback — creator connect', () => {
  async function startConnect(t: Awaited<ReturnType<typeof setup>>): Promise<string> {
    const res = await t.app.inject({ method: 'POST', url: '/creator/twitch/channel/connect', headers: t.headers });
    return new URL(res.json().url).searchParams.get('state')!;
  }

  it('creates a GUILDLESS channel for the signed-in creator, stores no token, nudges the bot, redirects to /creator', async () => {
    const t = await setup();
    const state = await startConnect(t);
    stubTwitchAs(CREATOR_A);

    const res = await t.app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${state}`,
      headers: t.read, // creator cookie only — NO Discord session
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB_BASE}/creator?connected=twitch-chat`);

    expect(t.fixture.channels.size).toBe(1);
    const channel = [...t.fixture.channels.values()][0];
    expect(channel).toMatchObject({
      broadcasterUserId: CREATOR_A,
      broadcasterLogin: `login${CREATOR_A}`,
      status: 'PENDING',
      enabled: true,
      guildId: null,
      connectionId: null,
      createdBy: CREATOR_A,
    });
    // The broadcaster token is discarded: no connection/token rows.
    expect(t.fixture.connections.size).toBe(0);
    expect(t.fixture.oauthTokens.size).toBe(0);

    expect(await t.redis.get(redisKey('creator-connect-state', state))).toBeNull(); // single-use
    expect(
      t.queues.calls.some((c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile'),
    ).toBe(true);
    await t.app.close();
  });

  it('REJECTS a different Twitch account than the signed-in creator: writes nothing, redirects with an error', async () => {
    const t = await setup(CREATOR_A);
    const state = await startConnect(t);
    stubTwitchAs(CREATOR_B); // someone else's Twitch account authorized

    const res = await t.app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${state}`,
      headers: t.read,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB_BASE}/creator?error=twitch-account-mismatch`);
    expect(t.fixture.channels.size).toBe(0);
    expect(await t.redis.get(redisKey('creator-connect-state', state))).toBeNull(); // consumed
    await t.app.close();
  });

  it('requires the creator session (401) and does not consume the state without it', async () => {
    const t = await setup();
    const state = await startConnect(t);
    stubTwitchAs(CREATOR_A);

    const res = await t.app.inject({ method: 'GET', url: `/integrations/twitch/callback?code=abc&state=${state}` });
    expect(res.statusCode).toBe(401);
    expect(await t.redis.get(redisKey('creator-connect-state', state))).not.toBeNull();
    expect(t.fixture.channels.size).toBe(0);
    await t.app.close();
  });

  it('refuses a state that was issued to a different creator (403), even with a valid creator session', async () => {
    const t = await setup(CREATOR_A);
    const state = await startConnect(t);
    const other = await loginAsCreator(t.app, t.redis, { platformUserId: CREATOR_B });
    stubTwitchAs(CREATOR_B);

    const res = await t.app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${state}`,
      headers: { cookie: other.cookieHeader },
    });
    expect(res.statusCode).toBe(403);
    expect(t.fixture.channels.size).toBe(0);
    await t.app.close();
  });

  it('a replayed connect state is rejected', async () => {
    const t = await setup();
    const state = await startConnect(t);
    stubTwitchAs(CREATOR_A);
    const url = `/integrations/twitch/callback?code=abc&state=${state}`;
    expect((await t.app.inject({ method: 'GET', url, headers: t.read })).statusCode).toBe(302);
    const replay = await t.app.inject({ method: 'GET', url, headers: t.read });
    // No longer in the creator namespace -> falls to the Discord-session gate, which this creator lacks.
    expect(replay.statusCode).toBe(401);
    expect(t.fixture.channels.size).toBe(1);
    await t.app.close();
  });

  it('re-arms an existing GUILD-LINKED row in place: keeps its guildId and settings, re-enables it', async () => {
    const t = await setup();
    seedChannel(t.fixture, {
      id: 'chan-linked',
      broadcasterUserId: CREATOR_A,
      guildId: GUILD_ID,
      enabled: false,
      status: 'DISCONNECTED',
      commandPrefix: '?',
      connectionId: 'conn-guild',
    });
    const state = await startConnect(t);
    stubTwitchAs(CREATOR_A);

    const res = await t.app.inject({
      method: 'GET',
      url: `/integrations/twitch/callback?code=abc&state=${state}`,
      headers: t.read,
    });
    expect(res.statusCode).toBe(302);
    expect(t.fixture.channels.size).toBe(1);
    expect(t.fixture.channels.get('chan-linked')).toMatchObject({
      guildId: GUILD_ID,
      connectionId: 'conn-guild',
      commandPrefix: '?',
      enabled: true,
      status: 'PENDING',
    });
    await t.app.close();
  });
});

describe('guild link flow vs a guildless channel', () => {
  it('a Discord admin linking a broadcaster that already has a guildless (creator) channel is refused as already-linked', async () => {
    const fixture = creatorFixture();
    seedChannel(fixture, { id: 'chan-guildless', broadcasterUserId: CREATOR_A, guildId: null });
    const { app, redis, queues } = await buildTestApp(fixture.overrides);
    const discord = await loginAs(app, redis, { userId: '111111111111111111' });
    await redis.set(
      redisKey('oauthstate', 'integration', 'guild-state'),
      JSON.stringify({ guildId: GUILD_ID, provider: 'twitch', userId: '111111111111111111', kind: 'twitch_chat' }),
      'EX',
      600,
    );
    stubTwitchAs(CREATOR_A);

    const res = await app.inject({
      method: 'GET',
      url: '/integrations/twitch/callback?code=abc&state=guild-state',
      headers: { cookie: discord.cookieHeader },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `${env.DASHBOARD_URL}/dashboard/${GUILD_ID}/integrations?error=twitch-chat-already-linked`,
    );
    expect(fixture.channels.size).toBe(1);
    expect(fixture.channels.get('chan-guildless')!.guildId).toBeNull();
    expect(fixture.connections.size).toBe(0);
    expect(queues.calls).toHaveLength(0);
    await app.close();
  });
});

describe('GET /creator/twitch/channel', () => {
  it('reports no channel yet, plus whether the bot account is configured', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/channel', headers: t.read });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ botConfigured: false, botLogin: null, envConfigured: true, channel: null });
    await t.app.close();
  });

  it('returns the creator\'s own guildless channel, and marks a guild-linked one as discordLinked', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A, broadcasterLogin: 'me', status: 'CONNECTED' });
    seedChannel(t.fixture, { id: 'theirs', broadcasterUserId: CREATOR_B, guildId: GUILD_ID });
    t.fixture.botIdentities.set('bot', { id: 'bot', botLogin: 'pavisiebot' });

    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/channel', headers: t.read });
    const body = res.json();
    expect(body.botConfigured).toBe(true);
    expect(body.botLogin).toBe('pavisiebot');
    expect(body.channel).toMatchObject({
      id: 'mine',
      broadcasterLogin: 'me',
      broadcasterUserId: CREATOR_A,
      enabled: true,
      status: 'connected',
      commandPrefix: '!',
      discordLinked: false,
    });
    expect(JSON.stringify(body)).not.toContain(GUILD_ID);

    // The owner's existing guild-linked channel shows up in THEIR creator dashboard automatically.
    const b = await loginAsCreator(t.app, t.redis, { platformUserId: CREATOR_B });
    const resB = await t.app.inject({ method: 'GET', url: '/creator/twitch/channel', headers: { cookie: b.cookieHeader } });
    expect(resB.json().channel).toMatchObject({ id: 'theirs', discordLinked: true });
    expect(JSON.stringify(resB.json())).not.toContain(GUILD_ID); // the guild id itself is never exposed
    await t.app.close();
  });
});

describe('PATCH /creator/twitch/channel', () => {
  it('updates enabled and the command prefix, and nudges the bot', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A });
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/channel',
      headers: t.headers,
      payload: { enabled: false, commandPrefix: '?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, commandPrefix: '?' });
    expect(t.fixture.channels.get('mine')).toMatchObject({ enabled: false, commandPrefix: '?' });
    expect(t.queues.calls.some((c) => (c.data as { type: string }).type === 'twitchChat.reconcile')).toBe(true);
    await t.app.close();
  });

  it('rejects a bad prefix and fields a creator may not change (bridge, rewards)', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A });
    for (const payload of [
      { commandPrefix: '!!' },
      { commandPrefix: '/' },
      { bridgeDiscordToTwitch: true },
      { rewardsEnabled: true },
    ]) {
      const res = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/channel', headers: t.headers, payload });
      expect(res.statusCode).toBe(400);
    }
    await t.app.close();
  });

  it('404s when the creator has no channel (never touches anyone else\'s)', async () => {
    const t = await setup(CREATOR_A);
    seedChannel(t.fixture, { id: 'theirs', broadcasterUserId: CREATOR_B });
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/channel',
      headers: t.headers,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(t.fixture.channels.get('theirs')!.enabled).toBe(true);
    await t.app.close();
  });
});

describe('DELETE /creator/twitch/channel', () => {
  it('deletes a guildless channel', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A });
    const res = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/channel', headers: t.headers });
    expect(res.statusCode).toBe(204);
    expect(t.fixture.channels.size).toBe(0);
    expect(t.queues.calls.some((c) => (c.data as { type: string }).type === 'twitchChat.reconcile')).toBe(true);
    await t.app.close();
  });

  it('only DISABLES a guild-linked channel so the Discord side keeps its data', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A, guildId: GUILD_ID, status: 'CONNECTED' });
    seedCommand(t.fixture, { id: 'c1', channelId: 'mine', name: 'hello', guildId: GUILD_ID });
    const res = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/channel', headers: t.headers });
    expect(res.statusCode).toBe(204);
    expect(t.fixture.channels.get('mine')).toMatchObject({ guildId: GUILD_ID, enabled: false, status: 'DISCONNECTED' });
    expect(t.fixture.commands.size).toBe(1);
    await t.app.close();
  });

  it('404s when the creator has no channel, and needs the csrf token', async () => {
    const t = await setup(CREATOR_A);
    seedChannel(t.fixture, { id: 'theirs', broadcasterUserId: CREATOR_B });
    expect((await t.app.inject({ method: 'DELETE', url: '/creator/twitch/channel', headers: t.headers })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: '/creator/twitch/channel', headers: t.read })).statusCode).toBe(403);
    expect(t.fixture.channels.size).toBe(1);
    await t.app.close();
  });
});

describe('commands', () => {
  it('lists, creates (guildless: no guild id), updates and deletes the creator\'s own commands', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A });

    const empty = await t.app.inject({ method: 'GET', url: '/creator/twitch/channel/commands', headers: t.read });
    expect(empty.json()).toEqual([]);

    const created = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/channel/commands',
      headers: t.headers,
      payload: { name: 'Discord', response: 'join {user}', cooldownSeconds: 10, minLevel: 'moderator' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'discord', response: 'join {user}', cooldownSeconds: 10, minLevel: 'moderator' });
    const row = [...t.fixture.commands.values()][0];
    expect(row).toMatchObject({ channelId: 'mine', guildId: null, createdBy: CREATOR_A, minLevel: 'MODERATOR' });

    const id = created.json().id as string;
    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/creator/twitch/channel/commands/${id}`,
      headers: t.headers,
      payload: { enabled: false, response: 'new' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ enabled: false, response: 'new' });

    const list = await t.app.inject({ method: 'GET', url: '/creator/twitch/channel/commands', headers: t.read });
    expect(list.json()).toHaveLength(1);

    const del = await t.app.inject({ method: 'DELETE', url: `/creator/twitch/channel/commands/${id}`, headers: t.headers });
    expect(del.statusCode).toBe(204);
    expect(t.fixture.commands.size).toBe(0);
    await t.app.close();
  });

  it('a command created on a guild-linked channel carries that guild id (the Discord side sees it too)', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A, guildId: GUILD_ID });
    const res = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/channel/commands',
      headers: t.headers,
      payload: { name: 'hi', response: 'hello' },
    });
    expect(res.statusCode).toBe(201);
    expect([...t.fixture.commands.values()][0].guildId).toBe(GUILD_ID);
    await t.app.close();
  });

  it('rejects reserved names (built-ins AND the economy commands), duplicates, and bad input', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A });
    seedCommand(t.fixture, { id: 'c1', channelId: 'mine', name: 'taken' });

    for (const name of TWITCH_CHAT_RESERVED_COMMAND_NAMES) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/creator/twitch/channel/commands',
        headers: t.headers,
        payload: { name, response: 'x' },
      });
      expect(res.statusCode, name).toBe(400);
    }
    expect((TWITCH_CHAT_RESERVED_COMMAND_NAMES as readonly string[]).includes('balance')).toBe(true);

    const dup = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/channel/commands',
      headers: t.headers,
      payload: { name: 'taken', response: 'x' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('twitch_chat_command_exists');

    for (const payload of [{ name: 'has space', response: 'x' }, { name: 'ok', response: '' }, { name: 'ok' }]) {
      const res = await t.app.inject({ method: 'POST', url: '/creator/twitch/channel/commands', headers: t.headers, payload });
      expect(res.statusCode).toBe(400);
    }

    // Renaming onto a reserved name or an existing one is refused too.
    seedCommand(t.fixture, { id: 'c2', channelId: 'mine', name: 'other' });
    expect(
      (await t.app.inject({ method: 'PATCH', url: '/creator/twitch/channel/commands/c2', headers: t.headers, payload: { name: 'daily' } })).statusCode,
    ).toBe(400);
    expect(
      (await t.app.inject({ method: 'PATCH', url: '/creator/twitch/channel/commands/c2', headers: t.headers, payload: { name: 'taken' } })).statusCode,
    ).toBe(409);
    await t.app.close();
  });

  it('enforces the per-channel limit of 50', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A });
    for (let i = 0; i < 50; i++) seedCommand(t.fixture, { id: `c${i}`, channelId: 'mine', name: `cmd${i}` });
    const res = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/channel/commands',
      headers: t.headers,
      payload: { name: 'one_more', response: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('twitch_chat_command_limit');
    await t.app.close();
  });

  it('OWNERSHIP: another creator gets 404 for everything on a command that is not theirs', async () => {
    const t = await setup(CREATOR_B); // signed in as B
    seedChannel(t.fixture, { id: 'chan-a', broadcasterUserId: CREATOR_A });
    seedChannel(t.fixture, { id: 'chan-b', broadcasterUserId: CREATOR_B });
    seedCommand(t.fixture, { id: 'cmd-a', channelId: 'chan-a', name: 'secret' });

    const patch = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/channel/commands/cmd-a',
      headers: t.headers,
      payload: { response: 'hacked' },
    });
    const del = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/channel/commands/cmd-a', headers: t.headers });
    expect(patch.statusCode).toBe(404);
    expect(del.statusCode).toBe(404);
    expect(t.fixture.commands.get('cmd-a')).toMatchObject({ response: 'hi' });

    // B's own list never contains A's command.
    const list = await t.app.inject({ method: 'GET', url: '/creator/twitch/channel/commands', headers: t.read });
    expect(list.json()).toEqual([]);
    await t.app.close();
  });

  it('a creator with no channel gets 404 (not 403) on list and create', async () => {
    const t = await setup(CREATOR_A);
    seedChannel(t.fixture, { id: 'chan-b', broadcasterUserId: CREATOR_B });
    expect((await t.app.inject({ method: 'GET', url: '/creator/twitch/channel/commands', headers: t.read })).statusCode).toBe(404);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/creator/twitch/channel/commands',
          headers: t.headers,
          payload: { name: 'hi', response: 'x' },
        })
      ).statusCode,
    ).toBe(404);
    expect(t.fixture.commands.size).toBe(0);
    await t.app.close();
  });

  it('every mutation needs the creator csrf token', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A });
    seedCommand(t.fixture, { id: 'c1', channelId: 'mine', name: 'x' });
    const bad = { cookie: t.creator.cookieHeader };
    expect(
      (await t.app.inject({ method: 'POST', url: '/creator/twitch/channel/commands', headers: bad, payload: { name: 'a', response: 'b' } })).statusCode,
    ).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: '/creator/twitch/channel/commands/c1', headers: bad })).statusCode).toBe(403);
    expect(t.fixture.commands.size).toBe(1);
    await t.app.close();
  });
});

describe('timers', () => {
  it('lists, creates, updates and deletes the creator\'s own timers', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A });

    const created = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/channel/timers',
      headers: t.headers,
      payload: { name: 'socials', message: 'follow me', intervalMinutes: 15 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'socials', message: 'follow me', intervalMinutes: 15, enabled: true });
    expect([...t.fixture.timers.values()][0]).toMatchObject({ channelId: 'mine', guildId: null, createdBy: CREATOR_A });

    const id = created.json().id as string;
    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/creator/twitch/channel/timers/${id}`,
      headers: t.headers,
      payload: { intervalMinutes: 30, enabled: false },
    });
    expect(patched.json()).toMatchObject({ intervalMinutes: 30, enabled: false });

    expect((await t.app.inject({ method: 'GET', url: '/creator/twitch/channel/timers', headers: t.read })).json()).toHaveLength(1);
    expect((await t.app.inject({ method: 'DELETE', url: `/creator/twitch/channel/timers/${id}`, headers: t.headers })).statusCode).toBe(204);
    expect(t.fixture.timers.size).toBe(0);
    await t.app.close();
  });

  it('validates the interval, rejects duplicates, and enforces the per-channel limit of 10', async () => {
    const t = await setup();
    seedChannel(t.fixture, { id: 'mine', broadcasterUserId: CREATOR_A });
    seedTimer(t.fixture, { id: 't1', channelId: 'mine', name: 'dup' });

    const tooFast = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/channel/timers',
      headers: t.headers,
      payload: { name: 'fast', message: 'x', intervalMinutes: 1 },
    });
    expect(tooFast.statusCode).toBe(400);

    const dup = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/channel/timers',
      headers: t.headers,
      payload: { name: 'dup', message: 'x', intervalMinutes: 10 },
    });
    expect(dup.statusCode).toBe(409);

    for (let i = 2; i <= 10; i++) seedTimer(t.fixture, { id: `t${i}`, channelId: 'mine', name: `timer${i}` });
    const over = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/channel/timers',
      headers: t.headers,
      payload: { name: 'eleventh', message: 'x', intervalMinutes: 10 },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe('twitch_chat_timer_limit');
    await t.app.close();
  });

  it('OWNERSHIP: another creator gets 404 on a timer that is not theirs', async () => {
    const t = await setup(CREATOR_B);
    seedChannel(t.fixture, { id: 'chan-a', broadcasterUserId: CREATOR_A });
    seedChannel(t.fixture, { id: 'chan-b', broadcasterUserId: CREATOR_B });
    seedTimer(t.fixture, { id: 'timer-a', channelId: 'chan-a', name: 'secret' });

    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: '/creator/twitch/channel/timers/timer-a',
          headers: t.headers,
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: '/creator/twitch/channel/timers/timer-a', headers: t.headers })).statusCode).toBe(404);
    expect(t.fixture.timers.get('timer-a')).toMatchObject({ enabled: true });
    await t.app.close();
  });
});

describe('Discord dashboard routes never see guildless channels', () => {
  it('lists only the guild-linked channels, and cannot address a guildless row by id', async () => {
    const fixture = creatorFixture();
    seedChannel(fixture, { id: 'guildless', broadcasterUserId: CREATOR_A, guildId: null });
    seedChannel(fixture, { id: 'linked', broadcasterUserId: CREATOR_B, guildId: GUILD_ID });
    const { app, redis } = await buildTestApp({
      ...fixture.overrides,
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    });
    const { cookieHeader, session } = await loginAs(app, redis, { userId: '111111111111111111' });
    await seedUserGuilds(redis, '111111111111111111', [{ id: GUILD_ID, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().channels.map((c: { id: string }) => c.id)).toEqual(['linked']);

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/twitch-chat/channels/guildless`,
      headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken },
    });
    expect(del.statusCode).toBe(404);
    expect(fixture.channels.has('guildless')).toBe(true);
    await app.close();
  });
});
