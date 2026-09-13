import { describe, expect, it } from 'vitest';
import { buildTestApp, loginAs } from './helpers/build-test-app';

// See bot-owner.test.ts for why setting this directly (rather than mutating `@pavisie/core`'s `env`) is safe
// and sufficient — `requireBotOwner` re-reads `process.env.BOT_OWNER_IDS` on every request.
process.env.BOT_OWNER_IDS = 'owner-1';

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}
function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Generic in-memory Prisma fakes. `createPrismaStub` (packages/plugins/src/sdk/testing.ts) is a bare
// call-recording proxy — every model.method needs an explicit override. Rather than hand-write bespoke
// filtering per call site (as apps/api/test/developer-reports.test.ts does for its single model), these
// endpoints span a dozen model/method combinations, so it's worth one small shared `where`-matcher that
// understands exactly the clause shapes `routes/owner-metrics.ts` actually issues (equality, `gte`, `not`,
// `in`, `contains`/`mode: insensitive`, `OR`, and one level of nested-relation equality) and generic
// count/findMany/groupBy/aggregate/findFirst built on top of it. This tests the real filtering logic against
// seeded rows, not just canned per-call return values.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as unknown[]).some((sub) => matchesWhere(row, sub));
    if (key === 'AND') return (cond as unknown[]).every((sub) => matchesWhere(row, sub));
    const value = row[key];
    if (cond === null || typeof cond !== 'object') return value === cond;
    const c = cond as Record<string, unknown>;
    if ('gte' in c) {
      if (value == null) return false;
      return new Date(value as Date).getTime() >= new Date(c.gte as Date).getTime();
    }
    if ('not' in c) return c.not === null ? value !== null && value !== undefined : value !== c.not;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('contains' in c) {
      const insensitive = c.mode === 'insensitive';
      const hay = insensitive ? String(value ?? '').toLowerCase() : String(value ?? '');
      const needle = insensitive ? String(c.contains).toLowerCase() : String(c.contains);
      return hay.includes(needle);
    }
    // One level of nested-relation equality, e.g. `{ endpoint: { guildId: X } }`.
    return matchesWhere(value, cond);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeCount(rows: any[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => rows.filter((r) => matchesWhere(r, args?.where)).length;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeFindMany(rows: any[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    let list = rows.filter((r) => matchesWhere(r, args?.where));
    if (args?.orderBy) {
      const [field, dir] = Object.entries(args.orderBy)[0] as [string, string];
      list = [...list].sort((a, b) => {
        const av = a[field] instanceof Date ? a[field].getTime() : a[field];
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
        const cmp = av === bv ? 0 : av < bv ? -1 : 1;
        return dir === 'desc' ? -cmp : cmp;
      });
    }
    const skip = args?.skip ?? 0;
    const take = args?.take;
    return take !== undefined ? list.slice(skip, skip + take) : list.slice(skip);
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeFindFirst(rows: any[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    let list = rows.filter((r) => matchesWhere(r, args?.where));
    if (args?.orderBy) {
      const [field, dir] = Object.entries(args.orderBy)[0] as [string, string];
      list = [...list].sort((a, b) => {
        const av = a[field] ?? -Infinity;
        const bv = b[field] ?? -Infinity;
        const cmp = av === bv ? 0 : av < bv ? -1 : 1;
        return dir === 'desc' ? -cmp : cmp;
      });
    }
    return list[0] ?? null;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeGroupBy(rows: any[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    const filtered = rows.filter((r) => matchesWhere(r, args?.where));
    const byField = args.by[0] as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groups = new Map<unknown, any[]>();
    for (const row of filtered) {
      const key = row[byField];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    return [...groups.entries()].map(([key, groupRows]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = { [byField]: key };
      if (args._count) result._count = { _all: groupRows.length };
      if (args._max) {
        const maxField = Object.keys(args._max)[0];
        const maxVal = groupRows.reduce((acc: unknown, r) => {
          const v = r[maxField];
          if (v == null) return acc;
          if (acc == null) return v;
          return v > (acc as Date) ? v : acc;
        }, null);
        result._max = { [maxField]: maxVal };
      }
      return result;
    });
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeAggregate(rows: any[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    const filtered = rows.filter((r) => matchesWhere(r, args?.where));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = {};
    if (args._sum) {
      const field = Object.keys(args._sum)[0];
      result._sum = { [field]: filtered.reduce((acc, r) => acc + (r[field] ?? 0), 0) };
    }
    return result;
  };
}

async function ownerContext(overrides: Parameters<typeof buildTestApp>[0]) {
  const built = await buildTestApp(overrides);
  const { cookieHeader } = await loginAs(built.app, built.redis, { userId: 'owner-1' });
  return { app: built.app, cookieHeader, prismaCalls: built.prismaCalls };
}

const OWNER_METRICS_PATHS = [
  '/owner/metrics/overview',
  '/owner/metrics/guilds',
  '/owner/metrics/errors',
  '/owner/metrics/growth',
  '/owner/metrics/usage',
];

describe('owner-metrics gate', () => {
  for (const path of OWNER_METRICS_PATHS) {
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

describe('GET /owner/metrics/overview', () => {
  it('aggregates guild presence/growth, reports, and activity from seeded data', async () => {
    const guilds = [
      { id: '700000000000000201', name: 'Alpha Server', botPresent: true, joinedAt: daysAgo(2), leftAt: null, memberCount: 500 },
      { id: '700000000000000202', name: 'Beta Hub', botPresent: true, joinedAt: daysAgo(10), leftAt: null, memberCount: 1200 },
      { id: '700000000000000203', name: 'Gamma Place', botPresent: true, joinedAt: daysAgo(40), leftAt: null, memberCount: 50 },
      { id: '700000000000000204', name: 'Delta Old', botPresent: false, joinedAt: daysAgo(100), leftAt: daysAgo(5), memberCount: 20 },
      { id: '700000000000000205', name: 'Epsilon Gone', botPresent: false, joinedAt: daysAgo(200), leftAt: daysAgo(40), memberCount: 10 },
    ];
    const developerReports = [{ status: 'OPEN' }, { status: 'OPEN' }, { status: 'HANDLED' }];
    const moderationCases = [{ createdAt: daysAgo(1) }, { createdAt: daysAgo(3) }, { createdAt: daysAgo(20) }];
    const tickets = [{ status: 'OPEN' }, { status: 'OPEN' }, { status: 'OPEN' }, { status: 'CLOSED' }];
    const automodEvents = [
      { createdAt: daysAgo(1) },
      { createdAt: daysAgo(2) },
      { createdAt: daysAgo(3) },
      { createdAt: daysAgo(4) },
      { createdAt: daysAgo(10) },
      { createdAt: daysAgo(15) },
    ];
    const enforcerRecords = [
      { kind: 'FLAG', status: 'PENDING' },
      { kind: 'FLAG', status: 'PENDING' },
      { kind: 'FLAG', status: 'ACTIONED' },
      { kind: 'DECISION', status: null },
    ];

    const { app, cookieHeader } = await ownerContext({
      guild: { groupBy: fakeGroupBy(guilds), count: fakeCount(guilds), aggregate: fakeAggregate(guilds), findFirst: fakeFindFirst(guilds) },
      developerReport: { groupBy: fakeGroupBy(developerReports) },
      moderationCase: { count: fakeCount(moderationCases) },
      ticket: { count: fakeCount(tickets) },
      automodEvent: { count: fakeCount(automodEvents) },
      enforcerRecord: { count: fakeCount(enforcerRecords) },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/overview',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      guilds: { total: 5, active: 3, inactive: 2, joined7d: 1, joined30d: 2, left30d: 1 },
      members: {
        totalAcrossGuilds: 1750,
        largestGuild: { id: '700000000000000202', name: 'Beta Hub', memberCount: 1200 },
      },
      reports: { open: 2, handled: 1, total: 3 },
      activity: { moderationCases7d: 2, ticketsOpen: 3, automodEvents7d: 4, enforcerPending: 2 },
    });
    await app.close();
  });

  it('reports a null largestGuild and zero totals when there are no guilds', async () => {
    const { app, cookieHeader } = await ownerContext({
      guild: { groupBy: fakeGroupBy([]), count: fakeCount([]), aggregate: fakeAggregate([]), findFirst: fakeFindFirst([]) },
      developerReport: { groupBy: fakeGroupBy([]) },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/overview',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.guilds).toEqual({ total: 0, active: 0, inactive: 0, joined7d: 0, joined30d: 0, left30d: 0 });
    expect(body.members).toEqual({ totalAcrossGuilds: 0, largestGuild: null });
    await app.close();
  });
});

describe('GET /owner/metrics/guilds', () => {
  const GA = '700000000000000301';
  const GB = '700000000000000302';
  const GC = '700000000000000303';
  const GD = '700000000000000304';
  const GE = '700000000000000305';
  const GF = '700000000000000306';

  function guildRows() {
    return [
      { id: GA, name: 'Nova Base', botPresent: true, joinedAt: daysAgo(1), leftAt: null, memberCount: 10, ownerId: 'o-a', iconHash: null },
      { id: GB, name: 'Nova Outpost', botPresent: true, joinedAt: daysAgo(2), leftAt: null, memberCount: 20, ownerId: 'o-b', iconHash: null },
      { id: GC, name: 'Star Fort', botPresent: true, joinedAt: daysAgo(3), leftAt: null, memberCount: 30, ownerId: 'o-c', iconHash: null },
      { id: GD, name: 'Star Camp', botPresent: true, joinedAt: daysAgo(4), leftAt: null, memberCount: 40, ownerId: 'o-d', iconHash: null },
      { id: GE, name: 'Nova Reserve', botPresent: true, joinedAt: daysAgo(5), leftAt: null, memberCount: 50, ownerId: 'o-e', iconHash: null },
      { id: GF, name: 'Old Gone', botPresent: false, joinedAt: daysAgo(6), leftAt: daysAgo(1), memberCount: 5, ownerId: 'o-f', iconHash: null },
    ];
  }

  const lastActivity = daysAgo(0.04); // ~1h ago

  function aggregateOverrides(guilds: ReturnType<typeof guildRows>) {
    return {
      guild: { findMany: fakeFindMany(guilds) },
      pluginState: {
        groupBy: fakeGroupBy([
          { guildId: GA, enabled: true },
          { guildId: GA, enabled: true },
        ]),
      },
      moderationCase: {
        groupBy: fakeGroupBy([
          { guildId: GA, createdAt: daysAgo(2) },
          { guildId: GA, createdAt: daysAgo(10) },
        ]),
      },
      ticket: { groupBy: fakeGroupBy([{ guildId: GA, status: 'OPEN' }]) },
      auditLog: {
        groupBy: fakeGroupBy([
          { guildId: GA, createdAt: daysAgo(0.08) }, // ~2h ago
          { guildId: GA, createdAt: lastActivity }, // ~1h ago — the max
        ]),
      },
    };
  }

  it('lists guilds newest-joined first with per-guild aggregates on the first row', async () => {
    const { app, cookieHeader } = await ownerContext(aggregateOverrides(guildRows()));

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/guilds?limit=10',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([GA, GB, GC, GD, GE, GF]);

    const first = body.items[0];
    expect(first.id).toBe(GA);
    expect(first.pluginsEnabled).toBe(2);
    expect(first.moderationCases30d).toBe(2);
    expect(first.ticketsOpen).toBe(1);
    expect(first.lastActivityAt).toBe(lastActivity.toISOString());

    const second = body.items[1];
    expect(second.pluginsEnabled).toBe(0);
    expect(second.moderationCases30d).toBe(0);
    expect(second.ticketsOpen).toBe(0);
    expect(second.lastActivityAt).toBeNull();
    await app.close();
  });

  it('filters by name substring (case-insensitive) via ?query=', async () => {
    const { app, cookieHeader } = await ownerContext(aggregateOverrides(guildRows()));

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/guilds?query=nova&limit=10',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([GA, GB, GE]);
    await app.close();
  });

  it('filters by botPresent', async () => {
    const { app, cookieHeader } = await ownerContext(aggregateOverrides(guildRows()));

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/guilds?botPresent=false&limit=10',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([GF]);
    await app.close();
  });

  it('paginates with a stable cursor across 3 pages of 2', async () => {
    const { app, cookieHeader } = await ownerContext(aggregateOverrides(guildRows()));

    const page1 = await app.inject({
      method: 'GET',
      url: '/owner/metrics/guilds?limit=2',
      headers: { cookie: cookieHeader },
    });
    const body1 = page1.json();
    expect(body1.items.map((i: { id: string }) => i.id)).toEqual([GA, GB]);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await app.inject({
      method: 'GET',
      url: `/owner/metrics/guilds?limit=2&cursor=${body1.nextCursor}`,
      headers: { cookie: cookieHeader },
    });
    const body2 = page2.json();
    expect(body2.items.map((i: { id: string }) => i.id)).toEqual([GC, GD]);
    expect(body2.nextCursor).not.toBeNull();

    const page3 = await app.inject({
      method: 'GET',
      url: `/owner/metrics/guilds?limit=2&cursor=${body2.nextCursor}`,
      headers: { cookie: cookieHeader },
    });
    const body3 = page3.json();
    expect(body3.items.map((i: { id: string }) => i.id)).toEqual([GE, GF]);
    expect(body3.nextCursor).toBeNull();

    await app.close();
  });
});

describe('GET /owner/metrics/errors', () => {
  const GUILD_1 = '700000000000000401';
  const GUILD_2 = '700000000000000402';

  const t = {
    dataRequest: daysAgo(0),
    webhook: new Date(Date.now() - 60_000),
    job1: new Date(Date.now() - 120_000),
    integration: new Date(Date.now() - 180_000),
    job2: new Date(Date.now() - 240_000),
  };

  function sourceOverrides() {
    return {
      integrationConnection: {
        findMany: fakeFindMany([
          {
            id: 'ic1',
            guildId: GUILD_1,
            lastError: 'OAuth token expired',
            updatedAt: t.integration,
            provider: 'TWITCH',
            label: null,
            status: 'ERROR',
            externalAccountName: 'someuser',
            guild: { name: 'Guild One' },
          },
          { id: 'ic2', guildId: GUILD_2, lastError: null, updatedAt: daysAgo(0), guild: { name: 'Guild Two' } },
        ]),
      },
      scheduledJob: {
        findMany: fakeFindMany([
          {
            id: 'sj1',
            guildId: GUILD_1,
            lastError: 'Job failed: timeout',
            updatedAt: t.job1,
            type: 'reminder-flush',
            pluginId: 'reminders',
            attempts: 3,
            status: 'FAILED',
            guild: { name: 'Guild One' },
          },
          {
            id: 'sj2',
            guildId: null,
            lastError: 'Global cron failed',
            updatedAt: t.job2,
            type: 'cleanup',
            pluginId: 'core',
            attempts: 1,
            status: 'FAILED',
            guild: null,
          },
        ]),
      },
      webhookDelivery: {
        findMany: fakeFindMany([
          {
            id: 'wd1',
            error: 'HTTP 500 from provider',
            createdAt: t.webhook,
            endpointId: 'we1',
            direction: 'OUTBOUND',
            status: 500,
            attempt: 2,
            endpoint: { guildId: GUILD_2, provider: 'github', guild: { name: 'Guild Two' } },
          },
        ]),
      },
      dataRequest: {
        findMany: fakeFindMany([
          {
            id: 'dr1',
            guildId: GUILD_2,
            error: 'Export failed: storage quota exceeded',
            updatedAt: t.dataRequest,
            type: 'EXPORT',
            status: 'FAILED',
            requestedBy: 'user-1',
            guild: { name: 'Guild Two' },
          },
        ]),
      },
    };
  }

  it('merges all four sources into one feed, newest first', async () => {
    const { app, cookieHeader } = await ownerContext(sourceOverrides());

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/errors?limit=10',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([
      'data-request:dr1',
      'webhook:wd1',
      'job:sj1',
      'integration:ic1',
      'job:sj2',
    ]);

    const job2 = body.items.find((i: { id: string }) => i.id === 'job:sj2');
    expect(job2.guildId).toBeNull();
    expect(job2.guildName).toBeNull();
    expect(job2.context).toMatchObject({ jobType: 'cleanup', pluginId: 'core', attempts: 1 });

    const webhook = body.items.find((i: { id: string }) => i.id === 'webhook:wd1');
    expect(webhook.guildId).toBe(GUILD_2);
    expect(webhook.guildName).toBe('Guild Two');
    expect(webhook.context).toMatchObject({ endpointId: 'we1', provider: 'github', httpStatus: 500, attempt: 2 });

    await app.close();
  });

  it('restricts to one source via ?source= and never queries the others', async () => {
    const { app, cookieHeader, prismaCalls } = await ownerContext(sourceOverrides());

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/errors?source=job&limit=10',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual(['job:sj1', 'job:sj2']);

    const calledModels = new Set(prismaCalls.map((c) => c.model));
    expect(calledModels.has('scheduledJob')).toBe(true);
    expect(calledModels.has('integrationConnection')).toBe(false);
    expect(calledModels.has('webhookDelivery')).toBe(false);
    expect(calledModels.has('dataRequest')).toBe(false);
    await app.close();
  });

  it('filters by guildId across sources, including the nested webhook endpoint relation', async () => {
    const { app, cookieHeader } = await ownerContext(sourceOverrides());

    const res = await app.inject({
      method: 'GET',
      url: `/owner/metrics/errors?guildId=${GUILD_2}&limit=10`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual(['data-request:dr1', 'webhook:wd1']);
    await app.close();
  });
});

describe('GET /owner/metrics/growth', () => {
  it('buckets joins/leaves by UTC day, zero-filling days with no events, with a running netTotal', async () => {
    const since = new Date(
      Date.UTC(daysAgo(9).getUTCFullYear(), daysAgo(9).getUTCMonth(), daysAgo(9).getUTCDate()),
    );
    const day = (n: number) => new Date(since.getTime() + n * DAY_MS);

    const guilds = [
      { joinedAt: day(0), leftAt: null },
      { joinedAt: day(3), leftAt: null },
      { joinedAt: day(3), leftAt: null },
      { joinedAt: day(9), leftAt: null },
      { joinedAt: daysAgo(500), leftAt: null }, // outside the window — must not appear
    ];
    const leavers = [{ joinedAt: daysAgo(500), leftAt: day(3) }];

    const { app, cookieHeader } = await ownerContext({
      guild: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany: async (args: any) =>
          args?.where && 'joinedAt' in args.where
            ? guilds.filter((g) => g.joinedAt.getTime() >= since.getTime())
            : leavers.filter((g) => g.leftAt.getTime() >= since.getTime()),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/growth?days=10',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const points = res.json().points;
    expect(points).toHaveLength(10);
    expect(points.map((p: { date: string }) => p.date)).toEqual([
      toUtcDateString(day(0)),
      toUtcDateString(day(1)),
      toUtcDateString(day(2)),
      toUtcDateString(day(3)),
      toUtcDateString(day(4)),
      toUtcDateString(day(5)),
      toUtcDateString(day(6)),
      toUtcDateString(day(7)),
      toUtcDateString(day(8)),
      toUtcDateString(day(9)),
    ]);

    expect(points[0]).toMatchObject({ joined: 1, left: 0, netTotal: 1 });
    expect(points[3]).toMatchObject({ joined: 2, left: 1, netTotal: 2 });
    expect(points[9]).toMatchObject({ joined: 1, left: 0, netTotal: 3 });
    // Every in-between zero-event day just carries the running total forward.
    expect(points[1]).toMatchObject({ joined: 0, left: 0, netTotal: 1 });
    expect(points[8]).toMatchObject({ joined: 0, left: 0, netTotal: 2 });

    await app.close();
  });

  it('defaults to 30 days when no ?days= is given', async () => {
    const { app, cookieHeader } = await ownerContext({});
    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/growth',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toHaveLength(30);
    await app.close();
  });

  it('clamps ?days= below 1 up to 1', async () => {
    const { app, cookieHeader } = await ownerContext({});
    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/growth?days=0',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const points = res.json().points;
    expect(points).toHaveLength(1);
    expect(points[0].date).toBe(toUtcDateString(new Date()));
    await app.close();
  });

  it('clamps ?days= above 365 down to 365', async () => {
    const { app, cookieHeader } = await ownerContext({});
    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/growth?days=99999',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toHaveLength(365);
    await app.close();
  });
});


describe('GET /owner/metrics/usage', () => {
  it('sums the per-guild daily rollup across the whole fleet, zero-filling quiet days', async () => {
    const since = new Date(
      Date.UTC(daysAgo(4).getUTCFullYear(), daysAgo(4).getUTCMonth(), daysAgo(4).getUTCDate()),
    );
    const day = (n: number) => new Date(since.getTime() + n * DAY_MS);

    // Two guilds reporting on day 0, one on day 2, nothing on days 1/3/4 — the route groups in
    // the DB, so the fixture returns what `groupBy` would: one row per day, already summed.
    const grouped = [
      {
        date: day(0),
        _sum: { messages: 30, moderationActions: 4, automodTriggers: 2, ticketsOpened: 1, joins: 3, leaves: 1 },
      },
      {
        date: day(2),
        _sum: { messages: 12, moderationActions: 0, automodTriggers: 1, ticketsOpened: 0, joins: 0, leaves: 2 },
      },
    ];

    const { app, cookieHeader } = await ownerContext({
      guildAnalyticsDaily: {
        groupBy: async () => grouped,
        findMany: async () => [{ guildId: 'g1' }, { guildId: 'g2' }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/usage?days=5',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.points).toHaveLength(5);
    expect(body.points[0]).toMatchObject({ date: toUtcDateString(day(0)), messages: 30, joins: 3, leaves: 1 });
    // A day with no rows must still appear, at zero, so the client can plot a continuous series.
    expect(body.points[1]).toMatchObject({ date: toUtcDateString(day(1)), messages: 0, moderationActions: 0 });
    expect(body.points[2]).toMatchObject({ date: toUtcDateString(day(2)), messages: 12, leaves: 2 });

    expect(body.totals).toMatchObject({
      messages: 42,
      moderationActions: 4,
      automodTriggers: 3,
      ticketsOpened: 1,
      joins: 3,
      leaves: 3,
      activeGuilds: 2,
    });
  });

  it('clamps an out-of-range days value instead of rejecting it', async () => {
    const { app, cookieHeader } = await ownerContext({
      guildAnalyticsDaily: { groupBy: async () => [], findMany: async () => [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await app.inject({
      method: 'GET',
      url: '/owner/metrics/usage?days=0',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().points).toHaveLength(1);
  });
});
