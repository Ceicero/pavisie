import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@pavisie/core';
import { buildFakeChannelPrisma } from '@pavisie/plugins/channel-economy/__tests__/fake-channel-prisma';
import { CHANNEL_ECONOMY_DEFAULTS } from '@pavisie/plugins/channel-economy/settings';
import { buildApp } from '../src/app';
import { createFakeQueues, loginAs, loginAsCreator } from './helpers/build-test-app';

// `/creator/twitch/economy/*` — a streamer's OWN channel currency (ARCHITECTURE.md §18b/§19e). Uses a real
// `buildApp()` over an in-memory Prisma fake that has a real, callable `$transaction` (the generic recording stub
// cannot represent one — the ledger needs it), plus a stubbed Helix for the login -> user id lookup.

const CREATOR_A = '830000000001';
const CREATOR_B = '830000000002';
const VIEWER = '830000000099';

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

/* eslint-disable @typescript-eslint/no-explicit-any -- test fakes: args mirror Prisma's generated types loosely */

/** In-memory `ChannelEconomy` model (findUnique/upsert on the (platform, channelUserId) unique key). */
function makeEconomyModel(store: Map<string, any>) {
  const keyOf = (where: any) => {
    const k = where.platform_channelUserId;
    return `${k.platform}:${k.channelUserId}`;
  };
  let n = 1;
  return {
    findUnique: async (args: any) => {
      const row = store.get(keyOf(args.where));
      return row ? { ...row } : null;
    },
    upsert: async (args: any) => {
      const key = keyOf(args.where);
      const existing = store.get(key);
      if (existing) {
        const updated = { ...existing, ...args.update, updatedAt: new Date() };
        store.set(key, updated);
        return { ...updated };
      }
      const row = {
        id: `econ-${n++}`,
        ...CHANNEL_ECONOMY_DEFAULTS,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.create,
      };
      store.set(key, row);
      return { ...row };
    },
  };
}

async function setup() {
  const economies = new Map<string, any>();
  const channel = buildFakeChannelPrisma();
  const prisma = {
    ...(channel.prisma as unknown as Record<string, unknown>),
    channelEconomy: makeEconomyModel(economies),
  } as any;
  const redis = new RedisMock() as unknown as Redis;
  const overlaySubscriber = new RedisMock() as unknown as Redis;
  const app = await buildApp({ prisma, redis, queues: createFakeQueues(), overlaySubscriber, logger: pino({ enabled: false }) });
  await app.ready();
  return { app, redis, economies, channel };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function signIn(t: Setup, platformUserId: string, login = `login${platformUserId}`) {
  const creator = await loginAsCreator(t.app, t.redis, { platformUserId, login });
  return {
    creator,
    /** Mutating requests carry the creator's csrf token. */
    headers: { cookie: creator.cookieHeader, 'x-csrf-token': creator.session.csrfToken },
    read: { cookie: creator.cookieHeader },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface HelixStub {
  users?: Record<string, { id: string; login: string; display_name: string }>;
  /** Make the `/users` call fail with this HTTP status. */
  usersStatus?: number;
}

/** Stubs Twitch: the client-credentials token and Helix `GET /users?login=`. Returns the recorded `/users` logins. */
function stubHelix(stub: HelixStub = {}) {
  const lookedUp: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
        return jsonResponse({ access_token: 'app-token', expires_in: 3600, token_type: 'bearer' });
      }
      if (url.startsWith('https://api.twitch.tv/helix/users')) {
        if (stub.usersStatus) return jsonResponse({ error: 'boom' }, stub.usersStatus);
        const login = new URL(url).searchParams.get('login') ?? '';
        lookedUp.push(login);
        const user = stub.users?.[login];
        return jsonResponse({ data: user ? [user] : [] });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
  return { lookedUp };
}

const VIEWER_USER = { id: VIEWER, login: 'someviewer', display_name: 'SomeViewer' };

describe('every /creator/twitch/economy route: 401 without a creator session', () => {
  const routes: { method: 'GET' | 'PATCH' | 'POST'; url: string; payload?: unknown }[] = [
    { method: 'GET', url: '/creator/twitch/economy' },
    { method: 'PATCH', url: '/creator/twitch/economy', payload: { enabled: true } },
    { method: 'GET', url: '/creator/twitch/economy/leaderboard' },
    { method: 'POST', url: '/creator/twitch/economy/adjust', payload: { login: 'x', direction: 'add', amount: 1, reason: 'r' } },
  ];
  for (const r of routes) {
    it(`${r.method} ${r.url}`, async () => {
      const t = await setup();
      // Even a Discord session must not get through.
      const discord = await loginAs(t.app, t.redis, { userId: '111111111111111111' });
      const res = await t.app.inject({
        method: r.method,
        url: r.url,
        payload: r.payload as object | undefined,
        headers: { cookie: discord.cookieHeader, 'x-csrf-token': discord.session.csrfToken },
      });
      expect(res.statusCode).toBe(401);
      expect(t.economies.size).toBe(0);
      await t.app.close();
    });
  }
});

describe('mutating economy routes need the creator session CSRF token', () => {
  it('PATCH and POST without the token are 403 and change nothing', async () => {
    const t = await setup();
    const { read } = await signIn(t, CREATOR_A);

    const patch = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { enabled: true }, headers: read });
    expect(patch.statusCode).toBe(403);
    const post = await t.app.inject({
      method: 'POST',
      url: '/creator/twitch/economy/adjust',
      payload: { login: 'someviewer', direction: 'add', amount: 5, reason: 'why' },
      headers: read,
    });
    expect(post.statusCode).toBe(403);
    expect(t.economies.size).toBe(0);
    expect(t.channel.allWallets()).toHaveLength(0);
    await t.app.close();
  });

  it("a Discord dashboard session's CSRF token does not satisfy a creator route", async () => {
    const t = await setup();
    const { creator } = await signIn(t, CREATOR_A);
    const discord = await loginAs(t.app, t.redis, { userId: '111111111111111111' });
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/economy',
      payload: { enabled: true },
      headers: { cookie: creator.cookieHeader, 'x-csrf-token': discord.session.csrfToken },
    });
    expect(res.statusCode).toBe(403);
    expect(t.economies.size).toBe(0);
    await t.app.close();
  });
});

