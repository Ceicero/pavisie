import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret, env, redisKey } from '@pavisie/core';
import { buildTestApp, loginAs, loginAsCreator, seedUserGuilds } from './helpers/build-test-app';
import { creatorFixture, seedChannel, seedCommand, seedReward, seedTimer } from './helpers/creator-fakes';

// Creator dashboard phase 3 (ARCHITECTURE.md §19e): connecting an OPTIONAL Discord server from /creator. The Discord
// sign-in reuses the registered dashboard-login redirect URI (`/auth/discord/callback`) with its own state namespace
// and browser-binding cookie; the guild list is read once, the token discarded, and only a server from the
// candidate list stashed for THIS creator session can be linked.

const CREATOR_A = '840000000001';
const CREATOR_B = '840000000002';
const DISCORD_USER = '850000000000000001';
const G_OK = '860000000000000001'; // manage-server + bot present
const G_ADMIN = '860000000000000002'; // administrator + bot present
const G_OWNER = '860000000000000003'; // owner + bot present
const G_NO_PERM = '860000000000000004'; // bot present but the user can only chat there
const G_NO_BOT = '860000000000000005'; // user manages it but the bot is not a member
const G_OTHER = '860000000000000006';
const TEXT_CH = '870000000000000001';
const VOICE_CH = '870000000000000002';
const ANN_CH = '870000000000000003';
const WEB_BASE = (env.WEB_URL ?? env.DASHBOARD_URL) as string;

const ORIGINALS = {
  TWITCH_CLIENT_ID: env.TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET: env.TWITCH_CLIENT_SECRET,
  DISCORD_TOKEN: env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID: env.DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET: env.DISCORD_CLIENT_SECRET,
};

beforeEach(async () => {
  await new RedisMock().flushall(); // ioredis-mock shares one store process-wide; start each test clean
  env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
  env.DISCORD_TOKEN = 'test-bot-token';
});

