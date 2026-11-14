import { describe, expect, it } from 'vitest';
import type { PrismaStubOverrides } from '@pavisie/plugins/sdk/testing';
import type { Paginated, RaidModeRiskMemberDto, ThreatIncidentDto } from '@pavisie/types';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';
import { RAID_MODE_RULE_NAME, raidModeIncidentToThreatDtos } from '../src/lib/threat-incidents';

const GUILD_ID = '111111111111111111';
const OTHER_GUILD = '999999999999999999';
const USER_ID = '222222222222222222';

const started = new Date('2026-11-14T10:00:00.000Z');
const later = new Date('2026-11-14T10:05:00.000Z');

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inc-1',
    guildId: GUILD_ID,
    status: 'ACTIVE',
    dryRun: false,
    startedAt: started,
    lastJoinAt: later,
    endedAt: null,
    joinsTotal: 80,
    joinsFlagged: 61,
    riskLow: 10,
    riskMedium: 20,
    riskHigh: 41,
    thresholds: {},
    lockdownState: 'NONE',
    lockdownActions: [],
    lockdownAppliedAt: null,
    lockdownAppliedBy: null,
    lockdownRestoredAt: null,
    lockdownRestoredBy: null,
    reminderSentAt: null,
    alertChannelId: null,
    alertMessageId: null,
    createdAt: started,
    updatedAt: later,
    ...overrides,
  } as never;
}

async function authed(overrides: PrismaStubOverrides) {
  const { app, redis, prismaCalls } = await buildTestApp({
    guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    ...overrides,
  });
  const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  return { app, cookieHeader, prismaCalls };
}

describe('raid mode incidents on the Threat overview (ThreatIncidentDto, unchanged contract)', () => {
  it('maps an active raid to one `raid` incident with counts only', () => {
    expect(raidModeIncidentToThreatDtos(incident())).toEqual([
      {
        id: 'inc-1',
        guildId: GUILD_ID,
        kind: 'raid',
        status: 'active',
        ruleName: RAID_MODE_RULE_NAME,
        dryRun: false,
        startedAt: started.toISOString(),
        lastActivityAt: later.toISOString(),
        joinsFlagged: 61,
      },
    ]);
  });

  it('adds a `lockdown` incident while the lockdown is on, and ends it once restored', () => {
    const locked = raidModeIncidentToThreatDtos(
      incident({
        status: 'ENDED',
        endedAt: later,
        lockdownState: 'LOCKED',
        lockdownAppliedAt: started,
        lockdownActions: ['channel-send-deny', 'raise-verification'],
      }),
    );
    expect(locked[0]).toMatchObject({ kind: 'raid', status: 'ended', endedAt: later.toISOString() });
    expect(locked[1]).toEqual({
      id: 'inc-1:lockdown',
      guildId: GUILD_ID,
      kind: 'lockdown',
      status: 'active',
      ruleName: RAID_MODE_RULE_NAME,
      dryRun: false,
      startedAt: started.toISOString(),
      lastActivityAt: started.toISOString(),
      lockdownAction: 'channel-send-deny, raise-verification',
    });

    const restored = raidModeIncidentToThreatDtos(
      incident({ lockdownState: 'RESTORED', lockdownAppliedAt: started, lockdownRestoredAt: later }),
    );
    expect(restored[1]).toMatchObject({ status: 'ended', endedAt: later.toISOString() });
  });

  it('serves them from GET /threats/incidents, scoped to the guild', async () => {
    const { app, cookieHeader, prismaCalls } = await authed({
      raidModeIncident: { findMany: async () => [incident()] },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/threats/incidents`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as ThreatIncidentDto[];
    expect(items.map((i) => i.kind)).toEqual(['raid']);
    const call = prismaCalls.find((c) => c.model === 'raidModeIncident' && c.method === 'findMany');
    expect((call?.args[0] as { where: { guildId: string } }).where.guildId).toBe(GUILD_ID);
    await app.close();
  });
});

describe('GET /guilds/:guildId/raid-mode/incidents/:incidentId/members', () => {
  const scoreRow = {
    userId: '333333333333333333',
    score: 75,
    reasons: ['account_age_lt_1h', 'bogus'],
    joinedAt: started,
  };

  it('returns member id, score, level and reason codes only', async () => {
    const { app, cookieHeader } = await authed({
      raidModeIncident: { findFirst: async () => ({ id: 'inc-1' }) },
      raidModeRiskScore: { findMany: async () => [scoreRow] },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/raid-mode/incidents/inc-1/members`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Paginated<RaidModeRiskMemberDto>;
    expect(body.items).toEqual([
      {
        userId: scoreRow.userId,
        score: 75,
        level: 'high',
        reasons: ['account_age_lt_1h'],
        joinedAt: started.toISOString(),
      },
    ]);
    expect(body.nextCursor).toBeNull();
    await app.close();
  });

  it('404s for an incident that belongs to another guild', async () => {
    const { app, cookieHeader, prismaCalls } = await authed({
      raidModeIncident: { findFirst: async () => null },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/raid-mode/incidents/inc-from-${OTHER_GUILD}/members`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    const lookup = prismaCalls.find((c) => c.model === 'raidModeIncident');
    expect((lookup?.args[0] as { where: { guildId: string } }).where.guildId).toBe(GUILD_ID);
    expect(prismaCalls.some((c) => c.model === 'raidModeRiskScore')).toBe(false);
    await app.close();
  });

  it('caps the page size at 50 and filters by minimum risk', async () => {
    const { app, cookieHeader, prismaCalls } = await authed({
      raidModeIncident: { findFirst: async () => ({ id: 'inc-1' }) },
      raidModeRiskScore: { findMany: async () => [] },
    });
    const tooBig = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/raid-mode/incidents/inc-1/members?limit=500`,
      headers: { cookie: cookieHeader },
    });
    expect(tooBig.statusCode).toBe(400);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/raid-mode/incidents/inc-1/members?minRisk=high&limit=50`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const query = prismaCalls.find((c) => c.model === 'raidModeRiskScore')?.args[0] as {
      where: { score: { gte: number } };
      take: number;
    };
    expect(query.where.score.gte).toBe(60);
    expect(query.take).toBe(51);
    await app.close();
  });

  it('401s without a session and 403s without guild access', async () => {
    const { app, redis } = await buildTestApp({});
    const anon = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/raid-mode/incidents/inc-1/members`,
    });
    expect(anon.statusCode).toBe(401);
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: false, permissions: '0' }]);
    const denied = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/raid-mode/incidents/inc-1/members`,
      headers: { cookie: cookieHeader },
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });
});
