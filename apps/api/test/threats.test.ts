import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';
import { caseFieldsFromAfter, isModerationAuditAction } from '../src/routes/threats';
import { listThreatIncidents, setThreatIncidentSourceForTests } from '../src/lib/threat-incidents';
import { fixtureThreatIncidentSource, threatIncidentFixtures } from './fixtures/threat-incidents';
import type { ThreatIncidentDto, ThreatIncidentKind, ThreatIncidentStatus } from '@pavisie/types';

const GUILD_ID = '111111111111111111';
const OTHER_GUILD = '999999999999999999';
const USER_ID = '222222222222222222';

interface FakeAudit {
  id: string;
  guildId: string;
  actorId: string;
  actorType: 'USER' | 'SYSTEM';
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  source: 'BOT' | 'DASHBOARD' | 'SYSTEM';
  createdAt: Date;
}

function auditRow(overrides: Partial<FakeAudit> & Pick<FakeAudit, 'id' | 'action'>): FakeAudit {
  return {
    guildId: GUILD_ID,
    actorId: USER_ID,
    actorType: 'USER',
    targetType: null,
    targetId: null,
    before: null,
    after: null,
    reason: null,
    source: 'BOT',
    createdAt: new Date('2026-11-13T20:00:00.000Z'),
    ...overrides,
  };
}

/** Stateful `auditLog.findMany` that honours `startsWith`, exact `action`, `actorId`, skip/take, and createdAt desc. */
function auditOverrides(rows: FakeAudit[]) {
  return {
    guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    auditLog: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async (args: any) => {
        const where = args?.where ?? {};
        let list = rows.filter((r) => r.guildId === where.guildId);
        const action = where.action;
        if (typeof action === 'string') {
          list = list.filter((r) => r.action === action);
        } else if (action && typeof action.startsWith === 'string') {
          list = list.filter((r) => r.action.startsWith(action.startsWith));
        }
        if (where.actorId) list = list.filter((r) => r.actorId === where.actorId);
        list = list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const skip = args?.skip ?? 0;
        const take = args?.take ?? list.length;
        return list.slice(skip, skip + take);
      },
    },
  };
}

const SEED: FakeAudit[] = [
  auditRow({
    id: 'a1',
    action: 'moderation.case.create',
    targetType: 'moderation_case',
    targetId: 'case-1',
    after: { type: 'BAN', targetId: '333', caseNumber: 7 },
    reason: 'raid lead',
    createdAt: new Date('2026-11-13T20:05:00.000Z'),
  }),
  auditRow({
    id: 'a2',
    action: 'moderation.note.create',
    targetType: 'user',
    targetId: '333',
    createdAt: new Date('2026-11-13T20:04:00.000Z'),
  }),
  auditRow({
    id: 'a3',
    action: 'moderation.settings.update',
    source: 'DASHBOARD',
    createdAt: new Date('2026-11-13T20:03:00.000Z'),
  }),
  auditRow({
    id: 'a4',
    action: 'moderation.note.delete',
    createdAt: new Date('2026-11-13T20:02:00.000Z'),
  }),
  auditRow({
    id: 'a5',
    action: 'plugin.enable',
    createdAt: new Date('2026-11-13T20:01:00.000Z'),
  }),
  auditRow({
    id: 'a6',
    action: 'moderation.case.create',
    guildId: OTHER_GUILD,
    after: { type: 'KICK', caseNumber: 1 },
    createdAt: new Date('2026-11-13T20:06:00.000Z'),
  }),
  auditRow({
    id: 'a7',
    action: 'moderation.warning.clear',
    actorId: '444444444444444444',
    createdAt: new Date('2026-11-13T20:00:00.000Z'),
  }),
];

async function authed(rows: FakeAudit[] = SEED) {
  const { app, redis } = await buildTestApp(auditOverrides(rows));
  const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  return { app, redis, cookieHeader };
}

describe('isModerationAuditAction / caseFieldsFromAfter', () => {
  it('accepts every moderation.* action and rejects others', () => {
    expect(isModerationAuditAction('moderation.case.create')).toBe(true);
    expect(isModerationAuditAction('moderation.case.update')).toBe(true);
    expect(isModerationAuditAction('moderation.note.create')).toBe(true);
    expect(isModerationAuditAction('moderation.note.delete')).toBe(true);
    expect(isModerationAuditAction('moderation.settings.update')).toBe(true);
    expect(isModerationAuditAction('plugin.enable')).toBe(false);
    expect(isModerationAuditAction('automod.rule.create')).toBe(false);
    expect(isModerationAuditAction('moderation')).toBe(false);
  });

  it('reads caseNumber and caseType from a case.create after payload', () => {
    expect(caseFieldsFromAfter({ type: 'BAN', targetId: 'x', caseNumber: 7 })).toEqual({
      caseNumber: 7,
      caseType: 'BAN',
    });
  });

  it('ignores missing, non-integer, or non-object after payloads', () => {
    expect(caseFieldsFromAfter(undefined)).toEqual({});
    expect(caseFieldsFromAfter(null)).toEqual({});
    expect(caseFieldsFromAfter('nope')).toEqual({});
    expect(caseFieldsFromAfter({ caseNumber: 1.5, type: '' })).toEqual({});
    expect(caseFieldsFromAfter({ caseNumber: 0, type: 1 })).toEqual({});
  });
});