afterEach(() => {
  Object.assign(env, ORIGINALS);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const USER_GUILDS = [
  { id: G_OK, name: 'Manage Server', icon: null, owner: false, permissions: '32' },
  { id: G_ADMIN, name: 'Admin Server', icon: 'abc', owner: false, permissions: '8' },
  { id: G_OWNER, name: 'Owned Server', icon: null, owner: true, permissions: '0' },
  { id: G_NO_PERM, name: 'Just A Member', icon: null, owner: false, permissions: '0' },
  { id: G_NO_BOT, name: 'No Bot Here', icon: null, owner: false, permissions: '32' },
];

const GUILD_CHANNELS = [
  { id: TEXT_CH, name: 'general', type: 0, position: 0, parent_id: null },
  { id: VOICE_CH, name: 'voice', type: 2, position: 1, parent_id: null },
  { id: ANN_CH, name: 'news', type: 5, position: 2, parent_id: null },
];

/** Stubs every Discord endpoint the feature touches and records what was called. */
function stubDiscord(opts: { guilds?: unknown[] } = {}) {
  const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, body: init?.body ? String(init.body) : undefined, auth: headers.Authorization });
      if (url === 'https://discord.com/api/v10/oauth2/token') {
        return jsonResponse({
          access_token: 'discord-access-token',
          refresh_token: 'discord-refresh-token',
          expires_in: 604800,
          token_type: 'Bearer',
          scope: 'identify guilds',
        });
      }
      if (url === 'https://discord.com/api/v10/oauth2/token/revoke') return new Response('{}', { status: 200 });
      if (url === 'https://discord.com/api/v10/users/@me') {
        return jsonResponse({ id: DISCORD_USER, username: 'streamer', global_name: 'Streamer', avatar: null });
      }
      if (url === 'https://discord.com/api/v10/users/@me/guilds') return jsonResponse(opts.guilds ?? USER_GUILDS);
      if (/^https:\/\/discord\.com\/api\/v10\/guilds\/\d+\/channels$/.test(url)) return jsonResponse(GUILD_CHANNELS);
      if (url.startsWith('https://discord.com/api/v10/webhooks/')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
  return calls;
}

function setCookiePair(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  return found ? found.split(';')[0] : null;
}

function setCookieNames(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  return list.map((c) => c.split('=')[0]);
}

/** An app with the Discord-side rows the flow reads (bot present in every guild but `G_NO_BOT`) + one creator. */
async function setup(creatorId = CREATOR_A) {
  const fixture = creatorFixture();
  for (const id of [G_OK, G_ADMIN, G_OWNER, G_NO_PERM, G_OTHER]) {
    fixture.guilds.set(id, { id, name: `Guild ${id.slice(-1)}`, iconHash: null, ownerId: 'x', botPresent: true });
  }
  fixture.guilds.set(G_NO_BOT, { id: G_NO_BOT, name: 'No Bot Here', iconHash: null, ownerId: 'x', botPresent: false });
  const t = await buildTestApp(fixture.overrides);
  const creator = await loginAsCreator(t.app, t.redis, { platformUserId: creatorId });
  const headers = { cookie: creator.cookieHeader, 'x-csrf-token': creator.session.csrfToken };
  return { ...t, fixture, creator, headers, read: { cookie: creator.cookieHeader } };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function ownChannel(t: Setup, extra: Record<string, unknown> = {}) {
  return seedChannel(t.fixture, { id: 'chan-a', broadcasterUserId: CREATOR_A, ...extra });
}

/** Runs the start of the flow and returns what a browser would hold, ready for the callback. */
async function startConnect(t: Setup) {
  const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/connect', headers: t.read });
  const location = res.headers.location as string;
  const state = new URL(location).searchParams.get('state')!;
  return { res, location, state, stateCookie: setCookiePair(res, 'creator_discord_state')! };
}

/** The callback as the browser makes it: the creator cookie plus (unless overridden) the binding cookie. */
async function callback(t: Setup, state: string, cookie: string | null, withCreator = true) {
  const cookies = [withCreator ? t.creator.cookieHeader : null, cookie].filter(Boolean).join('; ');
  return t.app.inject({
    method: 'GET',
    url: `/auth/discord/callback?code=the-code&state=${state}`,
    headers: cookies ? { cookie: cookies } : {},
  });
}

/** Full happy path up to the pick screen: returns once the candidate list is stashed. */
async function signIntoDiscord(t: Setup) {
  const { state, stateCookie } = await startConnect(t);
  const res = await callback(t, state, stateCookie);
  expect(res.statusCode).toBe(302);
  return res;
}

function link(t: Setup, guildId: string, headers: Record<string, string> = t.headers) {
  return t.app.inject({ method: 'POST', url: '/creator/twitch/discord/link', headers, payload: { guildId } });
}

describe('GET /creator/twitch/discord/connect — start', () => {
  it('needs a creator session (a Discord dashboard session is not one)', async () => {
    const t = await buildTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/connect' })).statusCode).toBe(401);
    const discord = await loginAs(t.app, t.redis, { userId: DISCORD_USER });
    const res = await t.app.inject({
      method: 'GET',
      url: '/creator/twitch/discord/connect',
      headers: { cookie: discord.cookieHeader },
    });
    expect(res.statusCode).toBe(401);
    await t.app.close();
  });

  it('redirects to Discord with the REUSED redirect URI, the login scopes only, and a browser-bound single-use state', async () => {
    const t = await setup();
    const { res, location, state } = await startConnect(t);

    expect(res.statusCode).toBe(302);
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe(env.DISCORD_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('identify guilds');
    expect(url.searchParams.get('prompt')).toBe('consent');

    // Its own namespace — never the dashboard login's — naming the creator, and bound to this browser.
    expect(JSON.parse((await t.redis.get(redisKey('creator-discord-state', state)))!)).toMatchObject({
      platformUserId: CREATOR_A,
    });
    expect(await t.redis.get(redisKey('oauthstate', state))).toBeNull();
    const cookie = res.cookies.find((c) => c.name === 'creator_discord_state')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    await t.app.close();
  });

  it('errors (no redirect, no stored state) when Discord OAuth is not configured', async () => {
    env.DISCORD_CLIENT_ID = undefined;
    const t = await setup();
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/connect', headers: t.read });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.headers.location).toBeUndefined();
    await t.app.close();
  });

  it('is rate limited (20/min)', async () => {
    const t = await setup();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/connect', headers: t.read })).statusCode;
    }
    expect(last).toBe(429);
    await t.app.close();
  });
});

describe('GET /auth/discord/callback — creator branch', () => {
  it('lists ONLY the servers the user manages (Manage Server / Administrator / owner) where the bot is present; stores no token and opens no Discord session', async () => {
    const t = await setup();
    const calls = stubDiscord();
    const { state, stateCookie } = await startConnect(t);
    const res = await callback(t, state, stateCookie);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB_BASE}/creator?discord=pick`);
    // The token is used for exactly two reads, then revoked (best-effort) — and no dashboard `sid` cookie is set.
    expect(calls.map((c) => c.url)).toEqual([
      'https://discord.com/api/v10/oauth2/token',
      'https://discord.com/api/v10/users/@me',
      'https://discord.com/api/v10/users/@me/guilds',
      'https://discord.com/api/v10/oauth2/token/revoke',
    ]);
    expect(calls[3].body).toContain('token=discord-access-token');
    expect(setCookieNames(res)).not.toContain('sid');
    expect(await t.redis.keys('*session*')).toHaveLength(1); // just the creator's own session
    // State is single use; token never persisted anywhere we can see.
    expect(await t.redis.get(redisKey('creator-discord-state', state))).toBeNull();
    const everything = JSON.stringify(await Promise.all((await t.redis.keys('*')).map((k) => t.redis.get(k))));
    expect(everything).not.toContain('discord-access-token');
    expect(everything).not.toContain('discord-refresh-token');

    const cands = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/candidates', headers: t.read });
    const body = cands.json() as { pending: boolean; candidates: { id: string; iconUrl: string | null }[] };
    expect(body.pending).toBe(true);
    expect(body.candidates.map((c) => c.id).sort()).toEqual([G_OK, G_ADMIN, G_OWNER].sort());
    expect(body.candidates.find((c) => c.id === G_ADMIN)!.iconUrl).toContain(`/icons/${G_ADMIN}/abc.png`);
    await t.app.close();
  });

  it('an honest empty list when the user manages no server where Pavisie is present', async () => {
    const t = await setup();
    stubDiscord({ guilds: [USER_GUILDS[3], USER_GUILDS[4]] });
    await signIntoDiscord(t);
    const cands = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/candidates', headers: t.read });
    expect(cands.json()).toEqual({ pending: true, candidates: [] });
    await t.app.close();
  });

  it('candidates before any sign-in: not pending, empty', async () => {
    const t = await setup();
    const cands = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/candidates', headers: t.read });
    expect(cands.json()).toEqual({ pending: false, candidates: [] });
    await t.app.close();
  });

  it('WRONG BROWSER (no / mismatched binding cookie): 400 and the state is NOT consumed', async () => {
    const t = await setup();
    const calls = stubDiscord();
    const { state, stateCookie } = await startConnect(t);

    expect((await callback(t, state, null)).statusCode).toBe(400);
    const forged = `creator_discord_state=${t.app.signCookie('some-other-state')}`;
    expect((await callback(t, state, forged)).statusCode).toBe(400);
    expect((await callback(t, state, 'creator_discord_state=not-a-real-signed-value')).statusCode).toBe(400);
    expect(calls).toHaveLength(0); // never reached Discord
    expect(await t.redis.get(redisKey('creator-discord-state', state))).not.toBeNull();

    // The genuine browser can still finish afterwards.
    stubDiscord();
    expect((await callback(t, state, stateCookie)).statusCode).toBe(302);
    await t.app.close();
  });

  it('no creator session: 401, nothing stashed, state not consumed', async () => {
    const t = await setup();
    const calls = stubDiscord();
    const { state, stateCookie } = await startConnect(t);
    const res = await callback(t, state, stateCookie, false);
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    expect(await t.redis.keys('creator-discord-candidates*')).toHaveLength(0);
    expect(await t.redis.get(redisKey('creator-discord-state', state))).not.toBeNull();
    await t.app.close();
  });

  it('a state issued to a DIFFERENT creator is refused (403) — one creator cannot hand out their URL', async () => {
    const t = await setup(CREATOR_A);
    const calls = stubDiscord();
    const { state, stateCookie } = await startConnect(t);
    const other = await loginAsCreator(t.app, t.redis, { platformUserId: CREATOR_B });
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/discord/callback?code=the-code&state=${state}`,
      headers: { cookie: `${other.cookieHeader}; ${stateCookie}` },
    });
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    await t.app.close();
  });

  it('an expired / already-used state gets a clear 400, not a dashboard-login error', async () => {
    const t = await setup();
    stubDiscord();
    const { state, stateCookie } = await startConnect(t);
    expect((await callback(t, state, stateCookie)).statusCode).toBe(302);
    const replay = await callback(t, state, stateCookie);
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain('expired or was already used');
    await t.app.close();
  });

  it('the Discord DASHBOARD login is unchanged: its own state/cookie still creates a `sid` session', async () => {
    const t = await buildTestApp();
    stubDiscord();
    const login = await t.app.inject({ method: 'GET', url: '/auth/discord/login' });
    const state = new URL(login.headers.location as string).searchParams.get('state')!;
    const cookie = setCookiePair(login, 'oauth_state')!;
    const res = await t.app.inject({
      method: 'GET',
      url: `/auth/discord/callback?code=the-code&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${env.DASHBOARD_URL}/dashboard`);
    expect(setCookieNames(res)).toContain('sid');
    await t.app.close();
  });
});

