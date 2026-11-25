import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { ModerationServiceImpl } from '../service';

interface FakeAppealRow {
  id: string;
  guildId: string;
  caseId: string | null;
  userId: string;
  content: string;
  status: 'PENDING' | 'ACCEPTED' | 'DENIED';
  reviewedBy: string | null;
  reviewedAt: Date | null;
  decisionNote: string | null;
  staffMessageId: string | null;
  effectsAppliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeCaseRow {
  id: string;
  guildId: string;
  caseNumber: number;
  type: string;
  targetId: string;
  expiredAt: Date | null;
}

function buildHarness() {
  const appeals = new Map<string, FakeAppealRow>();
  const cases = new Map<string, FakeCaseRow>();
  let nextAppealId = 1;

  const timeoutFn = vi.fn(async () => undefined);
  const sendFn = vi.fn(async () => undefined);

  const moderationAppeal = {
    create: async ({ data }: { data: Partial<FakeAppealRow> }) => {
      const row: FakeAppealRow = {
        id: `appeal-${nextAppealId++}`,
        guildId: data.guildId!,
        caseId: data.caseId ?? null,
        userId: data.userId!,
        content: data.content!,
        status: 'PENDING',
        reviewedBy: null,
        reviewedAt: null,
        decisionNote: null,
        staffMessageId: null,
        effectsAppliedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      appeals.set(row.id, row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeAppealRow> }) => {
      const existing = appeals.get(where.id);
      if (!existing) throw new Error('not found');
      const updated = { ...existing, ...data };
      appeals.set(where.id, updated);
      return updated;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; guildId: string; status: string };
      data: Partial<FakeAppealRow>;
    }) => {
      const existing = appeals.get(where.id);
      if (!existing || existing.guildId !== where.guildId || existing.status !== where.status)
        return { count: 0 };
      appeals.set(where.id, { ...existing, ...data });
      return { count: 1 };
    },
    findUnique: async ({ where }: { where: { id: string } }) => appeals.get(where.id) ?? null,
    findMany: async ({
      where,
    }: {
      where: { status: { in: string[] }; effectsAppliedAt: null; reviewedAt: { gte: Date } };
    }) =>
      [...appeals.values()].filter(
        (a) =>
          where.status.in.includes(a.status) &&
          a.effectsAppliedAt === where.effectsAppliedAt &&
          (!a.reviewedAt || a.reviewedAt >= where.reviewedAt.gte),
      ),
  };

  const moderationCase = {
    findUnique: async ({ where }: { where: { id: string } }) => cases.get(where.id) ?? null,
    updateMany: async ({
      where,
      data,
    }: {
      where: { guildId: string; targetId: string; type: string };
      data: { expiredAt: Date };
    }) => {
      let count = 0;
      for (const row of cases.values()) {
        if (
          row.guildId === where.guildId &&
          row.targetId === where.targetId &&
          row.type === where.type &&
          row.expiredAt === null
        ) {
          row.expiredAt = data.expiredAt;
          count += 1;
        }
      }
      return { count };
    },
  };

  const auditLog = { create: async () => ({}) };
  const prisma = {
    moderationAppeal,
    moderationCase,
    auditLog,
    $transaction: async (cb: (tx: unknown) => unknown) => cb({ moderationAppeal, moderationCase, auditLog }),
  } as unknown as PluginContext['prisma'];

  const member = { timeout: timeoutFn };
  const guild = { name: 'Test Guild', members: { fetch: vi.fn(async () => member) } };
  const client = {
    guilds: { fetch: vi.fn(async () => guild), cache: new Map([['g1', guild]]) },
    users: { fetch: vi.fn(async () => ({ id: 'u1', send: sendFn })) },
  } as unknown as PluginContext['client'];

  const { ctx } = createTestContext({ config: {}, overrides: { prisma, client } });
  const service = new ModerationServiceImpl(ctx);

  return { service, appeals, cases, timeoutFn, sendFn, ctx };
}

/**
 * `ioredis-mock` simulates a single shared in-memory server across every `new Redis()` instance in the process
 * (mirroring real Redis, where distinct clients connect to the same server) — so each harness must flush before
 * use, or the `appeal-applied` Redis marker from an earlier test (which reuses the same `appeal-1` id, since
 * `nextAppealId` resets per harness) leaks into this one.
 */
async function buildFlushedHarness() {
  const harness = buildHarness();
  await harness.ctx.redis.flushall();
  return harness;
}

