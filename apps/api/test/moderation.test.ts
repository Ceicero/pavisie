import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '111111111111111111';
const USER_ID = '222222222222222222';

interface FakeCase {
  id: string;
  guildId: string;
  caseNumber: number;
  type: string;
  targetId: string;
  moderatorId: string;
  reason: string | null;
  evidenceUrls: string[];
  durationMs: number | null;
  expiresAt: Date | null;
  expiredAt: Date | null;
  dmSent: boolean;
  metadata: Record<string, unknown>;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface FakeNote {
  id: string;
  guildId: string;
  userId: string;
  authorId: string;
  content: string;
  createdAt: Date;
  deletedAt: Date | null;
}

interface FakeAppeal {
  id: string;
  guildId: string;
  caseId: string | null;
  userId: string;
  content: string;
  status: 'PENDING' | 'ACCEPTED' | 'DENIED';
  reviewedBy: string | null;
  reviewedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}

/** Minimal stateful fakes mirroring the Prisma delegate methods `routes/moderation.ts` uses. */
function moderationOverrides() {
  const cases = new Map<string, FakeCase>();
  const notes = new Map<string, FakeNote>();
  const appeals = new Map<string, FakeAppeal>();
  const pluginConfig = new Map<string, Record<string, unknown>>();

  return {
    store: { cases, notes, appeals, pluginConfig },
    overrides: {
      moderationCase: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany: async (args: any) => {
          let list = [...cases.values()].filter(
            (c) => c.guildId === args?.where?.guildId && c.deletedAt === null,
          );
          if (args?.where?.type) list = list.filter((c) => c.type === args.where.type);
          if (args?.where?.targetId) list = list.filter((c) => c.targetId === args.where.targetId);
          list = list.sort((a, b) => b.caseNumber - a.caseNumber);
          return list.slice(args?.skip ?? 0, (args?.skip ?? 0) + (args?.take ?? list.length));
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findUnique: async (args: any) => {
          const key = args?.where?.guildId_caseNumber;
          if (key)
            return (
              [...cases.values()].find((c) => c.guildId === key.guildId && c.caseNumber === key.caseNumber) ??
              null
            );
          return cases.get(args?.where?.id) ?? null;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: async (args: any) => {
          const key = args.where.guildId_caseNumber;
          const existing = key
            ? [...cases.values()].find((c) => c.guildId === key.guildId && c.caseNumber === key.caseNumber)
            : cases.get(args.where.id);
          if (!existing) throw new Error('not found');
          const updated = { ...existing, ...args.data };
          cases.set(existing.id, updated);
          return updated;
        },
      },
      moderationNote: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany: async (args: any) => {
          let list = [...notes.values()].filter(
            (n) => n.guildId === args?.where?.guildId && n.deletedAt === null,
          );
          if (args?.where?.userId) list = list.filter((n) => n.userId === args.where.userId);
          return list;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: async (args: any) => {
          const row: FakeNote = { id: randomUUID(), createdAt: new Date(), deletedAt: null, ...args.data };
          notes.set(row.id, row);
          return row;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findFirst: async (args: any) => {
          const found = notes.get(args?.where?.id);
          if (!found || found.guildId !== args?.where?.guildId) return null;
          if (args?.where?.deletedAt === null && found.deletedAt !== null) return null;
          return found;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: async (args: any) => {
          const existing = notes.get(args.where.id);
          if (!existing) throw new Error('not found');
          const updated = { ...existing, ...args.data };
          notes.set(existing.id, updated);
          return updated;
        },
      },
      moderationAppeal: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany: async (args: any) => {
          let list = [...appeals.values()].filter((a) => a.guildId === args?.where?.guildId);
          if (args?.where?.status) list = list.filter((a) => a.status === args.where.status);
          return list;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findFirst: async (args: any) => {
          const found = appeals.get(args?.where?.id);
          if (!found || found.guildId !== args?.where?.guildId) return null;
          return found;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: async (args: any) => {
          const existing = appeals.get(args.where.id);
          if (!existing) throw new Error('not found');
          const updated = { ...existing, ...args.data };
          appeals.set(existing.id, updated);
          return updated;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateMany: async (args: any) => {
          const existing = appeals.get(args.where.id);
          if (!existing || existing.guildId !== args.where.guildId) return { count: 0 };
          if (args.where.status && existing.status !== args.where.status) return { count: 0 };
          appeals.set(existing.id, { ...existing, ...args.data });
          return { count: 1 };
        },
      },
      pluginConfig: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findUnique: async (args: any) => {
          const key = `${args.where.guildId_pluginId.guildId}:${args.where.guildId_pluginId.pluginId}`;
          const config = pluginConfig.get(key);
          return config
            ? {
                guildId: args.where.guildId_pluginId.guildId,
                pluginId: args.where.guildId_pluginId.pluginId,
                config,
                version: 1,
              }
            : null;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        upsert: async (args: any) => {
          const key = `${args.where.guildId_pluginId.guildId}:${args.where.guildId_pluginId.pluginId}`;
          const config = (args.create?.config ?? args.update?.config) as Record<string, unknown>;
          pluginConfig.set(key, config);
          return {
            guildId: args.where.guildId_pluginId.guildId,
            pluginId: args.where.guildId_pluginId.pluginId,
            config,
            version: 1,
          };
        },
      },
    },
  };
}

async function authedContext() {
  const { store, overrides } = moderationOverrides();
  const { app, redis } = await buildTestApp({
    guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    ...overrides,
  });
  const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  const mutHeaders = {
    cookie: cookieHeader,
    origin: 'http://localhost:3000',
    'x-csrf-token': session.csrfToken,
  };
  return { app, cookieHeader, mutHeaders, store };
}

function seedCase(
  store: ReturnType<typeof moderationOverrides>['store'],
  overrides: Partial<FakeCase> = {},
): FakeCase {
  const row: FakeCase = {
    id: randomUUID(),
    guildId: GUILD_ID,
    caseNumber: 1,
    type: 'WARN',
    targetId: '333333333333333333',
    moderatorId: '444444444444444444',
    reason: 'Being rude',
    evidenceUrls: [],
    durationMs: null,
    expiresAt: null,
    expiredAt: null,
    dmSent: false,
    metadata: {},
    source: 'BOT',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
  store.cases.set(row.id, row);
  return row;
}

describe('moderation cases', () => {
  it('GET lists cases newest-first', async () => {
    const { app, cookieHeader, store } = await authedContext();
    seedCase(store, { caseNumber: 1 });
    seedCase(store, { caseNumber: 2 });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/moderation/cases`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((c: { caseNumber: number }) => c.caseNumber)).toEqual([2, 1]);
    await app.close();
  });

  it('GET /:caseNumber 404s for an unknown case', async () => {
    const { app, cookieHeader } = await authedContext();
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/moderation/cases/999`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH updates the reason and writes an audit entry', async () => {
    const { app, mutHeaders, store } = await authedContext();
    seedCase(store, { caseNumber: 7, reason: 'old reason' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/moderation/cases/7`,
      headers: mutHeaders,
      payload: { reason: 'corrected reason' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('corrected reason');
    await app.close();
  });

  it('export.csv returns CSV with a header row', async () => {
    const { app, cookieHeader, store } = await authedContext();
    seedCase(store, { caseNumber: 1 });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/moderation/cases/export.csv`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.split('\r\n')[0]).toBe(
      'caseNumber,type,targetId,moderatorId,reason,durationMs,source,createdAt',
    );
    await app.close();
  });
});

describe('moderation notes', () => {
  it('POST creates a note, GET lists it, DELETE soft-deletes it', async () => {
    const { app, mutHeaders, cookieHeader } = await authedContext();

    const created = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/moderation/notes`,
      headers: mutHeaders,
      payload: { userId: '333333333333333333', content: 'Watch this one.' },
    });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().id;

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/moderation/notes`,
      headers: { cookie: cookieHeader },
    });
    expect(list.json().items).toHaveLength(1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/moderation/notes/${noteId}`,
      headers: mutHeaders,
    });
    expect(del.statusCode).toBe(204);

    const listAfter = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/moderation/notes`,
      headers: { cookie: cookieHeader },
    });
    expect(listAfter.json().items).toHaveLength(0);
    await app.close();
  });
});

describe('moderation appeals', () => {
  it('POST decide accepts an appeal and rejects deciding it twice', async () => {
    const { app, mutHeaders, store } = await authedContext();
    const appealId = randomUUID();
    store.appeals.set(appealId, {
      id: appealId,
      guildId: GUILD_ID,
      caseId: null,
      userId: '333333333333333333',
      content: 'Please reconsider.',
      status: 'PENDING',
      reviewedBy: null,
      reviewedAt: null,
      decisionNote: null,
      createdAt: new Date(),
    });

    const first = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/moderation/appeals/${appealId}/decide`,
      headers: mutHeaders,
      payload: { accept: true, decisionNote: 'Fair point.' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('ACCEPTED');

    const second = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/moderation/appeals/${appealId}/decide`,
      headers: mutHeaders,
      payload: { accept: false },
    });
    expect(second.statusCode).toBe(404);
    await app.close();
  });

  it('only one of two concurrent decisions wins', async () => {
    const { app, mutHeaders, store } = await authedContext();
    const appealId = randomUUID();
    store.appeals.set(appealId, {
      id: appealId,
      guildId: GUILD_ID,
      caseId: null,
      userId: '333333333333333333',
      content: 'Please reconsider.',
      status: 'PENDING',
      reviewedBy: null,
      reviewedAt: null,
      decisionNote: null,
      createdAt: new Date(),
    });
    const decide = (accept: boolean) =>
      app.inject({
        method: 'POST',
        url: `/guilds/${GUILD_ID}/moderation/appeals/${appealId}/decide`,
        headers: mutHeaders,
        payload: { accept },
      });
    const results = await Promise.all([decide(true), decide(false)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    const winner = results.find((r) => r.statusCode === 200)!;
    expect(store.appeals.get(appealId)!.status).toBe(winner.json().status);
    await app.close();
  });

  it('404s deciding an unknown appeal', async () => {
    const { app, mutHeaders } = await authedContext();
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/moderation/appeals/does-not-exist/decide`,
      headers: mutHeaders,
      payload: { accept: true },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('moderation settings', () => {
  it('GET returns defaults, PUT persists a change and GET reflects it', async () => {
    const { app, mutHeaders, cookieHeader } = await authedContext();

    const initial = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/moderation/settings`,
      headers: { cookie: cookieHeader },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      purgeMax: 100,
      tempBanEnabled: true,
      dmOnAction: true,
      requireReasonFor: [],
    });

    const updated = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/moderation/settings`,
      headers: mutHeaders,
      payload: { purgeMax: 25, requireReasonFor: ['ban'] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().purgeMax).toBe(25);
    expect(updated.json().requireReasonFor).toEqual(['ban']);

    const after = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/moderation/settings`,
      headers: { cookie: cookieHeader },
    });
    expect(after.json().purgeMax).toBe(25);
    await app.close();
  });
});