describe('POST /creator/twitch/discord/link', () => {
  it('links a candidate server: records who, mirrors child rows, audits in that server, and leaves the plugin settings of the server alone', async () => {
    const t = await setup();
    ownChannel(t);
    seedCommand(t.fixture, { id: 'c1', channelId: 'chan-a', name: 'hi' });
    seedTimer(t.fixture, { id: 't1', channelId: 'chan-a', name: 'tick' });
    seedReward(t.fixture, { id: 'r1', channelId: 'chan-a', rewardTitle: 'Air', action: 'CHAT', chatTemplate: 'x' });
    stubDiscord();
    await signIntoDiscord(t);

    const res = await link(t, G_OK);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      linked: true,
      verified: true,
      server: { id: G_OK, name: 'Guild 1' },
      integrationsEnabled: false, // linking does not switch the server's Integrations plugin on (phase 4)
    });

    expect(t.fixture.channels.get('chan-a')).toMatchObject({ guildId: G_OK, discordLinkedBy: DISCORD_USER });
    expect(t.fixture.channels.get('chan-a')!.discordLinkedAt).toBeInstanceOf(Date);
    expect(t.fixture.commands.get('c1')!.guildId).toBe(G_OK);
    expect(t.fixture.timers.get('t1')!.guildId).toBe(G_OK);
    expect(t.fixture.rewards.get('r1')!.guildId).toBe(G_OK);

    // Phase 4: the chat bot no longer depends on the server's Integrations plugin, so linking leaves it alone.
    expect(t.fixture.pluginStates.size).toBe(0);
    const audits = [...t.fixture.auditLogs.values()].filter((a) => a.guildId === G_OK).map((a) => a.action);
    expect(audits).not.toContain('plugin.enable');
    const linkAudit = [...t.fixture.auditLogs.values()].find((a) => a.action === 'integration.twitch_chat.discord.link')!;
    expect(linkAudit).toMatchObject({ guildId: G_OK, actorId: DISCORD_USER, targetId: 'chan-a' });
    expect(linkAudit.after).toEqual({ broadcasterLogin: expect.any(String), linkedFrom: 'creator-dashboard' });

    // One Discord sign-in proves one link: the stash is gone.
    const cands = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/candidates', headers: t.read });
    expect(cands.json()).toEqual({ pending: false, candidates: [] });
    await t.app.close();
  });

  it('leaves the Integrations plugin exactly as the server admin set it (on stays on, and the status reports it)', async () => {
    const t = await setup();
    ownChannel(t);
    t.fixture.pluginStates.set('ps-x', { id: 'ps-x', guildId: G_OK, pluginId: 'integrations', enabled: true });
    stubDiscord();
    await signIntoDiscord(t);
    const res = await link(t, G_OK);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ integrationsEnabled: true });
    expect(t.fixture.pluginStates.get('ps-x')).toMatchObject({ enabled: true });
    expect([...t.fixture.auditLogs.values()].map((a) => a.action)).not.toContain('plugin.enable');
    await t.app.close();
  });

  it('refuses a server that is NOT in the candidate list (never trusts the client): no manage permission, bot absent, unknown', async () => {
    const t = await setup();
    ownChannel(t);
    stubDiscord();
    await signIntoDiscord(t);
    for (const guildId of [G_NO_PERM, G_NO_BOT, G_OTHER, '860000000000009999']) {
      const res = await link(t, guildId);
      expect(res.statusCode, guildId).toBe(403);
    }
    expect(t.fixture.channels.get('chan-a')!.guildId).toBeNull();
    expect(t.fixture.pluginStates.size).toBe(0);
    await t.app.close();
  });

  it('409 when there was no Discord sign-in (or it expired)', async () => {
    const t = await setup();
    ownChannel(t);
    const res = await link(t, G_OK);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('discord_sign_in_required');
    await t.app.close();
  });

  it('the candidate list is bound to the creator SESSION: another creator (or a second session) cannot use it', async () => {
    const t = await setup(CREATOR_A);
    ownChannel(t);
    stubDiscord();
    await signIntoDiscord(t);

    const other = await loginAsCreator(t.app, t.redis, { platformUserId: CREATOR_B });
    seedChannel(t.fixture, { id: 'chan-b', broadcasterUserId: CREATOR_B });
    const res = await link(t, G_OK, { cookie: other.cookieHeader, 'x-csrf-token': other.session.csrfToken });
    expect(res.statusCode).toBe(409); // B holds no stash
    expect(t.fixture.channels.get('chan-b')!.guildId).toBeNull();
    await t.app.close();
  });

  it('404 when the bot has left the server since the sign-in', async () => {
    const t = await setup();
    ownChannel(t);
    stubDiscord();
    await signIntoDiscord(t);
    t.fixture.guilds.set(G_OK, { ...t.fixture.guilds.get(G_OK), botPresent: false });
    const res = await link(t, G_OK);
    expect(res.statusCode).toBe(404);
    expect(t.fixture.channels.get('chan-a')!.guildId).toBeNull();
    await t.app.close();
  });

  it('409 when the channel is already linked to a DIFFERENT server — disconnect first; nothing changes', async () => {
    const t = await setup();
    ownChannel(t, { guildId: G_OTHER, discordLinkedBy: DISCORD_USER });
    stubDiscord();
    await signIntoDiscord(t);
    const res = await link(t, G_OK);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('discord_already_linked');
    expect(t.fixture.channels.get('chan-a')!.guildId).toBe(G_OTHER);
    await t.app.close();
  });

  it('linking the SAME server again is idempotent, keeps the bridge, and upgrades an unverified link to a verified one', async () => {
    const t = await setup();
    ownChannel(t, { guildId: G_OK, bridgeDiscordChannelId: TEXT_CH, bridgeTwitchToDiscord: true });
    stubDiscord();
    await signIntoDiscord(t);
    expect((await link(t, G_OK)).statusCode).toBe(200);
    expect(t.fixture.channels.get('chan-a')).toMatchObject({
      guildId: G_OK,
      discordLinkedBy: DISCORD_USER,
      bridgeDiscordChannelId: TEXT_CH,
      bridgeTwitchToDiscord: true,
    });
    await t.app.close();
  });

  it('404 when the creator has not connected the bot to their chat yet (there is no channel row to link)', async () => {
    const t = await setup();
    stubDiscord();
    await signIntoDiscord(t);
    expect((await link(t, G_OK)).statusCode).toBe(404);
    expect(t.fixture.channels.size).toBe(0);
    await t.app.close();
  });

  it('needs the creator CSRF token, and a session, and a strict body', async () => {
    const t = await setup();
    ownChannel(t);
    stubDiscord();
    await signIntoDiscord(t);
    expect((await link(t, G_OK, { cookie: t.creator.cookieHeader })).statusCode).toBe(403);
    expect((await link(t, G_OK, { cookie: t.creator.cookieHeader, 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/creator/twitch/discord/link',
          headers: { 'x-csrf-token': t.creator.session.csrfToken },
          payload: { guildId: G_OK },
        })
      ).statusCode,
    ).toBe(401);
    const smuggled = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/discord/link',
      headers: t.headers,
      payload: { guildId: G_OK, discordUserId: '1' },
    });
    expect(smuggled.statusCode).toBe(400);
    expect(t.fixture.channels.get('chan-a')!.guildId).toBeNull();
    await t.app.close();
  });

  it('is rate limited (20/min)', async () => {
    const t = await setup();
    ownChannel(t);
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await link(t, G_OK)).statusCode;
    expect(last).toBe(429);
    await t.app.close();
  });

  it('logging out drops the held candidate list', async () => {
    const t = await setup();
    ownChannel(t);
    stubDiscord();
    await signIntoDiscord(t);
    expect(await t.redis.keys('*creator-discord-candidates*')).toHaveLength(1);
    await t.app.inject({ method: 'POST', url: '/creator/logout', headers: t.headers });
    expect(await t.redis.keys('*creator-discord-candidates*')).toHaveLength(0);
    await t.app.close();
  });
});