describe('GET /creator/twitch/economy', () => {
  it('before any save: returns the defaults with configured=false and creates NOTHING', async () => {
    const t = await setup();
    const { read } = await signIn(t, CREATOR_A);

    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/economy', headers: read });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false, settings: CHANNEL_ECONOMY_DEFAULTS });
    expect(res.json().settings.enabled).toBe(false);
    expect(t.economies.size).toBe(0); // viewing never writes
    await t.app.close();
  });

  it('after a save: returns the stored settings with configured=true', async () => {
    const t = await setup();
    const { headers, read } = await signIn(t, CREATOR_A);
    await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { enabled: true, currencyName: 'Gems' }, headers });

    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/economy', headers: read });
    expect(res.json()).toEqual({ configured: true, settings: { ...CHANNEL_ECONOMY_DEFAULTS, enabled: true, currencyName: 'Gems' } });
    await t.app.close();
  });
});

describe('PATCH /creator/twitch/economy', () => {
  it("the first save creates the streamer's own economy from the defaults + the patch, keyed to their Twitch id", async () => {
    const t = await setup();
    const { headers } = await signIn(t, CREATOR_A);

    const res = await t.app.inject({
      method: 'PATCH',
      url: '/creator/twitch/economy',
      payload: { enabled: true, currencyName: ' Gems ', currencySymbol: '💎', earnEnabled: true, earnPerMessage: 9 },
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: true,
      settings: { ...CHANNEL_ECONOMY_DEFAULTS, enabled: true, currencyName: 'Gems', currencySymbol: '💎', earnEnabled: true, earnPerMessage: 9 },
    });
    expect(t.economies.size).toBe(1);
    const row = t.economies.get(`TWITCH:${CREATOR_A}`);
    expect(row).toMatchObject({ platform: 'TWITCH', channelUserId: CREATOR_A, enabled: true, earnPerMessage: 9 });
    await t.app.close();
  });

  it('a later save changes only what was sent', async () => {
    const t = await setup();
    const { headers } = await signIn(t, CREATOR_A);
    await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { enabled: true, dailyMinAmount: 20, dailyMaxAmount: 30 }, headers });

    const res = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { earnDailyCap: 0 }, headers });

    expect(res.json().settings).toMatchObject({ enabled: true, dailyMinAmount: 20, dailyMaxAmount: 30, earnDailyCap: 0 });
    expect(t.economies.size).toBe(1);
    await t.app.close();
  });

  it('an empty patch changes nothing and does not create the row', async () => {
    const t = await setup();
    const { headers } = await signIn(t, CREATOR_A);
    const res = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: {}, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(false);
    expect(t.economies.size).toBe(0);
    await t.app.close();
  });

  const invalid: [string, Record<string, unknown>][] = [
    ['an empty currency name', { currencyName: '   ' }],
    ['a currency name over 32 chars', { currencyName: 'x'.repeat(33) }],
    ['a currency symbol over 8 chars', { currencySymbol: 'x'.repeat(9) }],
    ['a negative daily minimum', { dailyMinAmount: -1 }],
    ['a daily maximum over 1,000,000', { dailyMaxAmount: 1_000_001 }],
    ['a fractional amount', { dailyMinAmount: 1.5 }],
    ['a streak bonus over 10,000', { streakBonusPerDay: 10_001 }],
    ['a give minimum of 0', { giveMinAmount: 0 }],
    ['an earn amount of 0', { earnPerMessage: 0 }],
    ['an earn amount over 1000', { earnPerMessage: 1001 }],
    ['an earn cooldown under 10s', { earnCooldownSeconds: 9 }],
    ['an earn cooldown over an hour', { earnCooldownSeconds: 3601 }],
    ['a negative daily cap', { earnDailyCap: -1 }],
    ['a non-boolean switch', { enabled: 'yes' }],
    ['an unknown field', { somethingElse: 1 }],
    ['a channel id smuggled into the body', { channelUserId: CREATOR_B }],
    ['an economy id smuggled into the body', { id: 'econ-x' }],
    ['a platform override', { platform: 'TWITCH' }],
  ];
  for (const [name, payload] of invalid) {
    it(`rejects ${name} (400) and writes nothing`, async () => {
      const t = await setup();
      const { headers } = await signIn(t, CREATOR_A);
      const res = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload, headers });
      expect(res.statusCode).toBe(400);
      expect(t.economies.size).toBe(0);
      await t.app.close();
    });
  }

  it('rejects an inverted daily range (min above max), including against already-stored values', async () => {
    const t = await setup();
    const { headers } = await signIn(t, CREATOR_A);

    const both = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { dailyMinAmount: 500, dailyMaxAmount: 100 }, headers });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe('invalid_economy_settings');
    expect(t.economies.size).toBe(0);

    await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { dailyMinAmount: 10, dailyMaxAmount: 20 }, headers });
    // 30 alone looks fine, but is above the STORED maximum of 20.
    const merged = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { dailyMinAmount: 30 }, headers });
    expect(merged.statusCode).toBe(400);
    expect(t.economies.get(`TWITCH:${CREATOR_A}`)).toMatchObject({ dailyMinAmount: 10, dailyMaxAmount: 20 });
    await t.app.close();
  });

  it('rejects an inverted give range', async () => {
    const t = await setup();
    const { headers } = await signIn(t, CREATOR_A);
    const res = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { giveMinAmount: 50, giveMaxAmount: 10 }, headers });
    expect(res.statusCode).toBe(400);
    expect(t.economies.size).toBe(0);
    await t.app.close();
  });

  it("each creator has their own economy: B can neither see nor change A's, and B's first save creates B's row only", async () => {
    const t = await setup();
    const a = await signIn(t, CREATOR_A);
    const b = await signIn(t, CREATOR_B);
    await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { enabled: true, currencyName: 'AAA' }, headers: a.headers });

    const seenByB = await t.app.inject({ method: 'GET', url: '/creator/twitch/economy', headers: b.read });
    expect(seenByB.json()).toEqual({ configured: false, settings: CHANNEL_ECONOMY_DEFAULTS });

    await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { currencyName: 'BBB' }, headers: b.headers });
    expect(t.economies.size).toBe(2);
    expect(t.economies.get(`TWITCH:${CREATOR_A}`)).toMatchObject({ currencyName: 'AAA', enabled: true });
    expect(t.economies.get(`TWITCH:${CREATOR_B}`)).toMatchObject({ currencyName: 'BBB', enabled: false });
    await t.app.close();
  });

  it('works with no chat-bot channel and no Discord server at all', async () => {
    // The fake has no TwitchChatChannel / Guild models: the currency needs neither.
    const t = await setup();
    const { headers } = await signIn(t, CREATOR_A);
    const res = await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { enabled: true }, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(true);
    await t.app.close();
  });
});

