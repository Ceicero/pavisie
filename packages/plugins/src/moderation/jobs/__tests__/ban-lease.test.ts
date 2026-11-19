import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { redisKey } from '@pavisie/core';
import { createTestContext } from '../../../sdk/testing';
import { ModerationServiceImpl } from '../../service';
import { expireJob } from '../expire';
import { liftTempBan } from '../ban-expiry';

const GUILD_ID = '111111111111111111';
const TARGET_ID = '222222222222222222';
const OLD_CASE_ID = 'case-old';
const LEASE_KEY = redisKey('moderation', 'ban-lease', GUILD_ID, TARGET_ID);

interface CaseRow {
  id: string;
  guildId: string;
  caseNumber: number;
  type: string;
  targetId: string;
  moderatorId: string;
  reason: string | null;
  expiresAt: Date | null;
  expiredAt: Date | null;
  deletedAt: Date | null;
  durationMs: number | null;
  metadata: unknown;
  [key: string]: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeJob(caseId: string): Job<{ caseId: string }> {
  return { data: { caseId } } as unknown as Job<{ caseId: string }>;
}

/**
 * A stateful guild: Discord's ban list plus the moderation case table, with the subset of Prisma the service and the
 * expiry job touch. `hooks` lets a test pause Discord calls to interleave a second actor at an exact point.
 */
function buildWorld(
  hooks: { onCreate?: () => Promise<void>; onRemove?: () => void; onFindFirst?: () => Promise<void> } = {},
) {
  const cases: CaseRow[] = [
    {
      id: OLD_CASE_ID,
      guildId: GUILD_ID,
      caseNumber: 7,
      type: 'BAN',
      targetId: TARGET_ID,
      moderatorId: 'mod-1',
      reason: null,
      expiresAt: new Date(Date.now() - 1000),
      expiredAt: null,
      deletedAt: null,
      durationMs: 60_000,
      metadata: null,
    },
  ];
  const banned = new Set<string>([TARGET_ID]);
  const removeCalls: string[] = [];
  const createCalls: string[] = [];
  let nextId = 1;

  const matches = (row: CaseRow, where: any): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === 'OR') return (cond as any[]).some((c) => matches(row, c));
      const value = row[key];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as any;
        if ('not' in c && value === c.not) return false;
        if ('gt' in c) return value !== null && (value as any) > c.gt;
        return true;
      }
      return value === cond;
    });

  const moderationCase = {
    findUnique: async ({ where }: any) => cases.find((c) => c.id === where.id) ?? null,
    findFirst: async ({ where }: any) => {
      await hooks.onFindFirst?.();
      return cases.find((c) => matches(c, where)) ?? null;
    },
    update: async ({ where, data }: any) => {
      const row = cases.find((c) => c.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const rows = cases.filter((c) => matches(c, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
    aggregate: async () => ({ _max: { caseNumber: Math.max(0, ...cases.map((c) => c.caseNumber)) } }),
    create: async ({ data }: any) => {
      const row: CaseRow = {
        dmSent: false,
        deletedAt: null,
        expiredAt: null,
        ...data,
        id: `case-new-${nextId++}`,
      };
      cases.push(row);
      return row;
    },
  };
  const prisma = {
    moderationCase,
    $transaction: async (cb: (tx: unknown) => unknown) =>
      cb({ moderationCase, auditLog: { create: async () => ({}) } }),
  };

  const guild = {
    id: GUILD_ID,
    name: 'Guild',
    bans: {
      create: async (id: string) => {
        createCalls.push(id);
        banned.add(id);
        await hooks.onCreate?.();
      },
      remove: async (id: string) => {
        removeCalls.push(id);
        banned.delete(id);
        hooks.onRemove?.();
      },
    },
  };
  const client = {
    user: { id: 'bot' },
    guilds: { fetch: async () => guild },
    users: { fetch: async () => Promise.reject(new Error('unknown user')) },
  };

  const { ctx } = createTestContext({ config: {}, overrides: { prisma, client } as any });
  const service = new ModerationServiceImpl(ctx);
  const permanentBan = () =>
    service.ban({
      guildId: GUILD_ID,
      targetId: TARGET_ID,
      moderatorId: 'mod-2',
      source: 'BOT',
      dmUser: false,
    });
  return { ctx, service, cases, banned, removeCalls, createCalls, permanentBan };
}

beforeEach(async () => {
  // ioredis-mock shares one in-memory server across instances in the process.
  await createTestContext().redis.flushall();
});

describe('ban lease — temp-ban expiry vs a moderator ban', () => {
  it('keeps a permanent ban applied between the expiry check and its unban()', async () => {
    // The real race: ban() has applied the Discord ban but not yet recorded its case when the expiry looks. The
    // gate holds ban() in exactly that gap; it opens once the expiry has called unban().
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let banStarted!: () => void;
    const created = new Promise<void>((resolve) => (banStarted = resolve));
    let banPromise: Promise<unknown> | undefined;

    const world: ReturnType<typeof buildWorld> = buildWorld({
      onCreate: async () => {
        banStarted();
        await gate;
      },
      onRemove: () => openGate(),
      onFindFirst: async () => {
        if (banPromise) return;
        banPromise = world.permanentBan();
        banPromise.catch(() => undefined);
        // With the lease the ban cannot reach Discord until the expiry is done, so this simply times out.
        await Promise.race([created, sleep(50)]);
      },
    });

    await expireJob.processor(world.ctx, fakeJob(OLD_CASE_ID));
    await banPromise;

    expect(world.banned.has(TARGET_ID)).toBe(true);
    const active = world.cases.filter((c) => c.type === 'BAN' && !c.expiredAt);
    expect(active).toHaveLength(1);
    expect(active[0]?.expiresAt).toBeNull();
    expect(await world.ctx.redis.get(LEASE_KEY)).toBeNull();
  });

  it('throws when a ban holds the lease, leaving the case open and the member banned', async () => {
    const world = buildWorld();
    await world.ctx.redis.set(LEASE_KEY, 'someone-else', 'PX', 15_000);

    await expect(
      liftTempBan(world.ctx, world.service, world.cases[0] as any, 'Temporary ban expired'),
    ).rejects.toThrow(/in progress/);

    expect(world.removeCalls).toEqual([]);
    expect(world.cases[0]?.expiredAt).toBeNull();
    // Not ours to delete.
    expect(await world.ctx.redis.get(LEASE_KEY)).toBe('someone-else');
  });

  it('retries cleanly: once the lease is free the same case is lifted', async () => {
    const world = buildWorld();
    await world.ctx.redis.set(LEASE_KEY, 'someone-else', 'PX', 15_000);
    await expect(expireJob.processor(world.ctx, fakeJob(OLD_CASE_ID))).rejects.toThrow();
    expect(world.cases[0]?.expiredAt).toBeNull();

    await world.ctx.redis.del(LEASE_KEY);
    await expireJob.processor(world.ctx, fakeJob(OLD_CASE_ID));
    expect(world.removeCalls).toEqual([TARGET_ID]);
    expect(world.cases[0]?.expiredAt).toBeInstanceOf(Date);
  });

  it('a moderator ban waits for an in-flight expiry lift instead of failing', async () => {
    const world = buildWorld();
    await world.ctx.redis.set(LEASE_KEY, 'expiry', 'PX', 15_000);
    setTimeout(() => void world.ctx.redis.del(LEASE_KEY), 250);

    const row = await world.permanentBan();

    expect(row.type).toBe('BAN');
    expect(world.createCalls).toEqual([TARGET_ID]);
  });

  it('holds the lease across the Discord ban and releases it afterwards, for ban() and the softban fallback', async () => {
    const seen: Array<string | null> = [];
    const world: ReturnType<typeof buildWorld> = buildWorld({
      onCreate: async () => {
        seen.push(await world.ctx.redis.get(LEASE_KEY));
      },
    });

    await world.permanentBan();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await world.ctx.redis.get(LEASE_KEY)).toBeNull();

    // Softban whose cleanup unban fails leaves a BAN case; it is written under the lease too.
    const guild = (world.ctx.client as any).guilds.fetch;
    const fetched = await guild();
    fetched.bans.remove = async () => {
      throw new Error('discord down');
    };
    await expect(
      world.service.softban({
        guildId: GUILD_ID,
        targetId: TARGET_ID,
        moderatorId: 'mod-2',
        source: 'BOT',
        dmUser: false,
      }),
    ).rejects.toThrow(/still banned/);
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBeNull();
    expect(await world.ctx.redis.get(LEASE_KEY)).toBeNull();
  });
});

describe('ban lease — expiry re-checks the lease before it unbans', () => {
  it('does not unban when the lease expired during the check and a moderator ban now holds it', async () => {
    // The 30s TTL ran out mid-check (a stalled process, a slow DB) and a moderator's ban took the lease.
    const world = buildWorld({
      onFindFirst: async () => {
        await world.ctx.redis.del(LEASE_KEY);
        await world.ctx.redis.set(LEASE_KEY, 'moderator-ban', 'PX', 15_000);
      },
    });

    await expect(expireJob.processor(world.ctx, fakeJob(OLD_CASE_ID))).rejects.toMatchObject({
      code: 'ban_lease_lost',
    });

    expect(world.removeCalls).toEqual([]);
    expect(world.banned.has(TARGET_ID)).toBe(true);
    expect(world.cases[0]?.expiredAt).toBeNull();
    // The new holder's lease is neither extended by our renew nor deleted by our release.
    expect(await world.ctx.redis.get(LEASE_KEY)).toBe('moderator-ban');
    expect(await world.ctx.redis.pttl(LEASE_KEY)).toBeLessThanOrEqual(15_000);
  });

  it('does not unban when the lease simply expired, and the retry then lifts the case', async () => {
    let expireOnce = true;
    const world = buildWorld({
      onFindFirst: async () => {
        if (!expireOnce) return;
        expireOnce = false;
        await world.ctx.redis.del(LEASE_KEY);
      },
    });

    await expect(
      liftTempBan(world.ctx, world.service, world.cases[0] as any, 'Temporary ban expired'),
    ).rejects.toThrow(/lease expired/);
    expect(world.removeCalls).toEqual([]);
    expect(world.cases[0]?.expiredAt).toBeNull();

    await expireJob.processor(world.ctx, fakeJob(OLD_CASE_ID));
    expect(world.removeCalls).toEqual([TARGET_ID]);
    expect(world.cases[0]?.expiredAt).toBeInstanceOf(Date);
    expect(await world.ctx.redis.get(LEASE_KEY)).toBeNull();
  });

  it('resets the lease TTL before the unban call', async () => {
    let ttlAtUnban = -1;
    const world: ReturnType<typeof buildWorld> = buildWorld({
      onFindFirst: async () => {
        // Still ours, but nearly out of time.
        await world.ctx.redis.pexpire(LEASE_KEY, 200);
      },
      onRemove: () => {
        void world.ctx.redis.pttl(LEASE_KEY).then((ttl) => (ttlAtUnban = ttl));
      },
    });

    await expireJob.processor(world.ctx, fakeJob(OLD_CASE_ID));

    expect(world.removeCalls).toEqual([TARGET_ID]);
    expect(ttlAtUnban).toBeGreaterThan(20_000);
  });
});

describe('expireJob — manual unban, re-ban, then the old expire job fires', () => {
  it('exits without unbanning the new ban', async () => {
    const world = buildWorld();

    // A moderator lifts the temp ban through the bot (closes every open BAN case, including the old one) ...
    await world.service.unban({
      guildId: GUILD_ID,
      targetId: TARGET_ID,
      moderatorId: 'mod-2',
      reason: 'appeal',
      source: 'BOT',
    });
    expect(world.cases.find((c) => c.id === OLD_CASE_ID)?.expiredAt).toBeInstanceOf(Date);
    expect(world.removeCalls).toHaveLength(1);

    // ... re-bans the member permanently ...
    await world.permanentBan();
    expect(world.banned.has(TARGET_ID)).toBe(true);

    // ... and the old job, scheduled for the first ban, finally fires.
    await expireJob.processor(world.ctx, fakeJob(OLD_CASE_ID));

    expect(world.removeCalls).toHaveLength(1);
    expect(world.banned.has(TARGET_ID)).toBe(true);
    expect(world.cases.filter((c) => c.type === 'BAN' && !c.expiredAt)).toHaveLength(1);
  });
});