describe('GET /creator/twitch/discord — status', () => {
  it('no channel / not linked / linked-but-unverified (no server details) / verified (name + icon)', async () => {
    const t = await setup();
    const none = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord', headers: t.read });
    expect(none.json()).toMatchObject({ hasChannel: false, linked: false, verified: false, server: null });

    ownChannel(t);
    const unlinked = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord', headers: t.read });
    expect(unlinked.json()).toMatchObject({ hasChannel: true, linked: false, verified: false, server: null });

    t.fixture.channels.set('chan-a', { ...t.fixture.channels.get('chan-a'), guildId: G_OK });
    const unverified = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord', headers: t.read });
    expect(unverified.json()).toMatchObject({ linked: true, verified: false, server: null });
    expect(unverified.body).not.toContain(G_OK);

    t.fixture.channels.set('chan-a', {
      ...t.fixture.channels.get('chan-a'),
      discordLinkedBy: DISCORD_USER,
      discordLinkedAt: new Date('2026-09-29T00:00:00Z'),
    });
    const verified = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord', headers: t.read });
    expect(verified.json()).toMatchObject({
      linked: true,
      verified: true,
      server: { id: G_OK, name: 'Guild 1' },
      linkedAt: '2026-09-29T00:00:00.000Z',
      integrationsEnabled: false, // shown honestly: the bridge and Discord posts are paused while it is off
    });
    await t.app.close();
  });

  it('is per creator: another creator never sees this channel', async () => {
    const t = await setup(CREATOR_B);
    ownChannel(t, { guildId: G_OK, discordLinkedBy: DISCORD_USER }); // A's channel
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord', headers: t.read });
    expect(res.json()).toMatchObject({ hasChannel: false, linked: false, server: null });
    await t.app.close();
  });
});

/** A channel linked (and verified) to `G_OK` with a bridge, a webhook credential and one of each child row. */
function linkedChannel(t: Setup, extra: Record<string, unknown> = {}) {
  const row = ownChannel(t, {
    guildId: G_OK,
    discordLinkedBy: DISCORD_USER,
    discordLinkedAt: new Date(),
    bridgeDiscordChannelId: TEXT_CH,
    bridgeDiscordToTwitch: true,
    bridgeTwitchToDiscord: true,
    bridgeWebhookId: '880000000000000001',
    bridgeWebhookTokenEnc: encryptSecret('webhook-token'),
    bridgeLastError: 'x',
    ...extra,
  });
  seedCommand(t.fixture, { id: 'c1', channelId: 'chan-a', guildId: G_OK, name: 'hi' });
  seedTimer(t.fixture, { id: 't1', channelId: 'chan-a', guildId: G_OK, name: 'tick' });
  seedReward(t.fixture, { id: 'r-sound', channelId: 'chan-a', guildId: G_OK, rewardTitle: 'Air', action: 'SOUND', soundUrl: 'https://cdn.example.com/a.mp3' });
  seedReward(t.fixture, {
    id: 'r-disc',
    channelId: 'chan-a',
    guildId: G_OK,
    rewardTitle: 'Post',
    action: 'DISCORD',
    discordChannelId: TEXT_CH,
    discordTemplate: 'x',
  });
  return row;
}

