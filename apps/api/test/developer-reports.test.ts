import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTestApp, loginAs } from './helpers/build-test-app';

// See bot-owner.test.ts for why setting this directly (rather than mutating `@pavisie/core`'s `env`) is safe
// and sufficient — `requireBotOwner` re-reads `process.env.BOT_OWNER_IDS` on every request.
process.env.BOT_OWNER_IDS = 'owner-1';

interface FakeReport {
  id: string;
  guildId: string;
  guildName: string;
  senderId: string;
  senderTag: string;
  kind: string;
  subject: string;
  body: string;
  botVersion: string;
  status: string;
  notes: string | null;
  handledAt: Date | null;
  handledBy: string | null;
  createdAt: Date;
}

function developerReportOverrides() {
  const rows = new Map<string, FakeReport>();
  return {
    rows,
    overrides: {
      developerReport: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany: async (args: any) => {
          let list = [...rows.values()];
          if (args?.where?.status) list = list.filter((r) => r.status === args.where.status);
          if (args?.where?.kind) list = list.filter((r) => r.kind === args.where.kind);
          if (args?.where?.guildId) list = list.filter((r) => r.guildId === args.where.guildId);
          list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          const skip = args?.skip ?? 0;
          const take = args?.take ?? list.length;
          return list.slice(skip, skip + take);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findUnique: async (args: any) => rows.get(args.where.id) ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: async (args: any) => {
          const existing = rows.get(args.where.id);
          if (!existing) throw new Error('DeveloperReport not found');
          const updated: FakeReport = { ...existing, ...args.data };
          rows.set(args.where.id, updated);
          return updated;
        },
      },
    },
  };
}

function seedReport(rows: Map<string, FakeReport>, patch: Partial<FakeReport> = {}): FakeReport {
  const row: FakeReport = {
    id: randomUUID(),
    guildId: '111111111111111111',
    guildName: 'Test Guild',
    senderId: 'admin-1',
    senderTag: 'admin-1#0001',
    kind: 'BUG',
    subject: 'Something broke',
    body: 'Steps to reproduce...',
    botVersion: '0.1.0',
    status: 'OPEN',
    notes: null,
    handledAt: null,
    handledBy: null,
    createdAt: new Date(),
    ...patch,
  };
  rows.set(row.id, row);
  return row;
}

async function ownerContext(overrides: ReturnType<typeof developerReportOverrides>['overrides']) {
  const { app, redis } = await buildTestApp(overrides);
  const { cookieHeader, session } = await loginAs(app, redis, { userId: 'owner-1' });
  const mutHeaders = { cookie: cookieHeader, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken };
  return { app, cookieHeader, mutHeaders };
}

describe('GET /owner/developer-reports', () => {
  it('lists reports newest-first', async () => {
    const { rows, overrides } = developerReportOverrides();
    const older = seedReport(rows, { createdAt: new Date('2026-01-01T00:00:00Z') });
    const newer = seedReport(rows, { createdAt: new Date('2026-01-02T00:00:00Z') });
    const { app, cookieHeader } = await ownerContext(overrides);

    const res = await app.inject({
      method: 'GET',
      url: '/owner/developer-reports',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(res.json().items.map((i: any) => i.id)).toEqual([newer.id, older.id]);
    await app.close();
  });

  it('filters by kind, status, and guildId', async () => {
    const GUILD_1 = '111111111111111111';
    const GUILD_2 = '222222222222222222';
    const { rows, overrides } = developerReportOverrides();
    const bug = seedReport(rows, { kind: 'BUG', status: 'OPEN', guildId: GUILD_1 });
    seedReport(rows, { kind: 'FEEDBACK', status: 'OPEN', guildId: GUILD_1 });
    seedReport(rows, { kind: 'BUG', status: 'HANDLED', guildId: GUILD_1 });
    seedReport(rows, { kind: 'BUG', status: 'OPEN', guildId: GUILD_2 });
    const { app, cookieHeader } = await ownerContext(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/owner/developer-reports?kind=BUG&status=OPEN&guildId=${GUILD_1}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(res.json().items.map((i: any) => i.id)).toEqual([bug.id]);
    await app.close();
  });
});

describe('GET /owner/developer-reports/:id', () => {
  it('returns 404 for an unknown id', async () => {
    const { overrides } = developerReportOverrides();
    const { app, cookieHeader } = await ownerContext(overrides);

    const res = await app.inject({
      method: 'GET',
      url: '/owner/developer-reports/does-not-exist',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns the full report (subject, body, sender, routing metadata) for a known id', async () => {
    const { rows, overrides } = developerReportOverrides();
    const row = seedReport(rows);
    const { app, cookieHeader } = await ownerContext(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/owner/developer-reports/${row.id}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: row.id,
      guildId: row.guildId,
      guildName: row.guildName,
      senderId: row.senderId,
      senderTag: row.senderTag,
      kind: row.kind,
      subject: row.subject,
      body: row.body,
      status: 'OPEN',
    });
    await app.close();
  });
});

describe('PATCH /owner/developer-reports/:id', () => {
  it('marks a report handled, stamping handledAt/handledBy from the acting owner session', async () => {
    const { rows, overrides } = developerReportOverrides();
    const row = seedReport(rows);
    const { app, mutHeaders } = await ownerContext(overrides);

    const res = await app.inject({
      method: 'PATCH',
      url: `/owner/developer-reports/${row.id}`,
      headers: mutHeaders,
      payload: { status: 'HANDLED' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('HANDLED');
    expect(body.handledBy).toBe('owner-1');
    expect(body.handledAt).not.toBeNull();
    await app.close();
  });

  it('marking a report open again clears handledAt/handledBy', async () => {
    const { rows, overrides } = developerReportOverrides();
    const row = seedReport(rows, { status: 'HANDLED', handledAt: new Date(), handledBy: 'owner-1' });
    const { app, mutHeaders } = await ownerContext(overrides);

    const res = await app.inject({
      method: 'PATCH',
      url: `/owner/developer-reports/${row.id}`,
      headers: mutHeaders,
      payload: { status: 'OPEN' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('OPEN');
    expect(body.handledBy).toBeNull();
    expect(body.handledAt).toBeNull();
    await app.close();
  });

  it('saves an internal note independently of status', async () => {
    const { rows, overrides } = developerReportOverrides();
    const row = seedReport(rows);
    const { app, mutHeaders } = await ownerContext(overrides);

    const res = await app.inject({
      method: 'PATCH',
      url: `/owner/developer-reports/${row.id}`,
      headers: mutHeaders,
      payload: { notes: 'Reproduced locally, fix queued.' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.notes).toBe('Reproduced locally, fix queued.');
    expect(body.status).toBe('OPEN');
    await app.close();
  });

  it('returns 404 for an unknown id', async () => {
    const { overrides } = developerReportOverrides();
    const { app, mutHeaders } = await ownerContext(overrides);

    const res = await app.inject({
      method: 'PATCH',
      url: '/owner/developer-reports/does-not-exist',
      headers: mutHeaders,
      payload: { status: 'HANDLED' },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a request missing the CSRF header even from a real bot-owner session', async () => {
    const { rows, overrides } = developerReportOverrides();
    const row = seedReport(rows);
    const { app, cookieHeader } = await ownerContext(overrides);

    const res = await app.inject({
      method: 'PATCH',
      url: `/owner/developer-reports/${row.id}`,
      headers: { cookie: cookieHeader },
      payload: { status: 'HANDLED' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