describe('GET /creator/twitch/economy/leaderboard', () => {
  it('before setup: empty arrays, configured=false, no error', async () => {
    const t = await setup();
    const { read } = await signIn(t, CREATOR_A);
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/economy/leaderboard', headers: read });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false, earned: [], balance: [] });
    await t.app.close();
  });

  it('set up but nobody has earned yet: empty arrays with configured=true', async () => {
    const t = await setup();
    const { headers, read } = await signIn(t, CREATOR_A);
    await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { enabled: true }, headers });
    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/economy/leaderboard', headers: read });
    expect(res.json()).toEqual({ configured: true, earned: [], balance: [] });
    await t.app.close();
  });

  it("ranks this channel's viewers by lifetime earned and by balance, as decimal strings, and excludes other channels", async () => {
    const t = await setup();
    const { headers, read } = await signIn(t, CREATOR_A);
    await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { enabled: true }, headers });
    const economyId = t.economies.get(`TWITCH:${CREATOR_A}`).id as string;

    // Two viewers here, and one in some OTHER channel's economy.
    for (const [viewer, name, amount] of [['v1', 'Top', 500n], ['v2', 'Second', 100n]] as const) {
      const wallet = await (t.channel.prisma as any).channelWallet.upsert({
        where: { economyId_viewerUserId: { economyId, viewerUserId: viewer } },
        create: { economyId, viewerUserId: viewer, displayName: name },
      });
      await (t.channel.prisma as any).channelWallet.update({ where: { id: wallet.id }, data: { balance: { increment: amount } } });
      t.channel.seedTransaction({ economyId, walletId: wallet.id, toUserId: viewer, amount, type: 'daily' });
    }
    const other = await (t.channel.prisma as any).channelWallet.upsert({
      where: { economyId_viewerUserId: { economyId: 'econ-other', viewerUserId: 'x' } },
      create: { economyId: 'econ-other', viewerUserId: 'x', displayName: 'Elsewhere' },
    });
    await (t.channel.prisma as any).channelWallet.update({ where: { id: other.id }, data: { balance: { increment: 9999n } } });
    t.channel.seedTransaction({ economyId: 'econ-other', walletId: other.id, toUserId: 'x', amount: 9999n, type: 'daily' });

    const res = await t.app.inject({ method: 'GET', url: '/creator/twitch/economy/leaderboard', headers: read });
    expect(res.json()).toEqual({
      configured: true,
      earned: [
        { viewerUserId: 'v1', displayName: 'Top', earned: '500' },
        { viewerUserId: 'v2', displayName: 'Second', earned: '100' },
      ],
      balance: [
        { viewerUserId: 'v1', displayName: 'Top', balance: '500' },
        { viewerUserId: 'v2', displayName: 'Second', balance: '100' },
      ],
    });

    const limited = await t.app.inject({ method: 'GET', url: '/creator/twitch/economy/leaderboard?limit=1', headers: read });
    expect(limited.json().earned).toHaveLength(1);
    const bad = await t.app.inject({ method: 'GET', url: '/creator/twitch/economy/leaderboard?limit=0', headers: read });
    expect(bad.statusCode).toBe(400);
    await t.app.close();
  });
});