describe('appeal state transitions', () => {
  it('openAppeal creates a PENDING row linked to the case', async () => {
    const { service, appeals } = await buildFlushedHarness();
    const { appealId } = await service.openAppeal({
      guildId: 'g1',
      userId: 'u1',
      caseId: 'case-1',
      content: 'Please reconsider.',
      source: 'bot',
    });

    const row = appeals.get(appealId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('PENDING');
    expect(row?.userId).toBe('u1');
  });

  it('decideAppeal(accept) on a TIMEOUT case removes the timeout and DMs the user', async () => {
    const { service, cases, timeoutFn, sendFn } = await buildFlushedHarness();
    cases.set('case-1', {
      id: 'case-1',
      guildId: 'g1',
      caseNumber: 5,
      type: 'TIMEOUT',
      targetId: 'u1',
      expiredAt: null,
    });
    const { appealId } = await service.openAppeal({
      guildId: 'g1',
      userId: 'u1',
      caseId: 'case-1',
      content: 'x',
      source: 'bot',
    });

    const updated = await service.decideAppeal({
      guildId: 'g1',
      appealId,
      accept: true,
      reviewerId: 'staff-1',
    });

    expect(updated.status).toBe('ACCEPTED');
    expect(updated.reviewedBy).toBe('staff-1');
    expect(timeoutFn).toHaveBeenCalledWith(null, expect.stringContaining('case #5'));
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(cases.get('case-1')?.expiredAt).not.toBeNull();
  });

  it('decideAppeal(deny) does not touch the case, but still DMs the user', async () => {
    const { service, cases, timeoutFn, sendFn } = await buildFlushedHarness();
    cases.set('case-1', {
      id: 'case-1',
      guildId: 'g1',
      caseNumber: 5,
      type: 'TIMEOUT',
      targetId: 'u1',
      expiredAt: null,
    });
    const { appealId } = await service.openAppeal({
      guildId: 'g1',
      userId: 'u1',
      caseId: 'case-1',
      content: 'x',
      source: 'bot',
    });

    const updated = await service.decideAppeal({
      guildId: 'g1',
      appealId,
      accept: false,
      reviewerId: 'staff-1',
    });

    expect(updated.status).toBe('DENIED');
    expect(timeoutFn).not.toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(cases.get('case-1')?.expiredAt).toBeNull();
  });

  it('syncDashboardDecidedAppeals applies dashboard-written decisions exactly once', async () => {
    const { service, appeals, cases, timeoutFn } = await buildFlushedHarness();
    cases.set('case-1', {
      id: 'case-1',
      guildId: 'g1',
      caseNumber: 9,
      type: 'TIMEOUT',
      targetId: 'u1',
      expiredAt: null,
    });
    const { appealId } = await service.openAppeal({
      guildId: 'g1',
      userId: 'u1',
      caseId: 'case-1',
      content: 'x',
      source: 'bot',
    });

    // Simulate the dashboard deciding it directly in the database (no Discord side effects yet).
    const row = appeals.get(appealId)!;
    appeals.set(appealId, {
      ...row,
      status: 'ACCEPTED',
      reviewedBy: 'dashboard-user',
      reviewedAt: new Date(),
    });

    const firstRun = await service.syncDashboardDecidedAppeals();
    expect(firstRun).toBe(1);
    expect(timeoutFn).toHaveBeenCalledTimes(1);

    const secondRun = await service.syncDashboardDecidedAppeals();
    expect(secondRun).toBe(0); // already applied — durable `effectsAppliedAt` DB column prevents re-applying
    expect(timeoutFn).toHaveBeenCalledTimes(1);
  });

  it('does not re-apply after the in-flight Redis lock has been flushed (unlike the old 30-day TTL cache)', async () => {
    const { service, appeals, cases, timeoutFn, ctx } = await buildFlushedHarness();
    cases.set('case-1', {
      id: 'case-1',
      guildId: 'g1',
      caseNumber: 9,
      type: 'TIMEOUT',
      targetId: 'u1',
      expiredAt: null,
    });
    const { appealId } = await service.openAppeal({
      guildId: 'g1',
      userId: 'u1',
      caseId: 'case-1',
      content: 'x',
      source: 'bot',
    });

    const row = appeals.get(appealId)!;
    appeals.set(appealId, {
      ...row,
      status: 'ACCEPTED',
      reviewedBy: 'dashboard-user',
      reviewedAt: new Date(),
    });

    expect(await service.syncDashboardDecidedAppeals()).toBe(1);
    expect(timeoutFn).toHaveBeenCalledTimes(1);

    // Simulates a Redis flush/eviction/restart — the old implementation relied entirely on a Redis TTL key for
    // "already applied", so this would have re-fired the DM/timeout-removal/ledger effects a second time.
    await ctx.redis.flushall();

    expect(await service.syncDashboardDecidedAppeals()).toBe(0);
    expect(timeoutFn).toHaveBeenCalledTimes(1);
    expect(appeals.get(appealId)?.effectsAppliedAt).toBeInstanceOf(Date);
  });

  it('does not re-apply effects for an appeal reviewed more than 24h ago even if effectsAppliedAt were somehow missing', async () => {
    const { service, appeals, cases, timeoutFn } = await buildFlushedHarness();
    cases.set('case-1', {
      id: 'case-1',
      guildId: 'g1',
      caseNumber: 9,
      type: 'TIMEOUT',
      targetId: 'u1',
      expiredAt: null,
    });
    const { appealId } = await service.openAppeal({
      guildId: 'g1',
      userId: 'u1',
      caseId: 'case-1',
      content: 'x',
      source: 'bot',
    });

    const row = appeals.get(appealId)!;
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    appeals.set(appealId, {
      ...row,
      status: 'ACCEPTED',
      reviewedBy: 'dashboard-user',
      reviewedAt: twoDaysAgo,
    });

    expect(await service.syncDashboardDecidedAppeals()).toBe(0);
    expect(timeoutFn).not.toHaveBeenCalled();
  });
});