describe('DELETE /creator/twitch/discord/link — unlink', () => {
  it('clears the link and the bridge, deletes the webhook (best-effort), removes DISCORD rewards, keeps everything else, audits in the server', async () => {
    const t = await setup();
    linkedChannel(t);
    const calls = stubDiscord();

    const res = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/discord/link', headers: t.headers });
    expect(res.statusCode).toBe(204);

    expect(t.fixture.channels.get('chan-a')).toMatchObject({
      guildId: null,
      discordLinkedBy: null,
      discordLinkedAt: null,
      bridgeDiscordChannelId: null,
      bridgeDiscordToTwitch: false,
      bridgeTwitchToDiscord: false,
      bridgeWebhookId: null,
      bridgeWebhookTokenEnc: null,
      bridgeLastError: null,
    });
    expect(calls.some((c) => c.method === 'DELETE' && c.url === 'https://discord.com/api/v10/webhooks/880000000000000001/webhook-token')).toBe(true);
    expect(t.fixture.rewards.has('r-disc')).toBe(false); // a guildless channel never holds a Discord-post reward
    expect(t.fixture.rewards.get('r-sound')).toMatchObject({ guildId: null });
    expect(t.fixture.commands.get('c1')!.guildId).toBeNull();
    expect(t.fixture.timers.get('t1')!.guildId).toBeNull();

    const audit = [...t.fixture.auditLogs.values()].find((a) => a.action === 'integration.twitch_chat.discord.unlink')!;
    expect(audit).toMatchObject({ guildId: G_OK, actorId: `twitch:${CREATOR_A}` });
    expect(audit.after).toMatchObject({ unlinkedBy: 'twitch', deletedDiscordRewards: 1 });
    await t.app.close();
  });

  it('still succeeds when Discord refuses the webhook delete', async () => {
    const t = await setup();
    linkedChannel(t);
    stubDiscord();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('discord down'); }));
    const res = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/discord/link', headers: t.headers });
    expect(res.statusCode).toBe(204);
    expect(t.fixture.channels.get('chan-a')!.guildId).toBeNull();
    await t.app.close();
  });

  it('works for a link a Discord admin made from the Discord dashboard (it is the creator\'s own channel)', async () => {
    const t = await setup();
    ownChannel(t, { guildId: G_OK });
    const res = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/discord/link', headers: t.headers });
    expect(res.statusCode).toBe(204);
    expect(t.fixture.channels.get('chan-a')!.guildId).toBeNull();
    await t.app.close();
  });

  it('404 when nothing is linked / no channel; 403 without the CSRF token; another creator cannot unlink', async () => {
    const t = await setup();
    expect((await t.app.inject({ method: 'DELETE', url: '/creator/twitch/discord/link', headers: t.headers })).statusCode).toBe(404);
    ownChannel(t);
    expect((await t.app.inject({ method: 'DELETE', url: '/creator/twitch/discord/link', headers: t.headers })).statusCode).toBe(404);
    t.fixture.channels.set('chan-a', { ...t.fixture.channels.get('chan-a'), guildId: G_OK, discordLinkedBy: DISCORD_USER });
    expect((await t.app.inject({ method: 'DELETE', url: '/creator/twitch/discord/link', headers: t.read })).statusCode).toBe(403);

    const other = await loginAsCreator(t.app, t.redis, { platformUserId: CREATOR_B });
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/creator/twitch/discord/link',
      headers: { cookie: other.cookieHeader, 'x-csrf-token': other.session.csrfToken },
    });
    expect(res.statusCode).toBe(404);
    expect(t.fixture.channels.get('chan-a')!.guildId).toBe(G_OK);
    await t.app.close();
  });

});