describe('POST /creator/twitch/economy/adjust', () => {
  async function configured(t: Setup, who = CREATOR_A) {
    const s = await signIn(t, who);
    await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { enabled: true }, headers: s.headers });
    const economyId = t.economies.get(`TWITCH:${who}`).id as string;
    return { ...s, economyId };
  }
  const post = (t: Setup, headers: Record<string, string>, payload: unknown) =>
    t.app.inject({ method: 'POST', url: '/creator/twitch/economy/adjust', payload: payload as object, headers });

  it("adds to a viewer's balance: resolves the login via Helix, creates the wallet with their display name, records admin_add + the reason", async () => {
    stubHelix({ users: { someviewer: VIEWER_USER } });
    const t = await setup();
    const { headers, economyId } = await configured(t);

    const res = await post(t, headers, { login: '@SomeViewer', direction: 'add', amount: 250, reason: 'giveaway winner' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      viewer: { userId: VIEWER, login: 'someviewer', displayName: 'SomeViewer' },
      direction: 'add',
      amount: '250',
      newBalance: '250',
    });
    expect(t.channel.getWallet(economyId, VIEWER)).toMatchObject({ balance: 250n, displayName: 'SomeViewer' });
    expect(t.channel.getTransactions()).toHaveLength(1);
    expect(t.channel.getTransactions()[0]).toMatchObject({
      economyId,
      type: 'admin_add',
      toUserId: VIEWER,
      amount: 250n,
      note: 'giveaway winner',
    });
    await t.app.close();
  });

  it('removes from a balance, and refuses to go below zero (409, nothing written)', async () => {
    stubHelix({ users: { someviewer: VIEWER_USER } });
    const t = await setup();
    const { headers, economyId } = await configured(t);
    await post(t, headers, { login: 'someviewer', direction: 'add', amount: 100, reason: 'seed' });

    const ok = await post(t, headers, { login: 'someviewer', direction: 'remove', amount: 40, reason: 'penalty' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().newBalance).toBe('60');
    expect(t.channel.getTransactions()[1]).toMatchObject({ type: 'admin_remove', fromUserId: VIEWER, amount: 40n, note: 'penalty' });

    const tooMuch = await post(t, headers, { login: 'someviewer', direction: 'remove', amount: 61, reason: 'oops' });
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json().error.code).toBe('would_go_negative');
    expect(t.channel.getWallet(economyId, VIEWER)?.balance).toBe(60n);
    expect(t.channel.getTransactions()).toHaveLength(2);
    await t.app.close();
  });

  it('a reason is mandatory (missing, blank and over-long are all 400) and nothing is written or looked up', async () => {
    const helix = stubHelix({ users: { someviewer: VIEWER_USER } });
    const t = await setup();
    const { headers } = await configured(t);

    for (const reason of [undefined, '', '   ', 'x'.repeat(201)]) {
      const res = await post(t, headers, { login: 'someviewer', direction: 'add', amount: 5, reason });
      expect(res.statusCode).toBe(400);
    }
    expect(helix.lookedUp).toEqual([]);
    expect(t.channel.allWallets()).toHaveLength(0);
    await t.app.close();
  });

  it('rejects an invalid login (URL, spaces, punctuation, too long) with 400 BEFORE any Helix call', async () => {
    const helix = stubHelix({ users: { someviewer: VIEWER_USER } });
    const t = await setup();
    const { headers } = await configured(t);

    for (const login of ['https://evil.example/x', 'two words', 'dot.name', 'semi;colon', 'a'.repeat(26), '', '@']) {
      const res = await post(t, headers, { login, direction: 'add', amount: 5, reason: 'r' });
      expect(res.statusCode, login).toBe(400);
    }
    expect(helix.lookedUp).toEqual([]);
    expect(t.channel.allWallets()).toHaveLength(0);
    await t.app.close();
  });

  it('rejects bad amounts: zero, negative, fractional, over the cap, non-numeric', async () => {
    stubHelix({ users: { someviewer: VIEWER_USER } });
    const t = await setup();
    const { headers } = await configured(t);
    for (const amount of [0, -5, 1.5, 1_000_000_001, '10', null]) {
      const res = await post(t, headers, { login: 'someviewer', direction: 'add', amount, reason: 'r' });
      expect(res.statusCode, String(amount)).toBe(400);
    }
    expect(t.channel.allWallets()).toHaveLength(0);
    await t.app.close();
  });

  it('rejects an unknown direction and unknown body fields (a channel/economy id cannot be smuggled in)', async () => {
    stubHelix({ users: { someviewer: VIEWER_USER } });
    const t = await setup();
    const { headers } = await configured(t);
    const badDirection = await post(t, headers, { login: 'someviewer', direction: 'set', amount: 5, reason: 'r' });
    expect(badDirection.statusCode).toBe(400);
    const smuggled = await post(t, headers, { login: 'someviewer', direction: 'add', amount: 5, reason: 'r', economyId: 'econ-other' });
    expect(smuggled.statusCode).toBe(400);
    expect(t.channel.allWallets()).toHaveLength(0);
    await t.app.close();
  });

  it('an unknown Twitch user is a 404 with a fixed message, and nothing is written', async () => {
    stubHelix({ users: {} });
    const t = await setup();
    const { headers } = await configured(t);
    const res = await post(t, headers, { login: 'nosuchuser', direction: 'add', amount: 5, reason: 'r' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('twitch_user_not_found');
    expect(res.body).not.toContain('nosuchuser');
    expect(t.channel.allWallets()).toHaveLength(0);
    await t.app.close();
  });

  it('a Twitch outage is a 502 (never reported as "no such user"), and nothing is written', async () => {
    stubHelix({ usersStatus: 500 });
    const t = await setup();
    const { headers } = await configured(t);
    const res = await post(t, headers, { login: 'someviewer', direction: 'add', amount: 5, reason: 'r' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('twitch_lookup_failed');
    expect(t.channel.allWallets()).toHaveLength(0);
    await t.app.close();
  });

  it('Twitch not configured on this deployment is also a 502, not a crash', async () => {
    env.TWITCH_CLIENT_ID = undefined;
    env.TWITCH_CLIENT_SECRET = undefined;
    stubHelix();
    const t = await setup();
    const { headers } = await configured(t);
    const res = await post(t, headers, { login: 'someviewer', direction: 'add', amount: 5, reason: 'r' });
    expect(res.statusCode).toBe(502);
    await t.app.close();
  });

  it('is a 404 until the streamer has set up their currency (no row is created by this route)', async () => {
    const helix = stubHelix({ users: { someviewer: VIEWER_USER } });
    const t = await setup();
    const { headers } = await signIn(t, CREATOR_A);
    const res = await post(t, headers, { login: 'someviewer', direction: 'add', amount: 5, reason: 'r' });
    expect(res.statusCode).toBe(404);
    expect(helix.lookedUp).toEqual([]);
    expect(t.economies.size).toBe(0);
    expect(t.channel.allWallets()).toHaveLength(0);
    await t.app.close();
  });

  it("only ever touches the signed-in creator's own economy", async () => {
    stubHelix({ users: { someviewer: VIEWER_USER } });
    const t = await setup();
    const a = await configured(t, CREATOR_A);
    const b = await configured(t, CREATOR_B);

    await post(t, a.headers, { login: 'someviewer', direction: 'add', amount: 100, reason: 'r' });
    // B removing the same viewer's balance in B's own (empty) economy cannot touch A's.
    const res = await post(t, b.headers, { login: 'someviewer', direction: 'remove', amount: 100, reason: 'r' });

    expect(res.statusCode).toBe(409);
    expect(t.channel.getWallet(a.economyId, VIEWER)?.balance).toBe(100n);
    expect(t.channel.getWallet(b.economyId, VIEWER)?.balance ?? 0n).toBe(0n);
    await t.app.close();
  });

  it('works even if the currency is currently switched off (the streamer can still tidy balances)', async () => {
    stubHelix({ users: { someviewer: VIEWER_USER } });
    const t = await setup();
    const { headers } = await configured(t);
    await t.app.inject({ method: 'PATCH', url: '/creator/twitch/economy', payload: { enabled: false }, headers });
    const res = await post(t, headers, { login: 'someviewer', direction: 'add', amount: 5, reason: 'r' });
    expect(res.statusCode).toBe(200);
    await t.app.close();
  });

  it('two concurrent removes of the whole balance: exactly one succeeds, the balance is never negative', async () => {
    stubHelix({ users: { someviewer: VIEWER_USER } });
    const t = await setup();
    const { headers, economyId } = await configured(t);
    await post(t, headers, { login: 'someviewer', direction: 'add', amount: 50, reason: 'seed' });

    const results = await Promise.all([
      post(t, headers, { login: 'someviewer', direction: 'remove', amount: 50, reason: 'a' }),
      post(t, headers, { login: 'someviewer', direction: 'remove', amount: 50, reason: 'b' }),
    ]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(t.channel.getWallet(economyId, VIEWER)?.balance).toBe(0n);
    expect(t.channel.getTransactions().filter((x) => x.type === 'admin_remove')).toHaveLength(1);
    await t.app.close();
  });
});
