import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret, encryptSecret, env, redisKey } from '@pavisie/core';
import { buildTestApp, loginAs, loginAsCreator } from './helpers/build-test-app';
import {
  creatorFixture,
  seedBroadcasterToken,
  seedChannel,
  seedReward,
} from './helpers/creator-fakes';

// Creator dashboard phase 2b (ARCHITECTURE.md §19b / §19e): channel-point rewards, the OBS overlay URL and the
// bring-your-own-key TTS setting for a signed-in Twitch creator's OWN channel, with or without a Discord server.

const CREATOR_A = '830000000001';
const CREATOR_B = '830000000002';
const GUILD_ID = '830000000000000001';
const WEB_BASE = (env.WEB_URL ?? env.DASHBOARD_URL) as string;

const ORIGINAL_TWITCH_CLIENT_ID = env.TWITCH_CLIENT_ID;
const ORIGINAL_TWITCH_CLIENT_SECRET = env.TWITCH_CLIENT_SECRET;

const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Stubs Twitch so the account that "authorizes" is `twitchUserId`, granting `scopes`; returns the revoke spy. */
function stubTwitchAs(twitchUserId: string, scopes: string[] = ['channel:bot', 'channel:read:redemptions']) {
  const revoked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
        return jsonResponse({
          access_token: 'broadcaster-access-token',
          refresh_token: 'broadcaster-refresh-token',
          expires_in: 14400,
          token_type: 'bearer',
          scope: scopes,
        });
      }
      if (url.startsWith('https://api.twitch.tv/helix/users')) {
        return jsonResponse({ data: [{ id: twitchUserId, login: `login${twitchUserId}`, display_name: 'X' }] });
      }
      if (url.startsWith('https://id.twitch.tv/oauth2/revoke')) {
        revoked.push(String(init?.body ?? ''));
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
  return { revoked };
}