// Creator dashboard phase 4: the Discord dashboard keeps only a read-only "which channel is linked" notice and the
// server admin's right to unlink THEIR server (never to delete the streamer's channel).
describe('Discord dashboard: linked-channel notice and unlink (/guilds/:guildId/integrations/twitch-chat)', () => {
  const NOTICE = `/guilds/${G_OK}/integrations/twitch-chat`;

  async function asAdmin(
    t: Setup,
    opts: { userId?: string; guilds?: { id: string; owner: boolean; permissions: string }[] } = {},
  ) {
    const userId = opts.userId ?? DISCORD_USER;
    const admin = await loginAs(t.app, t.redis, { userId });
    await seedUserGuilds(t.redis, userId, opts.guilds ?? [{ id: G_OK, owner: false, permissions: '32' }]);
    return { cookie: admin.cookieHeader, csrf: admin.session.csrfToken };
  }

  describe('GET (read-only notice)', () => {
    it('401 without a Discord session (a creator session does not count); 403 without manage access to the guild', async () => {
      const t = await setup();
      linkedChannel(t);
      expect((await t.app.inject({ method: 'GET', url: NOTICE })).statusCode).toBe(401);
      expect((await t.app.inject({ method: 'GET', url: NOTICE, headers: t.read })).statusCode).toBe(401);
      const member = await asAdmin(t, {
        userId: '850000000000000009',
        guilds: [{ id: G_OK, owner: false, permissions: '0' }],
      });
      expect((await t.app.inject({ method: 'GET', url: NOTICE, headers: { cookie: member.cookie } })).statusCode).toBe(403);
      await t.app.close();
    });

    it('is empty when no Twitch channel is linked to this server', async () => {
      const t = await setup();
      ownChannel(t); // guildless: not this server's
      const admin = await asAdmin(t);
      const res = await t.app.inject({ method: 'GET', url: NOTICE, headers: { cookie: admin.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ channels: [] });
      await t.app.close();
    });

    it('lists only the channels of THIS server, with just login and link/bot status: never ids, tokens, bridge or overlay fields', async () => {
      const t = await setup();
      linkedChannel(t, {
        overlayTokenEnc: encryptSecret('overlay-secret'),
        ttsOpenAiKeyEnc: encryptSecret('sk-secret'),
        broadcasterLogin: 'linkedstreamer',
      });
      seedChannel(t.fixture, {
        id: 'chan-other',
        broadcasterUserId: CREATOR_B,
        guildId: G_OTHER,
        broadcasterLogin: 'elsewhere',
      });
      const admin = await asAdmin(t);
      const res = await t.app.inject({ method: 'GET', url: NOTICE, headers: { cookie: admin.cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.channels).toHaveLength(1);
      expect(body.channels[0]).toEqual({
        id: 'chan-a',
        broadcasterLogin: 'linkedstreamer',
        linkedByStreamer: true,
        linkedAt: expect.any(String),
        enabled: true,
        status: expect.stringMatching(/^(connected|disconnected|error|pending)$/),
      });
      for (const secret of ['overlay-secret', 'sk-secret', CREATOR_A, DISCORD_USER, 'elsewhere', 'bridge', 'webhook', 'Enc']) {
        expect(res.body).not.toContain(secret);
      }
      await t.app.close();
    });
  });

  describe('DELETE .../channels/:channelId (unlink this server)', () => {
    const del = (t: Setup, channelId: string, headers: Record<string, string>, guildId = G_OK) =>
      t.app.inject({
        method: 'DELETE',
        url: `/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}`,
        headers,
      });

    it('401 without a session; 403 without manage access; 403 without or with a wrong CSRF token or origin; nothing changes', async () => {
      const t = await setup();
      linkedChannel(t);
      stubDiscord();
      expect((await del(t, 'chan-a', {})).statusCode).toBe(401);

      const member = await asAdmin(t, {
        userId: '850000000000000009',
        guilds: [{ id: G_OK, owner: false, permissions: '0' }],
      });
      expect((await del(t, 'chan-a', { cookie: member.cookie, 'x-csrf-token': member.csrf })).statusCode).toBe(403);

      const admin = await asAdmin(t);
      expect((await del(t, 'chan-a', { cookie: admin.cookie })).statusCode).toBe(403); // no CSRF token
      expect((await del(t, 'chan-a', { cookie: admin.cookie, 'x-csrf-token': 'not-the-token' })).statusCode).toBe(403);
      // The creator's CSRF token is not the Discord session's, so it does not satisfy this route either.
      expect(
        (await del(t, 'chan-a', { cookie: admin.cookie, 'x-csrf-token': t.creator.session.csrfToken })).statusCode,
      ).toBe(403);
      // A cross-site Origin is refused even with the right token.
      expect(
        (await del(t, 'chan-a', { cookie: admin.cookie, 'x-csrf-token': admin.csrf, origin: 'https://evil.example' }))
          .statusCode,
      ).toBe(403);

      expect(t.fixture.channels.get('chan-a')).toMatchObject({ guildId: G_OK, discordLinkedBy: DISCORD_USER });
      expect(t.fixture.auditLogs.size).toBe(0);
      await t.app.close();
    });

    it('404 for a channel of another server or a guildless one (never touched); manage access elsewhere does not reach it', async () => {
      const t = await setup();
      linkedChannel(t);
      seedChannel(t.fixture, { id: 'chan-other', broadcasterUserId: CREATOR_B, guildId: G_OTHER });
      seedChannel(t.fixture, { id: 'chan-free', broadcasterUserId: '840000000003' });
      stubDiscord();
      const admin = await asAdmin(t);
      const headers = { cookie: admin.cookie, 'x-csrf-token': admin.csrf };
      expect((await del(t, 'chan-other', headers)).statusCode).toBe(404);
      expect((await del(t, 'chan-free', headers)).statusCode).toBe(404);
      expect((await del(t, 'no-such-channel', headers)).statusCode).toBe(404);
      expect(t.fixture.channels.get('chan-other')!.guildId).toBe(G_OTHER);

      const otherAdmin = await asAdmin(t, {
        userId: '850000000000000010',
        guilds: [{ id: G_OTHER, owner: false, permissions: '32' }],
      });
      expect((await del(t, 'chan-a', { cookie: otherAdmin.cookie, 'x-csrf-token': otherAdmin.csrf })).statusCode).toBe(403);
      expect(t.fixture.channels.get('chan-a')!.guildId).toBe(G_OK);
      await t.app.close();
    });

    it('unlinks exactly like the creator-side disconnect: the streamer keeps the channel; bridge and Discord rewards go; the audit names the Discord admin', async () => {
      const t = await setup();
      linkedChannel(t);
      const calls = stubDiscord();
      const admin = await asAdmin(t);

      const res = await del(t, 'chan-a', { cookie: admin.cookie, 'x-csrf-token': admin.csrf });
      expect(res.statusCode).toBe(204);

      expect(t.fixture.channels.get('chan-a')).toMatchObject({
        guildId: null,
        discordLinkedBy: null,
        discordLinkedAt: null,
        bridgeDiscordChannelId: null,
        bridgeDiscordToTwitch: false,
        bridgeTwitchToDiscord: false,
        bridgeWebhookId: null,
        bridgeWebhookTokenEnc: null,
      });
      expect(calls.some((c) => c.method === 'DELETE' && c.url.startsWith('https://discord.com/api/v10/webhooks/'))).toBe(
        true,
      );
      expect(t.fixture.rewards.has('r-disc')).toBe(false);
      expect(t.fixture.rewards.get('r-sound')).toMatchObject({ guildId: null });
      expect(t.fixture.commands.get('c1')!.guildId).toBeNull();
      expect(t.fixture.timers.get('t1')!.guildId).toBeNull();

      const audit = [...t.fixture.auditLogs.values()].find((a) => a.action === 'integration.twitch_chat.discord.unlink')!;
      expect(audit).toMatchObject({ guildId: G_OK, actorId: DISCORD_USER, targetId: 'chan-a' });
      expect(audit.after).toMatchObject({ unlinkedBy: 'discord', deletedDiscordRewards: 1 });

      // A second unlink has nothing left to disconnect from this server.
      expect((await del(t, 'chan-a', { cookie: admin.cookie, 'x-csrf-token': admin.csrf })).statusCode).toBe(404);
      await t.app.close();
    });

    it('also unlinks a link a server admin made earlier from the Discord dashboard: it no longer DELETES the channel', async () => {
      const t = await setup();
      ownChannel(t, { guildId: G_OK }); // discordLinkedBy null: the old, admin-made link
      seedCommand(t.fixture, { id: 'c1', channelId: 'chan-a', name: 'hi', guildId: G_OK });
      const admin = await asAdmin(t);
      const res = await del(t, 'chan-a', { cookie: admin.cookie, 'x-csrf-token': admin.csrf });
      expect(res.statusCode).toBe(204);
      expect(t.fixture.channels.get('chan-a')).toMatchObject({ guildId: null, discordLinkedBy: null });
      expect(t.fixture.commands.get('c1')!.guildId).toBeNull();
      expect([...t.fixture.auditLogs.values()].map((a) => a.action)).toContain('integration.twitch_chat.discord.unlink');
      await t.app.close();
    });

    it('nudges the bot to reconcile', async () => {
      const t = await setup();
      linkedChannel(t);
      stubDiscord();
      const admin = await asAdmin(t);
      await del(t, 'chan-a', { cookie: admin.cookie, 'x-csrf-token': admin.csrf });
      expect(
        t.queues.calls.some(
          (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile',
        ),
      ).toBe(true);
      await t.app.close();
    });
  });

  describe('the removed guild-side chat routes are gone', () => {
    it.each([
      ['POST', `/guilds/${G_OK}/integrations/twitch-chat/connect`],
      ['PATCH', `/guilds/${G_OK}/integrations/twitch-chat/channels/chan-a`],
      ['GET', `/guilds/${G_OK}/integrations/twitch-chat/channels/chan-a/commands`],
      ['GET', `/guilds/${G_OK}/integrations/twitch-chat/channels/chan-a/timers`],
      ['GET', `/guilds/${G_OK}/integrations/twitch-chat/channels/chan-a/rewards`],
      ['GET', `/guilds/${G_OK}/integrations/twitch-chat/channels/chan-a/overlay`],
      ['POST', `/guilds/${G_OK}/integrations/twitch-chat/channels/chan-a/overlay/regenerate`],
    ])('%s %s is a 404', async (method, url) => {
      const t = await setup();
      linkedChannel(t);
      const admin = await asAdmin(t);
      const res = await t.app.inject({
        method: method as 'GET',
        url,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      // 404 for a path that no longer exists; the one exception is `POST .../connect`, which the still-generic
      // `/:guildId/integrations/:provider/connect` route rejects (400) because `twitch-chat` is not a provider.
      expect([400, 404]).toContain(res.statusCode);
      expect(res.json().url).toBeUndefined();
      await t.app.close();
    });
  });
});

describe('bridge + channel picker on the creator dashboard', () => {
  function verified(t: Setup, extra: Record<string, unknown> = {}) {
    return ownChannel(t, { guildId: G_OK, discordLinkedBy: DISCORD_USER, ...extra });
  }
  const patch = (t: Setup, payload: unknown, headers: Record<string, string> = t.headers) =>
    t.app.inject({ method: 'PATCH', url: '/creator/twitch/discord/bridge', headers, payload: payload as object });

  it('GET/PATCH default to everything off and need a channel, a linked server and a VERIFIED link', async () => {
    const t = await setup();
    for (const method of ['GET', 'PATCH'] as const) {
      const res = await t.app.inject({ method, url: '/creator/twitch/discord/bridge', headers: t.headers, payload: method === 'PATCH' ? {} : undefined });
      expect(res.statusCode).toBe(404); // no channel
    }
    ownChannel(t);
    expect((await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/bridge', headers: t.read })).statusCode).toBe(404); // not linked
    t.fixture.channels.set('chan-a', { ...t.fixture.channels.get('chan-a'), guildId: G_OK });
    const unverified = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/bridge', headers: t.read });
    expect(unverified.statusCode).toBe(409);
    expect(unverified.json().error.code).toBe('discord_link_unverified');
    expect((await patch(t, { discordToTwitch: true })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/channels', headers: t.read })).statusCode).toBe(409);

    t.fixture.channels.set('chan-a', { ...t.fixture.channels.get('chan-a'), discordLinkedBy: DISCORD_USER });
    const ok = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/bridge', headers: t.read });
    expect(ok.json()).toEqual({ discordChannelId: null, discordToTwitch: false, twitchToDiscord: false, lastError: null });
    await t.app.close();
  });

  it('lists the linked server\'s channels (and only that server\'s — no guild id is accepted)', async () => {
    const t = await setup();
    verified(t);
    const calls = stubDiscord();
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/channels?guildId=' + G_OTHER, headers: t.read });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string }[]).map((c) => c.id)).toEqual([TEXT_CH, VOICE_CH, ANN_CH]);
    expect(calls.every((c) => c.url.includes(`/guilds/${G_OK}/`))).toBe(true);
    await t.app.close();
  });

  it('sets the channel and both directions (same rules as the Discord dashboard) and audits it in the server', async () => {
    const t = await setup();
    verified(t);
    stubDiscord();
    const res = await patch(t, { discordChannelId: TEXT_CH, discordToTwitch: true, twitchToDiscord: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ discordChannelId: TEXT_CH, discordToTwitch: true, twitchToDiscord: true, lastError: null });
    expect(t.fixture.channels.get('chan-a')).toMatchObject({ bridgeDiscordChannelId: TEXT_CH, bridgeDiscordToTwitch: true });
    const audit = [...t.fixture.auditLogs.values()].find((a) => a.action === 'integration.twitch_chat.discord.bridge.update')!;
    expect(audit).toMatchObject({ guildId: G_OK, actorId: `twitch:${CREATOR_A}` });
    // An announcement channel is a text channel too.
    expect((await patch(t, { discordChannelId: ANN_CH })).statusCode).toBe(200);
    await t.app.close();
  });

  it('rejects: a channel not in the server, a non-text channel, a direction with no channel, a malformed id, unknown keys', async () => {
    const t = await setup();
    verified(t);
    stubDiscord();
    expect((await patch(t, { discordChannelId: '870000000000009999' })).statusCode).toBe(400);
    expect((await patch(t, { discordChannelId: VOICE_CH })).statusCode).toBe(400);
    expect((await patch(t, { discordToTwitch: true })).statusCode).toBe(400);
    expect((await patch(t, { twitchToDiscord: true })).statusCode).toBe(400);
    expect((await patch(t, { discordChannelId: 'not-a-snowflake' })).statusCode).toBe(400);
    expect((await patch(t, { guildId: G_OTHER })).statusCode).toBe(400);
    expect((await patch(t, { enabled: false })).statusCode).toBe(400);
    expect(t.fixture.channels.get('chan-a')!.bridgeDiscordChannelId).toBeNull();
    await t.app.close();
  });

  it('changing the bridge channel deletes the old webhook and clears its credential; an empty patch changes nothing', async () => {
    const t = await setup();
    verified(t, {
      bridgeDiscordChannelId: TEXT_CH,
      bridgeTwitchToDiscord: true,
      bridgeWebhookId: '880000000000000001',
      bridgeWebhookTokenEnc: encryptSecret('webhook-token'),
    });
    const calls = stubDiscord();
    expect((await patch(t, {})).statusCode).toBe(200);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    expect((await patch(t, { discordChannelId: ANN_CH })).statusCode).toBe(200);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/webhook-token'))).toBe(true);
    expect(t.fixture.channels.get('chan-a')).toMatchObject({
      bridgeDiscordChannelId: ANN_CH,
      bridgeWebhookId: null,
      bridgeWebhookTokenEnc: null,
    });
    // Clearing the channel while a direction is still on is refused; turning it off first works.
    expect((await patch(t, { discordChannelId: null })).statusCode).toBe(400);
    expect((await patch(t, { discordChannelId: null, twitchToDiscord: false })).statusCode).toBe(200);
    await t.app.close();
  });

  it('needs a creator session and the creator CSRF token; another creator\'s bridge is unreachable', async () => {
    const t = await setup();
    verified(t);
    stubDiscord();
    expect((await patch(t, { discordChannelId: TEXT_CH }, { cookie: t.creator.cookieHeader })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/creator/twitch/discord/bridge' })).statusCode).toBe(401);
    // The Discord dashboard session cannot stand in.
    const discord = await loginAs(t.app, t.redis, { userId: DISCORD_USER });
    const viaDiscord = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/discord/bridge',
      headers: { cookie: discord.cookieHeader, 'x-csrf-token': discord.session.csrfToken },
      payload: { discordChannelId: TEXT_CH },
    });
    expect(viaDiscord.statusCode).toBe(401);

    const other = await loginAsCreator(t.app, t.redis, { platformUserId: CREATOR_B });
    const res = await patch(t, { discordChannelId: TEXT_CH }, { cookie: other.cookieHeader, 'x-csrf-token': other.session.csrfToken });
    expect(res.statusCode).toBe(404);
    expect(t.fixture.channels.get('chan-a')!.bridgeDiscordChannelId).toBeNull();
    await t.app.close();
  });
});

describe('DISCORD reward action on the creator dashboard', () => {
  const create = (t: Setup, payload: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/items', headers: t.headers, payload });
  const DISCORD_REWARD = { rewardTitle: 'Post it', action: 'discord', discordChannelId: TEXT_CH, discordTemplate: '{user} redeemed {reward}' };

  it('is offered once a server is connected: created with the server\'s guild id, into a real text channel', async () => {
    const t = await setup();
    ownChannel(t, { guildId: G_OK, discordLinkedBy: DISCORD_USER });
    stubDiscord();
    const res = await create(t, DISCORD_REWARD);
    expect(res.statusCode).toBe(201);
    expect([...t.fixture.rewards.values()][0]).toMatchObject({ action: 'DISCORD', guildId: G_OK, discordChannelId: TEXT_CH });
    const status = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards', headers: t.read });
    expect(status.json()).toMatchObject({ discordLinked: true, discordVerified: true });
    await t.app.close();
  });

  it('validates the target like the bridge: not in the server (400), voice channel (400)', async () => {
    const t = await setup();
    ownChannel(t, { guildId: G_OK, discordLinkedBy: DISCORD_USER });
    stubDiscord();
    expect((await create(t, { ...DISCORD_REWARD, discordChannelId: '870000000000009999' })).statusCode).toBe(400);
    expect((await create(t, { ...DISCORD_REWARD, discordChannelId: VOICE_CH })).statusCode).toBe(400);
    expect(t.fixture.rewards.size).toBe(0);
    await t.app.close();
  });

  it('is refused without a verified connection (guildless, or a link made from a server\'s dashboard)', async () => {
    for (const extra of [{}, { guildId: G_OK }]) {
      const t = await setup();
      ownChannel(t, extra);
      stubDiscord();
      expect((await create(t, DISCORD_REWARD)).statusCode, JSON.stringify(extra)).toBe(400);
      expect(t.fixture.rewards.size).toBe(0);
      await t.app.close();
    }
  });

  it('Discord fields on a non-Discord action stay refused, on create AND on update', async () => {
    const t = await setup();
    ownChannel(t, { guildId: G_OK, discordLinkedBy: DISCORD_USER });
    stubDiscord();
    const sound = { rewardTitle: 'Air', action: 'sound', soundUrl: 'https://cdn.example.com/a.mp3' };
    expect((await create(t, { ...sound, discordChannelId: TEXT_CH })).statusCode).toBe(400);
    seedReward(t.fixture, { id: 'r1', channelId: 'chan-a', rewardTitle: 'Air', action: 'SOUND', soundUrl: 'https://cdn.example.com/a.mp3' });
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/rewards/items/r1',
      headers: t.headers,
      payload: { discordChannelId: TEXT_CH },
    });
    expect(res.statusCode).toBe(400);
    await t.app.close();
  });

  it('an existing Discord reward is editable and removable with a verified connection', async () => {
    const t = await setup();
    ownChannel(t, { guildId: G_OK, discordLinkedBy: DISCORD_USER });
    stubDiscord();
    seedReward(t.fixture, { id: 'r-d', channelId: 'chan-a', guildId: G_OK, rewardTitle: 'Post', action: 'DISCORD', discordChannelId: TEXT_CH, discordTemplate: 'x' });
    const edit = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/rewards/items/r-d',
      headers: t.headers,
      payload: { discordChannelId: ANN_CH, discordTemplate: 'new' },
    });
    expect(edit.statusCode).toBe(200);
    expect(t.fixture.rewards.get('r-d')).toMatchObject({ discordChannelId: ANN_CH, discordTemplate: 'new' });
    const bad = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/rewards/items/r-d',
      headers: t.headers,
      payload: { discordChannelId: '870000000000009999' },
    });
    expect(bad.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'DELETE', url: '/creator/twitch/rewards/items/r-d', headers: t.headers })).statusCode).toBe(204);
    await t.app.close();
  });
});
