import { describe, expect, it } from 'vitest';
import { buildTestApp, loginAs } from './helpers/build-test-app';

// See bot-owner.test.ts — `requireBotOwner` re-reads `process.env.BOT_OWNER_IDS` on every request.
process.env.BOT_OWNER_IDS = 'owner-1';

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}
function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Small in-memory Prisma fakes that understand exactly the `where` shapes `routes/owner-metrics-connections.ts`
// issues (equality, `gte`, `not: null`, `contains`/insensitive, `OR`), so the tests exercise the route's real
// filtering against seeded rows rather than canned per-call answers.
/* eslint-disable @typescript-eslint/no-explicit-any */
function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as unknown[]).some((sub) => matchesWhere(row, sub));
    const value = row[key];
    if (cond === null || typeof cond !== 'object') return value === cond;
    const c = cond as Record<string, unknown>;
    if ('gte' in c) return value != null && new Date(value).getTime() >= new Date(c.gte as Date).getTime();
    if ('not' in c) return c.not === null ? value != null : value !== c.not;
    if ('contains' in c)
      return String(value ?? '')
        .toLowerCase()
        .includes(String(c.contains).toLowerCase());
    throw new Error(`unsupported where clause on ${key}`);
  });
}
function fakeCount(rows: any[]) {
  return async (args: any) => rows.filter((r) => matchesWhere(r, args?.where)).length;
}
function fakeGroupBy(rows: any[]) {
  return async (args: any) => {
    const groups = new Map<string, any>();
    for (const row of rows.filter((r) => matchesWhere(r, args?.where))) {
      const key = (args.by as string[]).map((f) => row[f]).join('|');
      if (!groups.has(key)) {
        groups.set(key, {
          ...Object.fromEntries((args.by as string[]).map((f) => [f, row[f]])),
          _count: { _all: 0 },
        });
      }
      groups.get(key)._count._all += 1;
    }
    return [...groups.values()];
  };
}
function fakeFindMany(rows: any[]) {
  return async (args: any) => {
    let list = rows.filter((r) => matchesWhere(r, args?.where));
    if (args?.orderBy) {
      const [field, dir] = Object.entries(args.orderBy)[0] as [string, string];
      list = [...list].sort((a, b) => (dir === 'desc' ? -1 : 1) * (a[field].getTime() - b[field].getTime()));
    }
    const skip = args?.skip ?? 0;
    return args?.take !== undefined ? list.slice(skip, skip + args.take) : list.slice(skip);
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function ownerContext(overrides: Parameters<typeof buildTestApp>[0]) {
  const built = await buildTestApp(overrides);
  const { cookieHeader } = await loginAs(built.app, built.redis, { userId: 'owner-1' });
  return { app: built.app, cookieHeader, prismaCalls: built.prismaCalls };
}

function channel(overrides: Record<string, unknown>) {
  return {
    id: 'ch',
    broadcasterLogin: 'someone',
    enabled: true,
    status: 'CONNECTED',
    guildId: null,
    guild: null,
    rewardsEnabled: false,
    bridgeDiscordToTwitch: false,
    bridgeTwitchToDiscord: false,
    lastConnectedAt: null,
    lastError: null,
    createdAt: daysAgo(100),
    _count: { commands: 0, timers: 0, rewards: 0 },
    ...overrides,
  };
}

const PATHS = ['/owner/metrics/twitch', '/owner/metrics/twitch/channels', '/owner/metrics/integrations'];

describe('owner-metrics connections gate', () => {
  for (const path of PATHS) {
    it(`GET ${path} returns 401 unauthenticated`, async () => {
      const { app } = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it(`GET ${path} returns 403 for a logged-in non-owner`, async () => {
      const { app, redis } = await buildTestApp();
      const { cookieHeader } = await loginAs(app, redis, { userId: 'not-an-owner' });
      const res = await app.inject({ method: 'GET', url: path, headers: { cookie: cookieHeader } });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  }
});

describe('GET /owner/metrics/twitch', () => {
  it('aggregates the bot identity, channels, features, economy, and alerts from seeded data', async () => {
    const channels = [
      channel({
        id: 'c1',
        status: 'CONNECTED',
        guildId: 'g1',
        createdAt: daysAgo(1),
        rewardsEnabled: true,
        bridgeTwitchToDiscord: true,
      }),
      channel({ id: 'c2', status: 'CONNECTED', createdAt: daysAgo(1) }),
      channel({
        id: 'c3',
        status: 'ERROR',
        guildId: 'g2',
        createdAt: daysAgo(12),
        enabled: false,
        bridgeDiscordToTwitch: true,
        bridgeTwitchToDiscord: true,
      }),
      channel({ id: 'c4', status: 'PENDING', createdAt: daysAgo(60) }),
    ];
    const commands = [{ enabled: true }, { enabled: true }, { enabled: false }];
    const timers = [{ enabled: true }, { enabled: false }];
    const rewards = [
      { enabled: true, action: 'SOUND' },
      { enabled: true, action: 'SOUND' },
      { enabled: true, action: 'CHAT' },
      { enabled: false, action: 'TTS' },
    ];
    const economies = [{ enabled: true }, { enabled: false }];
    const wallets = [{ updatedAt: daysAgo(1) }, { updatedAt: daysAgo(10) }, { updatedAt: daysAgo(50) }];
    const transactions = [
      { type: 'twitch_chat_earn', createdAt: daysAgo(1) },
      { type: 'twitch_chat_earn', createdAt: daysAgo(2) },
      { type: 'twitch_chat_earn', createdAt: daysAgo(20) },
      { type: 'daily', createdAt: daysAgo(3) },
      { type: 'give', createdAt: daysAgo(45) },
    ];
    const connections = [
      { provider: 'TWITCH', status: 'CONNECTED', deletedAt: null },
      { provider: 'TWITCH', status: 'ERROR', deletedAt: null },
      { provider: 'TWITCH', status: 'CONNECTED', deletedAt: daysAgo(2) },
      { provider: 'YOUTUBE', status: 'CONNECTED', deletedAt: null },
    ];

    const { app, cookieHeader, prismaCalls } = await ownerContext({
      twitchBotIdentity: {
        findFirst: async () => ({ botLogin: 'pavisiebot', status: 'CONNECTED', lastError: null }),
      },
      twitchChatChannel: {
        groupBy: fakeGroupBy(channels),
        count: fakeCount(channels),
        findMany: fakeFindMany(channels),
      },
      twitchChatCommand: { count: fakeCount(commands) },
      twitchChatTimer: { count: fakeCount(timers) },
      twitchChatReward: { groupBy: fakeGroupBy(rewards) },
      channelEconomy: { count: fakeCount(economies) },
      channelWallet: { count: fakeCount(wallets) },
      channelTransaction: { count: fakeCount(transactions), groupBy: fakeGroupBy(transactions) },
      integrationConnection: { groupBy: fakeGroupBy(connections) },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/twitch?days=7',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bot).toEqual({ configured: true, login: 'pavisiebot', status: 'connected', lastError: null });
    expect(body.channels).toEqual({
      total: 4,
      enabled: 3,
      status: { connected: 2, disconnected: 0, error: 1, pending: 1 },
      guildLinked: 2,
      standalone: 2,
      linked7d: 2,
      linked30d: 3,
      rewardsEnabled: 1,
      bridgeEnabled: 2,
    });
    expect(body.features).toEqual({
      commands: 2,
      timers: 1,
      rewards: 3,
      rewardsByAction: { sound: 2, tts: 0, chat: 1, discord: 0 },
    });
    expect(body.economy).toEqual({
      economies: 2,
      enabled: 1,
      wallets: 3,
      activeWallets7d: 1,
      activeWallets30d: 2,
      transactions7d: 3,
      transactions30d: 4,
      transactionsByType30d: [
        { type: 'twitch_chat_earn', count: 3 },
        { type: 'daily', count: 1 },
      ],
    });
    // The soft-deleted Twitch connection and the YouTube one are both excluded.
    expect(body.alerts).toEqual({
      total: 2,
      status: { connected: 1, disconnected: 0, error: 1, pending: 0 },
    });

    expect(body.points).toHaveLength(7);
    expect(body.points[6].date).toBe(toUtcDateString(new Date()));
    const linkedDay = body.points.find((p: { date: string }) => p.date === toUtcDateString(daysAgo(1)));
    expect(linkedDay.linked).toBe(2);
    expect(body.points[6].runningTotal).toBe(2);

    // The bot identity row holds encrypted tokens — the route must name the columns it reads.
    const botCall = prismaCalls.find((c) => c.model === 'twitchBotIdentity');
    expect(botCall?.args[0]).toEqual({ select: { botLogin: true, status: true, lastError: true } });
    await app.close();
  });

  it('reports an unconfigured bot and all-zero counts on an empty database', async () => {
    const { app, cookieHeader } = await ownerContext({
      twitchChatChannel: { groupBy: async () => [] },
      twitchChatReward: { groupBy: async () => [] },
      channelTransaction: { groupBy: async () => [] },
      integrationConnection: { groupBy: async () => [] },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/twitch?days=0',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bot).toEqual({ configured: false, login: null, status: null, lastError: null });
    expect(body.channels.total).toBe(0);
    expect(body.economy.transactions30d).toBe(0);
    expect(body.economy.transactionsByType30d).toEqual([]);
    // `days` is clamped into 1..365, not rejected.
    expect(body.points).toEqual([{ date: toUtcDateString(new Date()), linked: 0, runningTotal: 0 }]);
    await app.close();
  });
});

describe('GET /owner/metrics/twitch/channels', () => {
  const connectedAt = daysAgo(0.5);
  const rows = [
    channel({
      id: 'c1',
      broadcasterLogin: 'NovaPlays',
      createdAt: daysAgo(1),
      guildId: 'g1',
      guild: { name: 'Nova HQ' },
      _count: { commands: 4, timers: 2, rewards: 1 },
      rewardsEnabled: true,
      lastConnectedAt: connectedAt,
    }),
    channel({
      id: 'c2',
      broadcasterLogin: 'starfort',
      createdAt: daysAgo(2),
      status: 'ERROR',
      lastError: 'x'.repeat(600),
      bridgeDiscordToTwitch: true,
    }),
    channel({ id: 'c3', broadcasterLogin: 'novalite', createdAt: daysAgo(3) }),
  ];

  it('lists channels newest-linked first and never selects a secret column', async () => {
    const { app, cookieHeader, prismaCalls } = await ownerContext({
      twitchChatChannel: { findMany: fakeFindMany(rows) },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/twitch/channels',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['c1', 'c2', 'c3']);
    expect(body.items[0]).toEqual({
      id: 'c1',
      broadcasterLogin: 'NovaPlays',
      enabled: true,
      status: 'connected',
      guildId: 'g1',
      guildName: 'Nova HQ',
      commands: 4,
      timers: 2,
      rewards: 1,
      rewardsEnabled: true,
      bridgeEnabled: false,
      lastConnectedAt: connectedAt.toISOString(),
      lastError: null,
      linkedAt: rows[0]!.createdAt.toISOString(),
    });
    expect(body.items[1].bridgeEnabled).toBe(true);
    expect(body.items[1].lastError).toHaveLength(501); // capped at 500 chars + an ellipsis

    const call = prismaCalls.find((c) => c.model === 'twitchChatChannel' && c.method === 'findMany');
    const args = call?.args[0] as { select: Record<string, unknown>; include?: unknown };
    expect(args.include).toBeUndefined();
    for (const secret of [
      'overlayTokenEnc',
      'ttsOpenAiKeyEnc',
      'bridgeWebhookTokenEnc',
      'bridgeWebhookId',
      'broadcasterToken',
    ]) {
      expect(args.select).not.toHaveProperty(secret);
    }
    await app.close();
  });

  it('filters by login substring and by status, and paginates', async () => {
    const { app, cookieHeader } = await ownerContext({
      twitchChatChannel: { findMany: fakeFindMany(rows) },
    });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });

    const byQuery = (await get('/owner/metrics/twitch/channels?query=NOVA')).json();
    expect(byQuery.items.map((i: { id: string }) => i.id)).toEqual(['c1', 'c3']);

    const byStatus = (await get('/owner/metrics/twitch/channels?status=error')).json();
    expect(byStatus.items.map((i: { id: string }) => i.id)).toEqual(['c2']);

    const badStatus = await get('/owner/metrics/twitch/channels?status=bogus');
    expect(badStatus.statusCode).toBe(400);

    const page1 = (await get('/owner/metrics/twitch/channels?limit=2')).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await get(`/owner/metrics/twitch/channels?limit=2&cursor=${page1.nextCursor}`)).json();
    expect(page2.items.map((i: { id: string }) => i.id)).toEqual(['c3']);
    expect(page2.nextCursor).toBeNull();
    await app.close();
  });
});

describe('GET /owner/metrics/integrations', () => {
  it('tallies non-deleted connections by provider and status, busiest provider first', async () => {
    const connections = [
      { provider: 'YOUTUBE', status: 'CONNECTED', deletedAt: null },
      { provider: 'TWITCH', status: 'CONNECTED', deletedAt: null },
      { provider: 'TWITCH', status: 'CONNECTED', deletedAt: null },
      { provider: 'TWITCH', status: 'ERROR', deletedAt: null },
      { provider: 'REDDIT', status: 'PENDING', deletedAt: null },
      { provider: 'REDDIT', status: 'CONNECTED', deletedAt: daysAgo(1) },
    ];
    const { app, cookieHeader } = await ownerContext({
      integrationConnection: { groupBy: fakeGroupBy(connections) },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/integrations',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      providers: [
        { provider: 'TWITCH', total: 3, status: { connected: 2, disconnected: 0, error: 1, pending: 0 } },
        { provider: 'REDDIT', total: 1, status: { connected: 0, disconnected: 0, error: 0, pending: 1 } },
        { provider: 'YOUTUBE', total: 1, status: { connected: 1, disconnected: 0, error: 0, pending: 0 } },
      ],
      totals: { total: 5, status: { connected: 3, disconnected: 0, error: 1, pending: 1 } },
    });
    await app.close();
  });
});