describe('GET /guilds/:guildId/threats/audit', () => {
  it('401s with no session', async () => {
    const { app } = await buildTestApp(auditOverrides(SEED));
    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/threats/audit` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('403s when the user cannot manage the guild', async () => {
    const { app, redis } = await buildTestApp(auditOverrides(SEED));
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: false, permissions: '0' }]);
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/audit`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns only moderation.* rows for this guild, newest first, and enriches case.create', async () => {
    const { app, cookieHeader } = await authed();
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/audit`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((r: { id: string; action: string }) => [r.id, r.action])).toEqual([
      ['a1', 'moderation.case.create'],
      ['a2', 'moderation.note.create'],
      ['a3', 'moderation.settings.update'],
      ['a4', 'moderation.note.delete'],
      ['a7', 'moderation.warning.clear'],
    ]);
    expect(body.items[0]).toMatchObject({
      id: 'a1',
      caseNumber: 7,
      caseType: 'BAN',
      reason: 'raid lead',
    });
    expect(body.items[1].caseNumber).toBeUndefined();
    expect(body.nextCursor).toBeNull();
    await app.close();
  });

  it('returns an empty page when there are no moderation audit rows', async () => {
    const { app, cookieHeader } = await authed([
      auditRow({ id: 'p', action: 'plugin.enable' }),
    ]);
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/audit`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], nextCursor: null });
    await app.close();
  });

  it('filters by an exact moderation action and rejects a non-moderation action with an empty page', async () => {
    const { app, cookieHeader } = await authed();
    const notes = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/audit?action=moderation.note.create`,
      headers: { cookie: cookieHeader },
    });
    expect(notes.statusCode).toBe(200);
    expect(notes.json().items).toHaveLength(1);
    expect(notes.json().items[0].id).toBe('a2');

    const leaked = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/audit?action=plugin.enable`,
      headers: { cookie: cookieHeader },
    });
    expect(leaked.statusCode).toBe(200);
    expect(leaked.json().items).toEqual([]);
    await app.close();
  });

  it('filters by actorId', async () => {
    const { app, cookieHeader } = await authed();
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/audit?actorId=444444444444444444`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((r: { id: string }) => r.id)).toEqual(['a7']);
    await app.close();
  });

  it('paginates with cursor and limit', async () => {
    const { app, cookieHeader } = await authed();
    const first = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/audit?limit=2`,
      headers: { cookie: cookieHeader },
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.items.map((r: { id: string }) => r.id)).toEqual(['a1', 'a2']);
    expect(typeof page1.nextCursor).toBe('string');

    const second = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/audit?limit=2&cursor=${page1.nextCursor}`,
      headers: { cookie: cookieHeader },
    });
    expect(second.statusCode).toBe(200);
    const page2 = second.json();
    expect(page2.items.map((r: { id: string }) => r.id)).toEqual(['a3', 'a4']);
    expect(typeof page2.nextCursor).toBe('string');

    const third = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/audit?limit=2&cursor=${page2.nextCursor}`,
      headers: { cookie: cookieHeader },
    });
    expect(third.json().items.map((r: { id: string }) => r.id)).toEqual(['a7']);
    expect(third.json().nextCursor).toBeNull();
    await app.close();
  });
});

const KINDS: ThreatIncidentKind[] = ['raid', 'message_burst', 'lockdown'];
const STATUSES: ThreatIncidentStatus[] = ['active', 'ended'];

afterEach(() => {
  setThreatIncidentSourceForTests(undefined);
});

describe('GET /guilds/:guildId/threats/incidents', () => {
  it('401s with no session', async () => {
    const { app } = await buildTestApp(auditOverrides([]));
    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/threats/incidents` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('403s when the user cannot manage the guild', async () => {
    const { app, redis } = await buildTestApp(auditOverrides([]));
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: false, permissions: '0' }]);
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/incidents`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns an empty list by default — no fixture incidents in production', async () => {
    const { app, cookieHeader } = await authed([]);
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/incidents`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(await listThreatIncidents(GUILD_ID)).toEqual([]);
    await app.close();
  });

  it('returns injected fixtures stamped with this guild id, matching ThreatIncidentDto', async () => {
    setThreatIncidentSourceForTests(fixtureThreatIncidentSource);
    const { app, cookieHeader } = await authed([]);
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/incidents`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as ThreatIncidentDto[];
    const expected = threatIncidentFixtures(GUILD_ID);
    expect(items).toEqual(expected);
    expect(await listThreatIncidents(GUILD_ID)).toEqual(expected);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.guildId).toBe(GUILD_ID);
      expect(KINDS).toContain(item.kind);
      expect(STATUSES).toContain(item.status);
      expect(typeof item.id).toBe('string');
      expect(typeof item.ruleName).toBe('string');
      expect(typeof item.dryRun).toBe('boolean');
      expect(item.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(item.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      if (item.status === 'ended') expect(item.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    await app.close();
  });
});

describe('listThreatIncidents adapter', () => {
  it('returns [] for any guild when no source is injected', async () => {
    expect(await listThreatIncidents('1')).toEqual([]);
    expect(await listThreatIncidents('2')).toEqual([]);
  });

  it('uses the injected fixture source, then restores the empty default', async () => {
    setThreatIncidentSourceForTests(fixtureThreatIncidentSource);
    const a = await listThreatIncidents('1');
    const b = await listThreatIncidents('1');
    const c = await listThreatIncidents('2');
    expect(a).toEqual(b);
    expect(a).toEqual(threatIncidentFixtures('1'));
    expect(a.every((i) => i.guildId === '1')).toBe(true);
    expect(c.every((i) => i.guildId === '2')).toBe(true);
    expect(new Set(a.map((i) => i.kind))).toEqual(new Set(KINDS));

    setThreatIncidentSourceForTests(undefined);
    expect(await listThreatIncidents('1')).toEqual([]);
  });
});