/** An app + one signed-in creator; mutating requests carry the creator's csrf token via `headers`. */
async function setup(creatorId = CREATOR_A) {
  const fixture = creatorFixture();
  const t = await buildTestApp(fixture.overrides);
  const creator = await loginAsCreator(t.app, t.redis, { platformUserId: creatorId });
  const headers = { cookie: creator.cookieHeader, 'x-csrf-token': creator.session.csrfToken };
  return { ...t, fixture, creator, headers, read: { cookie: creator.cookieHeader } };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function ownChannel(t: Setup, extra: Record<string, unknown> = {}) {
  return seedChannel(t.fixture, { id: 'chan-a', broadcasterUserId: CREATOR_A, ...extra });
}

/** A channel with a usable broadcaster token, as after a successful "enable channel points". */
function authorizedChannel(t: Setup, extra: Record<string, unknown> = {}) {
  const channel = ownChannel(t, extra);
  seedBroadcasterToken(t.fixture, { id: 'btok-a', channelId: channel.id });
  return channel;
}

const SOUND = { rewardTitle: 'Air horn', action: 'sound', soundUrl: 'https://1.1.1.1/horn.mp3', volume: 60 };

// ---------------------------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------------------------

describe('every /creator/twitch/rewards route: 401 without a creator session', () => {
  const routes: { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: unknown }[] = [
    { method: 'GET', url: '/creator/twitch/rewards' },
    { method: 'PATCH', url: '/creator/twitch/rewards', payload: { rewardsEnabled: false } },
    { method: 'POST', url: '/creator/twitch/rewards/authorize' },
    { method: 'DELETE', url: '/creator/twitch/rewards/authorize' },
    { method: 'GET', url: '/creator/twitch/rewards/items' },
    { method: 'POST', url: '/creator/twitch/rewards/items', payload: SOUND },
    { method: 'PATCH', url: '/creator/twitch/rewards/items/x', payload: { enabled: false } },
    { method: 'DELETE', url: '/creator/twitch/rewards/items/x' },
    { method: 'GET', url: '/creator/twitch/rewards/overlay' },
    { method: 'POST', url: '/creator/twitch/rewards/overlay/regenerate' },
    { method: 'PUT', url: '/creator/twitch/rewards/tts-key', payload: { apiKey: OPENAI_KEY } },
    { method: 'DELETE', url: '/creator/twitch/rewards/tts-key' },
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

describe('every mutating /creator/twitch/rewards route needs the creator CSRF token', () => {
  const routes: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: unknown }[] = [
    { method: 'PATCH', url: '/creator/twitch/rewards', payload: { rewardsEnabled: false } },
    { method: 'POST', url: '/creator/twitch/rewards/authorize' },
    { method: 'DELETE', url: '/creator/twitch/rewards/authorize' },
    { method: 'POST', url: '/creator/twitch/rewards/items', payload: SOUND },
    { method: 'PATCH', url: '/creator/twitch/rewards/items/x', payload: { enabled: false } },
    { method: 'DELETE', url: '/creator/twitch/rewards/items/x' },
    { method: 'POST', url: '/creator/twitch/rewards/overlay/regenerate' },
    { method: 'PUT', url: '/creator/twitch/rewards/tts-key', payload: { apiKey: OPENAI_KEY } },
    { method: 'DELETE', url: '/creator/twitch/rewards/tts-key' },
  ];

  for (const r of routes) {
    it(`${r.method} ${r.url} -> 403 with only the session cookie`, async () => {
      const t = await setup();
      ownChannel(t);
      const res = await t.app.inject({ method: r.method, url: r.url, payload: r.payload as object | undefined, headers: t.read });
      expect(res.statusCode).toBe(403);
      await t.app.close();
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Status + master switch
// ---------------------------------------------------------------------------------------------------------------

describe('GET /creator/twitch/rewards', () => {
  it('with no channel yet: an honest "nothing set up" status (and writes nothing)', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards', headers: t.read });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      channelExists: false,
      channelEnabled: false,
      rewardsEnabled: false,
      authorized: false,
      authorizationError: null,
      hasOverlay: false,
      ttsKeyConfigured: false,
      discordLinked: false,
      discordVerified: false,
      maxRewards: 25,
    });
    expect(t.fixture.channels.size).toBe(0);
    await t.app.close();
  });

  it('reports authorization / overlay / key state for the creator\'s own channel — and only as flags, never the secrets', async () => {
    const t = await setup();
    ownChannel(t, {
      rewardsEnabled: true,
      overlayTokenEnc: encryptSecret('overlay-secret-token'),
      ttsOpenAiKeyEnc: encryptSecret(OPENAI_KEY),
      guildId: GUILD_ID,
    });
    seedBroadcasterToken(t.fixture, { id: 'btok-a', channelId: 'chan-a', accessTokenEnc: 'enc-access-SECRET' });

    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards', headers: t.read });
    expect(res.json()).toMatchObject({
      channelExists: true,
      channelEnabled: true,
      rewardsEnabled: true,
      authorized: true,
      authorizationError: null,
      hasOverlay: true,
      ttsKeyConfigured: true,
      discordLinked: true,
      discordVerified: false, // linked from a server's dashboard, not verified from here
    });
    for (const secret of ['overlay-secret-token', OPENAI_KEY, 'enc-access-SECRET', 'ttsOpenAiKeyEnc', 'overlayTokenEnc']) {
      expect(res.body).not.toContain(secret);
    }
    await t.app.close();
  });

  it('an ERROR token (revoked/expired grant) is not "authorized" and surfaces why', async () => {
    const t = await setup();
    ownChannel(t, { rewardsEnabled: true });
    seedBroadcasterToken(t.fixture, {
      id: 'btok-a',
      channelId: 'chan-a',
      status: 'ERROR',
      lastError: 'Twitch broadcaster token refresh failed (status 400).',
    });
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards', headers: t.read });
    expect(res.json()).toMatchObject({
      authorized: false,
      authorizationError: 'Twitch broadcaster token refresh failed (status 400).',
    });
    await t.app.close();
  });

  it("never reveals another creator's channel: B sees only B's own state", async () => {
    const t = await setup(CREATOR_B);
    seedChannel(t.fixture, {
      id: 'chan-a',
      broadcasterUserId: CREATOR_A,
      rewardsEnabled: true,
      ttsOpenAiKeyEnc: encryptSecret(OPENAI_KEY),
    });
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards', headers: t.read });
    expect(res.json()).toMatchObject({ channelExists: false, rewardsEnabled: false, ttsKeyConfigured: false });
    await t.app.close();
  });
});

describe('PATCH /creator/twitch/rewards (master switch)', () => {
  it('refuses to turn rewards ON before channel points are authorized (409)', async () => {
    const t = await setup();
    ownChannel(t);
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/rewards',
      headers: t.headers,
      payload: { rewardsEnabled: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('channel_points_not_authorized');
    expect(t.fixture.channels.get('chan-a')!.rewardsEnabled).toBe(false);
    await t.app.close();
  });

  it('refuses to turn rewards ON with a dead (ERROR) authorization', async () => {
    const t = await setup();
    ownChannel(t);
    seedBroadcasterToken(t.fixture, { id: 'btok-a', channelId: 'chan-a', status: 'ERROR', lastError: 'dead' });
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/rewards',
      headers: t.headers,
      payload: { rewardsEnabled: true },
    });
    expect(res.statusCode).toBe(409);
    await t.app.close();
  });

  it('turns rewards on with a working authorization, nudges the bot, and can switch them off again', async () => {
    const t = await setup();
    authorizedChannel(t);

    const on = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/rewards', headers: t.headers, payload: { rewardsEnabled: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ rewardsEnabled: true });
    expect(t.fixture.channels.get('chan-a')!.rewardsEnabled).toBe(true);
    expect(
      t.queues.calls.some((c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile'),
    ).toBe(true);

    const off = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/rewards', headers: t.headers, payload: { rewardsEnabled: false } });
    expect(off.json()).toEqual({ rewardsEnabled: false });
    expect(t.fixture.channels.get('chan-a')!.rewardsEnabled).toBe(false);
    await t.app.close();
  });

  it('is strict: unknown keys (e.g. the Discord bridge fields, or another channel id) are a 400', async () => {
    const t = await setup();
    authorizedChannel(t);
    for (const payload of [
      { rewardsEnabled: true, bridgeDiscordToTwitch: true },
      { rewardsEnabled: true, channelId: 'chan-other' },
      {},
    ]) {
      const res = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/rewards', headers: t.headers, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    await t.app.close();
  });

  it('404 when the creator has no channel at all', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/rewards', headers: t.headers, payload: { rewardsEnabled: false } });
    expect(res.statusCode).toBe(404);
    await t.app.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Authorize (enable channel points) — start, callback, disconnect
// ---------------------------------------------------------------------------------------------------------------

describe('POST /creator/twitch/rewards/authorize', () => {
  it('returns the channel:bot + channel:read:redemptions authorize URL (reused redirect URI) tied to this creator', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/authorize', headers: t.headers });
    expect(res.statusCode).toBe(200);

    const url = new URL(res.json().url);
    expect(`${url.origin}${url.pathname}`).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(url.searchParams.get('scope')).toBe('channel:bot channel:read:redemptions');
    expect(url.searchParams.get('redirect_uri')).toBe(`${env.API_BASE_URL}/integrations/twitch/callback`);

    const state = url.searchParams.get('state')!;
    expect(JSON.parse((await t.redis.get(redisKey('creator-connect-state', state)))!)).toEqual({
      platform: 'twitch',
      platformUserId: CREATOR_A,
      purpose: 'channel-points',
    });
    // Not a guild-flow state.
    expect(await t.redis.get(redisKey('oauthstate', 'integration', state))).toBeNull();
    await t.app.close();
  });
});

describe('GET /integrations/twitch/callback — creator "enable channel points"', () => {
  async function startAuthorize(t: Setup): Promise<string> {
    const res = await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/authorize', headers: t.headers });
    return new URL(res.json().url).searchParams.get('state')!;
  }
  const callback = (t: Setup, state: string, headers: Record<string, string> = t.read) =>
    t.app.inject({ method: 'GET', url: `/integrations/twitch/callback?code=abc&state=${state}`, headers });

  it('a creator with NO channel yet: creates a GUILDLESS channel and keeps the broadcaster token, encrypted, keyed to it', async () => {
    const t = await setup();
    const state = await startAuthorize(t);
    const { revoked } = stubTwitchAs(CREATOR_A);

    const res = await callback(t, state); // creator cookie only — NO Discord session
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB_BASE}/creator?connected=channel-points`);

    expect(t.fixture.channels.size).toBe(1);
    const channel = [...t.fixture.channels.values()][0];
    expect(channel).toMatchObject({ broadcasterUserId: CREATOR_A, guildId: null, connectionId: null, createdBy: CREATOR_A });
    // No guild-scoped rows at all.
    expect(t.fixture.connections.size).toBe(0);
    expect(t.fixture.oauthTokens.size).toBe(0);

    expect(t.fixture.broadcasterTokens.size).toBe(1);
    const token = [...t.fixture.broadcasterTokens.values()][0];
    expect(token.channelId).toBe(channel.id);
    expect(token.accessTokenEnc).not.toBe('broadcaster-access-token');
    expect(decryptSecret(token.accessTokenEnc)).toBe('broadcaster-access-token');
    expect(decryptSecret(token.refreshTokenEnc)).toBe('broadcaster-refresh-token');
    expect(token.scopes).toEqual(['channel:bot', 'channel:read:redemptions']);
    expect(token.expiresAt).toBeInstanceOf(Date);
    expect(token.status).toBe('CONNECTED');

    // The kept token must NOT be revoked (that would kill the grant we just stored).
    expect(revoked).toEqual([]);
    // Rewards stay OFF until the creator flips the switch.
    expect(channel.rewardsEnabled).toBe(false);
    expect(await t.redis.get(redisKey('creator-connect-state', state))).toBeNull(); // single-use
    expect(
      t.queues.calls.some((c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'twitchChat.reconcile'),
    ).toBe(true);
    await t.app.close();
  });

  it("an EXISTING guild-linked row keeps its guild, settings AND its enabled/status (a bot the creator turned off stays off)", async () => {
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
    const state = await startAuthorize(t);
    stubTwitchAs(CREATOR_A);

    const res = await callback(t, state);
    expect(res.statusCode).toBe(302);
    expect(t.fixture.channels.size).toBe(1);
    expect(t.fixture.channels.get('chan-linked')).toMatchObject({
      guildId: GUILD_ID,
      connectionId: 'conn-guild',
      commandPrefix: '?',
      enabled: false,
      status: 'DISCONNECTED',
    });
    expect([...t.fixture.broadcasterTokens.values()][0].channelId).toBe('chan-linked');
    await t.app.close();
  });

  it('re-authorizing REPLACES the stored token (fresh secrets, ERROR cleared) — still one row per channel', async () => {
    const t = await setup();
    ownChannel(t);
    seedBroadcasterToken(t.fixture, {
      id: 'btok-old',
      channelId: 'chan-a',
      accessTokenEnc: encryptSecret('OLD'),
      refreshTokenEnc: encryptSecret('OLD-REFRESH'),
      status: 'ERROR',
      lastError: 'dead',
    });
    const state = await startAuthorize(t);
    stubTwitchAs(CREATOR_A);

    await callback(t, state);
    expect(t.fixture.broadcasterTokens.size).toBe(1);
    const token = [...t.fixture.broadcasterTokens.values()][0];
    expect(decryptSecret(token.accessTokenEnc)).toBe('broadcaster-access-token');
    expect(token).toMatchObject({ status: 'CONNECTED', lastError: null });
    await t.app.close();
  });

  it('REJECTS a different Twitch account than the signed-in creator: writes nothing (no channel, no token), revokes that token', async () => {
    const t = await setup(CREATOR_A);
    const state = await startAuthorize(t);
    const { revoked } = stubTwitchAs(CREATOR_B); // someone else's Twitch account authorized

    const res = await callback(t, state);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB_BASE}/creator?error=twitch-account-mismatch`);
    expect(t.fixture.channels.size).toBe(0);
    expect(t.fixture.broadcasterTokens.size).toBe(0);
    expect(revoked).toHaveLength(1); // the wrong account's token does not linger
    expect(await t.redis.get(redisKey('creator-connect-state', state))).toBeNull(); // consumed
    await t.app.close();
  });

  it('a mismatch never touches an existing token of the signed-in creator', async () => {
    const t = await setup(CREATOR_A);
    authorizedChannel(t);
    const before = { ...t.fixture.broadcasterTokens.get('btok-a')! };
    const state = await startAuthorize(t);
    stubTwitchAs(CREATOR_B);

    await callback(t, state);
    expect(t.fixture.broadcasterTokens.get('btok-a')).toEqual(before);
    await t.app.close();
  });

  it('a grant WITHOUT channel:read:redemptions stores nothing, revokes the token and redirects with an error', async () => {
    const t = await setup();
    const state = await startAuthorize(t);
    const { revoked } = stubTwitchAs(CREATOR_A, ['channel:bot']);

    const res = await callback(t, state);
    expect(res.headers.location).toBe(`${WEB_BASE}/creator?error=channel-points-scope-missing`);
    expect(t.fixture.channels.size).toBe(0);
    expect(t.fixture.broadcasterTokens.size).toBe(0);
    expect(revoked).toHaveLength(1);
    await t.app.close();
  });

  it('requires the creator session (401) and does not consume the state without it', async () => {
    const t = await setup();
    const state = await startAuthorize(t);
    stubTwitchAs(CREATOR_A);

    const res = await t.app.inject({ method: 'GET', url: `/integrations/twitch/callback?code=abc&state=${state}` });
    expect(res.statusCode).toBe(401);
    expect(await t.redis.get(redisKey('creator-connect-state', state))).not.toBeNull();
    expect(t.fixture.broadcasterTokens.size).toBe(0);
    await t.app.close();
  });

  it('refuses a state that was issued to a different creator (403), even with a valid creator session', async () => {
    const t = await setup(CREATOR_A);
    const state = await startAuthorize(t);
    const other = await loginAsCreator(t.app, t.redis, { platformUserId: CREATOR_B });
    stubTwitchAs(CREATOR_B);

    const res = await callback(t, state, { cookie: other.cookieHeader });
    expect(res.statusCode).toBe(403);
    expect(t.fixture.channels.size).toBe(0);
    expect(t.fixture.broadcasterTokens.size).toBe(0);
    await t.app.close();
  });

  it('a plain chat-bot connect (purpose chat) still discards the token even if Twitch granted more', async () => {
    const t = await setup();
    const res0 = await t.app.inject({ method: 'POST', url: '/creator/twitch/channel/connect', headers: t.headers });
    const state = new URL(res0.json().url).searchParams.get('state')!;
    const { revoked } = stubTwitchAs(CREATOR_A);

    const res = await callback(t, state);
    expect(res.headers.location).toBe(`${WEB_BASE}/creator?connected=twitch-chat`);
    expect(t.fixture.broadcasterTokens.size).toBe(0);
    expect(revoked).toHaveLength(1);
    await t.app.close();
  });

  it('a connect state stored BEFORE channel points existed (no purpose field) is treated as a plain chat connect', async () => {
    const t = await setup();
    const state = 'legacy-state';
    await t.redis.set(
      redisKey('creator-connect-state', state),
      JSON.stringify({ platform: 'twitch', platformUserId: CREATOR_A }),
      'EX',
      600,
    );
    stubTwitchAs(CREATOR_A);

    const res = await callback(t, state);
    expect(res.headers.location).toBe(`${WEB_BASE}/creator?connected=twitch-chat`);
    expect(t.fixture.broadcasterTokens.size).toBe(0);
    await t.app.close();
  });
});

describe('DELETE /creator/twitch/rewards/authorize (disconnect channel points)', () => {
  it('forgets the token, switches rewards off, and leaves rewards/overlay/TTS key in place', async () => {
    const t = await setup();
    authorizedChannel(t, { rewardsEnabled: true, overlayTokenEnc: encryptSecret('tok'), ttsOpenAiKeyEnc: encryptSecret(OPENAI_KEY) });
    seedReward(t.fixture, { id: 'rw1', channelId: 'chan-a', rewardTitle: 'Air horn', action: 'SOUND', soundUrl: 'https://cdn.example.com/a.mp3' });

    const res = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/rewards/authorize', headers: t.headers });
    expect(res.statusCode).toBe(204);
    expect(t.fixture.broadcasterTokens.size).toBe(0);
    expect(t.fixture.channels.get('chan-a')).toMatchObject({ rewardsEnabled: false });
    expect(t.fixture.channels.get('chan-a')!.overlayTokenEnc).not.toBeNull();
    expect(t.fixture.channels.get('chan-a')!.ttsOpenAiKeyEnc).not.toBeNull();
    expect(t.fixture.rewards.size).toBe(1);
    await t.app.close();
  });

  it("only ever removes the caller's own channel's token", async () => {
    const t = await setup(CREATOR_A);
    authorizedChannel(t);
    seedChannel(t.fixture, { id: 'chan-b', broadcasterUserId: CREATOR_B, rewardsEnabled: true });
    seedBroadcasterToken(t.fixture, { id: 'btok-b', channelId: 'chan-b' });

    await t.app.inject({ method: 'DELETE', url: '/creator/twitch/rewards/authorize', headers: t.headers });
    expect([...t.fixture.broadcasterTokens.keys()]).toEqual(['btok-b']);
    expect(t.fixture.channels.get('chan-b')!.rewardsEnabled).toBe(true);
    await t.app.close();
  });

  it('404 with no channel', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/rewards/authorize', headers: t.headers });
    expect(res.statusCode).toBe(404);
    await t.app.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Rewards CRUD
// ---------------------------------------------------------------------------------------------------------------

describe('rewards CRUD', () => {
  it('creates SOUND / TTS / CHAT rewards on a GUILDLESS channel (guildId stays null) and lists them', async () => {
    const t = await setup();
    ownChannel(t);

    const sound = await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/items', headers: t.headers, payload: SOUND });
    expect(sound.statusCode).toBe(201);
    expect(sound.json()).toMatchObject({ rewardTitle: 'Air horn', action: 'sound', soundUrl: SOUND.soundUrl, volume: 60, enabled: true });

    const tts = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/rewards/items',
      headers: t.headers,
      payload: { rewardTitle: 'Say it', action: 'tts', ttsTemplate: '{user} says {input}', cooldownSeconds: 30 },
    });
    expect(tts.statusCode).toBe(201);
    expect(tts.json()).toMatchObject({ action: 'tts', ttsTemplate: '{user} says {input}', cooldownSeconds: 30 });

    const chat = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/rewards/items',
      headers: t.headers,
      payload: { rewardTitle: 'Hydrate', action: 'chat', chatTemplate: 'Thanks {user}!' },
    });
    expect(chat.statusCode).toBe(201);

    for (const row of t.fixture.rewards.values()) {
      expect(row).toMatchObject({ channelId: 'chan-a', guildId: null, createdBy: CREATOR_A });
      expect(row.discordChannelId).toBeNull();
    }

    const list = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards/items', headers: t.read });
    expect(list.json().map((r: { rewardTitle: string }) => r.rewardTitle)).toEqual(['Air horn', 'Say it', 'Hydrate']);
    await t.app.close();
  });

  it("on a channel linked to a Discord server, the reward carries that server's id (so the Discord dashboard still sees it)", async () => {
    const t = await setup();
    ownChannel(t, { guildId: GUILD_ID });
    await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/items', headers: t.headers, payload: SOUND });
    expect([...t.fixture.rewards.values()][0].guildId).toBe(GUILD_ID);
    await t.app.close();
  });

  it('rejects a sound URL that resolves to a private/internal address (SSRF guard), on create and on update', async () => {
    const t = await setup();
    ownChannel(t);
    const create = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/rewards/items',
      headers: t.headers,
      payload: { rewardTitle: 'Steal', action: 'sound', soundUrl: 'https://169.254.169.254/latest/meta-data' },
    });
    expect(create.statusCode).toBe(400);
    expect(t.fixture.rewards.size).toBe(0);

    seedReward(t.fixture, { id: 'rw1', channelId: 'chan-a', rewardTitle: 'Air horn', action: 'SOUND', soundUrl: 'https://cdn.example.com/a.mp3' });
    const update = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/rewards/items/rw1',
      headers: t.headers,
      payload: { soundUrl: 'https://127.0.0.1/x.mp3' },
    });
    expect(update.statusCode).toBe(400);
    expect(t.fixture.rewards.get('rw1')!.soundUrl).toBe('https://cdn.example.com/a.mp3');
    await t.app.close();
  });

  it('rejects a non-https sound URL and a missing required field (same schema as the Discord dashboard)', async () => {
    const t = await setup();
    ownChannel(t);
    const http = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/rewards/items',
      headers: t.headers,
      payload: { rewardTitle: 'X', action: 'sound', soundUrl: 'http://cdn.example.com/a.mp3' },
    });
    expect(http.statusCode).toBe(400);
    const missing = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/rewards/items',
      headers: t.headers,
      payload: { rewardTitle: 'X', action: 'tts' },
    });
    expect(missing.statusCode).toBe(400);
    await t.app.close();
  });

  it('does NOT offer the DISCORD action to a creator without a VERIFIED Discord connection (guildless, or linked from another server dashboard) — however it is sent', async () => {
    for (const extra of [{}, { guildId: GUILD_ID }]) {
      const t = await setup();
      ownChannel(t, extra);
      const res = await t.app.inject({
        method: 'POST',
        url: '/creator/twitch/rewards/items',
        headers: t.headers,
        payload: {
          rewardTitle: 'To Discord',
          action: 'discord',
          discordChannelId: '123456789012345678',
          discordTemplate: '{user} redeemed',
        },
      });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.body).toContain('Connect a Discord server');
      expect(t.fixture.rewards.size).toBe(0);

      // Discord fields smuggled onto another action are refused too.
      const smuggled = await t.app.inject({
        method: 'POST',
        url: '/creator/twitch/rewards/items',
        headers: t.headers,
        payload: { ...SOUND, discordChannelId: '123456789012345678' },
      });
      expect(smuggled.statusCode).toBe(400);
      await t.app.close();
    }
  });

  it('409 on a duplicate (title, action), and 400 at the per-channel limit', async () => {
    const t = await setup();
    ownChannel(t);
    await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/items', headers: t.headers, payload: SOUND });
    const dup = await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/items', headers: t.headers, payload: SOUND });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('twitch_chat_reward_exists');

    for (let i = t.fixture.rewards.size; i < 25; i++) {
      seedReward(t.fixture, { id: `rw-fill-${i}`, channelId: 'chan-a', rewardTitle: `Fill ${i}`, action: 'CHAT', chatTemplate: 'x' });
    }
    const over = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/rewards/items',
      headers: t.headers,
      payload: { rewardTitle: 'One too many', action: 'chat', chatTemplate: 'x' },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe('twitch_chat_reward_limit');
    await t.app.close();
  });

  it('PATCH toggles / edits, validates the RESULTING state, and clears the old action\'s fields when the action changes', async () => {
    const t = await setup();
    ownChannel(t);
    seedReward(t.fixture, { id: 'rw1', channelId: 'chan-a', rewardTitle: 'Air horn', action: 'SOUND', soundUrl: 'https://cdn.example.com/a.mp3' });

    const off = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/rewards/items/rw1', headers: t.headers, payload: { enabled: false, volume: 20 } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, volume: 20 });

    // Switching to TTS without a template would save a silent reward: refused.
    const bad = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/rewards/items/rw1', headers: t.headers, payload: { action: 'tts' } });
    expect(bad.statusCode).toBe(400);

    const ok = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/rewards/items/rw1',
      headers: t.headers,
      payload: { action: 'tts', ttsTemplate: 'hello {user}' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ action: 'tts', ttsTemplate: 'hello {user}', soundUrl: null });
    await t.app.close();
  });

  it("someone else's reward (or a made-up id) is a 404 on PATCH and DELETE — never a 403 — and is left untouched", async () => {
    const t = await setup(CREATOR_A);
    ownChannel(t);
    seedChannel(t.fixture, { id: 'chan-b', broadcasterUserId: CREATOR_B });
    seedReward(t.fixture, { id: 'rw-b', channelId: 'chan-b', rewardTitle: 'Theirs', action: 'CHAT', chatTemplate: 'x' });

    for (const id of ['rw-b', 'does-not-exist']) {
      const patch = await t.app.inject({ method: 'PATCH', url: `/creator/twitch/rewards/items/${id}`, headers: t.headers, payload: { enabled: false } });
      expect(patch.statusCode).toBe(404);
      const del = await t.app.inject({ method: 'DELETE', url: `/creator/twitch/rewards/items/${id}`, headers: t.headers });
      expect(del.statusCode).toBe(404);
    }
    expect(t.fixture.rewards.get('rw-b')).toMatchObject({ enabled: true, rewardTitle: 'Theirs' });
    await t.app.close();
  });

  it('the list only ever contains the caller\'s own channel\'s rewards', async () => {
    const t = await setup(CREATOR_A);
    ownChannel(t);
    seedChannel(t.fixture, { id: 'chan-b', broadcasterUserId: CREATOR_B });
    seedReward(t.fixture, { id: 'rw-a', channelId: 'chan-a', rewardTitle: 'Mine', action: 'CHAT', chatTemplate: 'x' });
    seedReward(t.fixture, { id: 'rw-b', channelId: 'chan-b', rewardTitle: 'Theirs', action: 'CHAT', chatTemplate: 'x' });

    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards/items', headers: t.read });
    expect(res.json().map((r: { rewardTitle: string }) => r.rewardTitle)).toEqual(['Mine']);
    await t.app.close();
  });

  it('DELETE removes an own reward (204)', async () => {
    const t = await setup();
    ownChannel(t);
    seedReward(t.fixture, { id: 'rw1', channelId: 'chan-a', rewardTitle: 'Air horn', action: 'SOUND', soundUrl: 'https://cdn.example.com/a.mp3' });
    const res = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/rewards/items/rw1', headers: t.headers });
    expect(res.statusCode).toBe(204);
    expect(t.fixture.rewards.size).toBe(0);
    await t.app.close();
  });

  it('an EXISTING Discord-post reward on a Discord-linked channel is visible, but not editable or removable from here', async () => {
    const t = await setup();
    ownChannel(t, { guildId: GUILD_ID });
    seedReward(t.fixture, {
      id: 'rw-d',
      channelId: 'chan-a',
      guildId: GUILD_ID,
      rewardTitle: 'To Discord',
      action: 'DISCORD',
      discordChannelId: '123456789012345678',
      discordTemplate: 'x',
    });

    const list = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards/items', headers: t.read });
    expect(list.json()).toHaveLength(1);
    const patch = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/rewards/items/rw-d', headers: t.headers, payload: { enabled: false } });
    expect(patch.statusCode).toBe(400);
    const del = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/rewards/items/rw-d', headers: t.headers });
    expect(del.statusCode).toBe(400);
    expect(t.fixture.rewards.get('rw-d')).toMatchObject({ enabled: true });
    await t.app.close();
  });

  it('404 on every rewards route when the creator has no channel', async () => {
    const t = await setup();
    expect((await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards/items', headers: t.read })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/items', headers: t.headers, payload: SOUND })).statusCode).toBe(404);
    await t.app.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Overlay URL
// ---------------------------------------------------------------------------------------------------------------

describe('overlay URL', () => {
  it('GET before one exists: no URL, hasToken false; it never auto-creates one', async () => {
    const t = await setup();
    ownChannel(t);
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards/overlay', headers: t.read });
    expect(res.json()).toEqual({ url: null, hasToken: false });
    expect(t.fixture.channels.get('chan-a')!.overlayTokenEnc).toBeNull();
    await t.app.close();
  });

  it('regenerate creates it (stored ENCRYPTED, Redis index written), and GET then shows the same URL to the owner, uncached', async () => {
    const t = await setup();
    ownChannel(t);

    const created = await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/overlay/regenerate', headers: t.headers });
    expect(created.statusCode).toBe(200);
    const { url, hasToken } = created.json() as { url: string; hasToken: boolean };
    expect(hasToken).toBe(true);
    expect(url).toMatch(new RegExp(`^${env.API_BASE_URL}/overlay/[0-9a-f]{48}$`));
    expect(created.headers['cache-control']).toBe('no-store');

    const token = url.split('/overlay/')[1]!;
    const stored = t.fixture.channels.get('chan-a')!.overlayTokenEnc as string;
    expect(stored).not.toContain(token); // encrypted at rest
    expect(decryptSecret(stored)).toBe(token);
    expect(await t.redis.get(redisKey('overlay', 'token', token))).toBe('chan-a');

    const shown = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards/overlay', headers: t.read });
    expect(shown.json()).toEqual({ url, hasToken: true });
    expect(shown.headers['cache-control']).toBe('no-store');

    // ...and the URL really works as the OBS browser source; the status endpoint only exposes the flag.
    expect((await t.app.inject({ method: 'GET', url: `/overlay/${token}` })).statusCode).toBe(200);
    const status = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards', headers: t.read });
    expect(status.body).not.toContain(token);
    await t.app.close();
  });

  it('reset ROTATES it: the old URL stops working at once, the new one works', async () => {
    const t = await setup();
    ownChannel(t);
    const first = (await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/overlay/regenerate', headers: t.headers })).json().url as string;
    const second = (await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/overlay/regenerate', headers: t.headers })).json().url as string;
    expect(second).not.toBe(first);

    const oldToken = first.split('/overlay/')[1]!;
    const newToken = second.split('/overlay/')[1]!;
    expect(await t.redis.get(redisKey('overlay', 'token', oldToken))).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: `/overlay/${oldToken}` })).statusCode).toBe(410);
    expect((await t.app.inject({ method: 'GET', url: `/overlay/${newToken}` })).statusCode).toBe(200);
    await t.app.close();
  });

  it("is owner-only by construction: B can neither see nor rotate A's overlay, and rotating B's own leaves A's working", async () => {
    const t = await setup(CREATOR_B);
    seedChannel(t.fixture, { id: 'chan-a', broadcasterUserId: CREATOR_A, overlayTokenEnc: encryptSecret('a-secret-token') });
    await t.redis.set(redisKey('overlay', 'token', 'a-secret-token'), 'chan-a');

    // B has no channel yet: 404, and A's URL is nowhere in the response.
    const noChannel = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards/overlay', headers: t.read });
    expect(noChannel.statusCode).toBe(404);
    expect(noChannel.body).not.toContain('a-secret-token');
    expect((await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/overlay/regenerate', headers: t.headers })).statusCode).toBe(404);

    // Once B has their own channel they only ever see/rotate their own.
    seedChannel(t.fixture, { id: 'chan-b', broadcasterUserId: CREATOR_B });
    const own = await t.app.inject({ method: 'POST', url: '/creator/twitch/rewards/overlay/regenerate', headers: t.headers });
    expect(own.body).not.toContain('a-secret-token');
    expect(decryptSecret(t.fixture.channels.get('chan-a')!.overlayTokenEnc)).toBe('a-secret-token');
    expect(await t.redis.get(redisKey('overlay', 'token', 'a-secret-token'))).toBe('chan-a');
    await t.app.close();
  });

  it('an overlay token that no longer decrypts shows hasToken with no URL — the owner just resets it', async () => {
    const t = await setup();
    ownChannel(t, { overlayTokenEnc: 'not-a-valid-ciphertext' });
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards/overlay', headers: t.read });
    expect(res.json()).toEqual({ url: null, hasToken: true });
    await t.app.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// TTS key (bring-your-own, write-only)
// ---------------------------------------------------------------------------------------------------------------

describe('TTS OpenAI key (write-only)', () => {
  it('PUT stores it ENCRYPTED and answers only "configured" — the key is never in any response afterwards', async () => {
    const t = await setup();
    ownChannel(t);

    const put = await t.app.inject({ method: 'PUT', url: '/creator/twitch/rewards/tts-key', headers: t.headers, payload: { apiKey: OPENAI_KEY } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ttsKeyConfigured: true });
    expect(put.body).not.toContain(OPENAI_KEY);

    const stored = t.fixture.channels.get('chan-a')!.ttsOpenAiKeyEnc as string;
    expect(stored).not.toContain(OPENAI_KEY);
    expect(decryptSecret(stored)).toBe(OPENAI_KEY);

    // Nowhere is the key (or the ciphertext) readable again.
    for (const url of [
      '/creator/twitch/rewards',
      '/creator/twitch/rewards/items',
      '/creator/twitch/rewards/overlay',
      '/creator/twitch/channel',
    ]) {
      const res = await t.app.inject({ method: 'GET', url, headers: t.read });
      expect(res.body, url).not.toContain(OPENAI_KEY);
      expect(res.body, url).not.toContain(stored);
    }
    const status = await t.app.inject({ method: 'GET', url: '/creator/twitch/rewards', headers: t.read });
    expect(status.json().ttsKeyConfigured).toBe(true);
    await t.app.close();
  });

  it('replacing it re-encrypts the new key; DELETE clears it ("not set")', async () => {
    const t = await setup();
    ownChannel(t, { ttsOpenAiKeyEnc: encryptSecret('sk-old-key-old-key-old-key-1234') });

    await t.app.inject({ method: 'PUT', url: '/creator/twitch/rewards/tts-key', headers: t.headers, payload: { apiKey: OPENAI_KEY } });
    expect(decryptSecret(t.fixture.channels.get('chan-a')!.ttsOpenAiKeyEnc)).toBe(OPENAI_KEY);

    const del = await t.app.inject({ method: 'DELETE', url: '/creator/twitch/rewards/tts-key', headers: t.headers });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ttsKeyConfigured: false });
    expect(t.fixture.channels.get('chan-a')!.ttsOpenAiKeyEnc).toBeNull();
    await t.app.close();
  });

  it('rejects something that is not an OpenAI key, with no echo of what was sent', async () => {
    const t = await setup();
    ownChannel(t);
    for (const apiKey of ['', 'short', 'not-a-key-not-a-key-not-a-key-not-a-key', 'sk- has spaces in it abcdefghijklmnop', 'x'.repeat(400)]) {
      const res = await t.app.inject({ method: 'PUT', url: '/creator/twitch/rewards/tts-key', headers: t.headers, payload: { apiKey } });
      expect(res.statusCode, apiKey.slice(0, 20)).toBe(400);
    }
    // Unknown keys (e.g. a smuggled channel id) are refused too.
    const extra = await t.app.inject({
      method: 'PUT',
      url: '/creator/twitch/rewards/tts-key',
      headers: t.headers,
      payload: { apiKey: OPENAI_KEY, channelId: 'chan-other' },
    });
    expect(extra.statusCode).toBe(400);
    expect(t.fixture.channels.get('chan-a')!.ttsOpenAiKeyEnc).toBeNull();
    await t.app.close();
  });

  it("only touches the caller's own channel; 404 with no channel", async () => {
    const t = await setup(CREATOR_A);
    seedChannel(t.fixture, { id: 'chan-b', broadcasterUserId: CREATOR_B, ttsOpenAiKeyEnc: encryptSecret('sk-b-key-b-key-b-key-b-key-12') });

    const none = await t.app.inject({ method: 'PUT', url: '/creator/twitch/rewards/tts-key', headers: t.headers, payload: { apiKey: OPENAI_KEY } });
    expect(none.statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: '/creator/twitch/rewards/tts-key', headers: t.headers })).statusCode).toBe(404);
    expect(decryptSecret(t.fixture.channels.get('chan-b')!.ttsOpenAiKeyEnc)).toBe('sk-b-key-b-key-b-key-b-key-12');
    await t.app.close();
  });
});
