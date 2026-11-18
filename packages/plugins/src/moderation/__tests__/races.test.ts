import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { expireJob } from '../jobs/expire';
import { liftEnforcerMute } from '../jobs/enforcer-mute';
import { sweepJob } from '../jobs/sweep';
import { ModerationServiceImpl } from '../service';

// Task 1: places where two things happening at the same time could apply a moderation action twice, or undo
// one that should still be in force. Each test reproduces one interleaving; none of the fixes uses a global lock.
//
// ioredis-mock shares one dataset across instances, so every test uses its own ids.

type Row = Record<string, unknown>;

/** A promise the test resolves by hand, to hold one side of a race at an exact point. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

// ---------------------------------------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------------------------------------

function appealHarness(appealId: string, options: { dmGate?: Promise<void> } = {}) {
  const appeals: Row[] = [
    {
      id: appealId,
      guildId: 'g-appeal',
      caseId: null,
      userId: 'appellant',
      status: 'PENDING',
      reviewedBy: null,
      reviewedAt: null,
      decisionNote: null,
      effectsAppliedAt: null,
    },
  ];
  const audits: Row[] = [];
  const dms: unknown[] = [];

  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'in' in (value as Row)) {
        return ((value as { in: unknown[] }).in ?? []).includes(row[key]);
      }
      if (value && typeof value === 'object' && 'gte' in (value as Row)) return row[key] != null;
      return row[key] === value;
    });
  const moderationAppeal = {
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = appeals.find((a) => a.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = appeals.filter((a) => matches(a, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = appeals.find((a) => a.id === where.id);
      return row ? { ...row } : null;
    },
    findMany: async ({ where }: { where: Row }) =>
      appeals.filter((a) => matches(a, where)).map((a) => ({ ...a })),
  };
  const auditLog = {
    create: async ({ data }: { data: Row }) => {
      audits.push(data);
      return data;
    },
  };
  const prisma = {
    moderationAppeal,
    moderationCase: { findUnique: async () => null },
    auditLog,
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({ moderationAppeal, auditLog }),
  } as unknown as PluginContext['prisma'];

  const user = {
    id: 'appellant',
    send: async (payload: unknown) => {
      if (options.dmGate) await options.dmGate;
      dms.push(payload);
      return {};
    },
  };
  const client = {
    users: { fetch: async () => user },
    guilds: { cache: new Map(), fetch: async () => ({}) },
  } as unknown as PluginContext['client'];

  const { ctx } = createTestContext({ overrides: { prisma, client } });
  const service = () => new ModerationServiceImpl(ctx);
  return { appeals, audits, dms, service };
}

describe('race: two moderators decide the same appeal at once', () => {
  it('only the first decision counts; the second is told it was already decided', async () => {
    const h = appealHarness('appeal-double');

    const results = await Promise.allSettled([
      h
        .service()
        .decideAppeal({ guildId: 'g-appeal', appealId: 'appeal-double', reviewerId: 'mod-a', accept: true }),
      h
        .service()
        .decideAppeal({ guildId: 'g-appeal', appealId: 'appeal-double', reviewerId: 'mod-b', accept: false }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      'This appeal has already been decided.',
    );
    // One decision, one audit row, one DM — not a flip from ACCEPTED to DENIED.
    expect(h.appeals[0]).toMatchObject({ status: 'ACCEPTED', reviewedBy: 'mod-a' });
    expect(h.audits).toHaveLength(1);
    expect(h.dms).toHaveLength(1);
  });
});

describe('race: a decision made in Discord while the appeal-sync job runs', () => {
  it('applies the decision effects once, not once per path', async () => {
    const dm = gate();
    const h = appealHarness('appeal-sync-race', { dmGate: dm.wait });

    // The bot's own Deny button: the decision is saved, then its DM is in flight (held by the gate)...
    const decision = h.service().decideAppeal({
      guildId: 'g-appeal',
      appealId: 'appeal-sync-race',
      reviewerId: 'mod-a',
      accept: false,
    });
    await vi.waitFor(() => expect(h.appeals[0]?.status).toBe('DENIED'));

    // ...when the once-a-minute sync job ticks. It sees a decided appeal whose effects are not marked applied.
    const sync = h.service().syncDashboardDecidedAppeals();
    dm.open();
    await Promise.all([decision, sync]);

    expect(h.dms).toHaveLength(1);
    expect(h.appeals[0]?.effectsAppliedAt).toBeInstanceOf(Date);
  });

  it('the sync job still applies effects for a dashboard decision', async () => {
    const h = appealHarness('appeal-dashboard');
    Object.assign(h.appeals[0]!, { status: 'ACCEPTED', reviewedBy: 'mod-web', reviewedAt: new Date() });

    expect(await h.service().syncDashboardDecidedAppeals()).toBe(1);
    expect(await h.service().syncDashboardDecidedAppeals()).toBe(0);
    expect(h.dms).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Timeout expiry vs a newer timeout
// ---------------------------------------------------------------------------------------------------------

function timeoutHarness(guildId: string, options: { memberTimeoutEndsAt: number; caseExpiresAt: number }) {
  const lifted = vi.fn(async () => undefined);
  const row = {
    id: `${guildId}-case`,
    guildId,
    targetId: 'member',
    caseNumber: 3,
    type: 'TIMEOUT',
    expiresAt: new Date(options.caseExpiresAt),
    expiredAt: null as Date | null,
    deletedAt: null,
    metadata: {},
  };
  const member = { communicationDisabledUntilTimestamp: options.memberTimeoutEndsAt, timeout: lifted };
  const { ctx } = createTestContext({
    prismaOverrides: {
      moderationCase: {
        findUnique: async () => row,
        findMany: async () => (row.expiredAt ? [] : [row]),
        update: async (args: unknown) => {
          row.expiredAt = new Date();
          return { ...row, ...(args as { data: Row }).data };
        },
      },
    },
    overrides: {
      client: {
        guilds: { fetch: async () => ({ members: { fetch: async () => member } }) },
        user: { id: 'bot' },
      } as never,
    },
  });
  return { ctx, row, lifted };
}

describe('race: a timeout expires after the member was given a newer, longer timeout', () => {
  const now = Date.now();
  const thirtyMinutes = 30 * 60_000;

  it.each([
    [
      'expire job',
      (ctx: PluginContext, id: string) => expireJob.processor(ctx, { data: { caseId: id } } as Job),
    ],
    ['sweep job', (ctx: PluginContext) => sweepJob.processor(ctx, {} as Job)],
  ] as const)('the %s leaves the newer timeout in place', async (_name, run) => {
    const h = timeoutHarness(`g-newer-${_name}`, {
      caseExpiresAt: now,
      memberTimeoutEndsAt: now + thirtyMinutes,
    });

    await run(h.ctx, h.row.id);

    expect(h.lifted).not.toHaveBeenCalled();
    expect(h.row.expiredAt).toBeInstanceOf(Date);
  });

  it.each([
    [
      'expire job',
      (ctx: PluginContext, id: string) => expireJob.processor(ctx, { data: { caseId: id } } as Job),
    ],
    ['sweep job', (ctx: PluginContext) => sweepJob.processor(ctx, {} as Job)],
  ] as const)('the %s still lifts the timeout this case set', async (_name, run) => {
    // Discord's end time and the case's expiry differ by the time it took to write the case.
    const h = timeoutHarness(`g-same-${_name}`, { caseExpiresAt: now, memberTimeoutEndsAt: now - 1_500 });

    await run(h.ctx, h.row.id);

    expect(h.lifted).toHaveBeenCalledWith(null, expect.stringContaining('case #3'));
    expect(h.row.expiredAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Enforcer mute expiry vs a new mute
// ---------------------------------------------------------------------------------------------------------

describe('race: an enforcer mute expires while a new mute is applied', () => {
  it('puts the role back when a new mute started while the old one was being lifted', async () => {
    const ROLE = 'mute-role';
    const oldMute = {
      id: 'old',
      guildId: 'g-mute',
      targetId: 'member',
      metadata: { enforcerMute: true, roleId: ROLE },
    };
    const cases: Row[] = [];
    const roles = new Set([ROLE]);
    const member = {
      roles: {
        cache: { has: (id: string) => roles.has(id) },
        remove: async (id: string) => {
          roles.delete(id);
        },
        add: async (id: string) => {
          roles.add(id);
        },
      },
    };

    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: { findMany: async () => cases.map((c) => ({ ...c })) },
      },
      overrides: {
        client: {
          guilds: {
            fetch: async () => ({
              members: {
                fetch: async () => {
                  // The enforcer applies a new 1-hour mute right now: the role is already on, and its case is
                  // written. The lift already checked for other mutes and found none.
                  cases.push({
                    id: 'new',
                    guildId: 'g-mute',
                    targetId: 'member',
                    type: 'ROLE_ADD',
                    expiredAt: null,
                    deletedAt: null,
                    expiresAt: new Date(Date.now() + 3_600_000),
                    metadata: { enforcerMute: true, roleId: ROLE },
                  });
                  return member;
                },
              },
            }),
          },
        } as never,
      },
    });

    await liftEnforcerMute(ctx, oldMute, 'Mute expired (case #1)');

    // The new mute is still in force, so the member must still have the role.
    expect(roles.has(ROLE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Follow-ups from Dio's review of #35
// ---------------------------------------------------------------------------------------------------------

describe('review follow-ups', () => {
  it('a failed role re-add is repaired by the retry instead of being skipped', async () => {
    const ROLE = 'mute-role';
    const oldMute = {
      id: 'old',
      guildId: 'g-repair',
      targetId: 'member',
      metadata: { enforcerMute: true, roleId: ROLE },
    };
    const cases: Row[] = [];
    const roles = new Set([ROLE]);
    let failAdd = true;
    const member = {
      roles: {
        cache: { has: (id: string) => roles.has(id) },
        remove: async (id: string) => {
          roles.delete(id);
        },
        add: async (id: string) => {
          if (failAdd) throw new Error('rate limited');
          roles.add(id);
        },
      },
    };
    const newMute = {
      id: 'new',
      guildId: 'g-repair',
      targetId: 'member',
      type: 'ROLE_ADD',
      expiredAt: null,
      deletedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      metadata: { enforcerMute: true, roleId: ROLE },
    };
    // The new mute starts while the old one is being lifted: its case appears after the first "no other mute"
    // check, so only the second check (after the removal) sees it.
    let checks = 0;
    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: {
          findMany: async () => {
            checks += 1;
            if (checks === 2) cases.push(newMute);
            return cases.map((c) => ({ ...c }));
          },
        },
      },
      overrides: {
        client: {
          guilds: { fetch: async () => ({ members: { fetch: async () => member } }) },
        } as never,
      },
    });

    await expect(liftEnforcerMute(ctx, oldMute, 'Mute expired (case #1)')).rejects.toThrow('rate limited');
    expect(roles.has(ROLE)).toBe(false); // removed, and putting it back failed

    failAdd = false;
    await liftEnforcerMute(ctx, oldMute, 'Mute expired (case #1)'); // the job's retry

    expect(roles.has(ROLE)).toBe(true);
  });

  it('a newer timeout lifted in the gap is put back until its own end', async () => {
    const now = Date.now();
    const timeouts: (number | null)[] = [];
    const member = {
      communicationDisabledUntilTimestamp: now,
      timeout: async (ms: number | null) => {
        timeouts.push(ms);
      },
    };
    const row = {
      id: 'old-timeout',
      guildId: 'g-reapply',
      targetId: 'member',
      caseNumber: 4,
      type: 'TIMEOUT',
      expiresAt: new Date(now),
      expiredAt: null as Date | null,
      deletedAt: null,
      metadata: {},
    };
    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: {
          findUnique: async () => row,
          // A moderator gave a new 30-minute timeout between the member fetch and the lift.
          findFirst: async () => ({
            id: 'new-timeout',
            caseNumber: 5,
            expiresAt: new Date(now + 30 * 60_000),
          }),
          update: async () => {
            row.expiredAt = new Date();
            return row;
          },
        },
      },
      overrides: {
        client: {
          guilds: { fetch: async () => ({ members: { fetch: async () => member } }) },
          user: { id: 'bot' },
        } as never,
      },
    });

    await expireJob.processor(ctx, { data: { caseId: row.id } } as Job);

    expect(timeouts[0]).toBeNull();
    expect(timeouts[1]).toBeGreaterThan(29 * 60_000);
    expect(timeouts[1]).toBeLessThanOrEqual(30 * 60_000);
  });

  it("an expired appeal lease never deletes the next holder's lease", async () => {
    const dm = gate();
    const h = appealHarness('appeal-lease-token', { dmGate: dm.wait });
    const key = 'pavisie:moderation:appeal-sync-lock:appeal-lease-token';
    const { redis } = createTestContext();
    const decision = h
      .service()
      .decideAppeal({
        guildId: 'g-appeal',
        appealId: 'appeal-lease-token',
        reviewerId: 'mod-a',
        accept: false,
      });
    // Wait until the first holder has the lease and is stuck on its DM.
    await vi.waitFor(async () => expect(await redis.get(key)).not.toBeNull());

    // It stalls past the lease's lifetime; the lease expires and another worker takes it.
    await redis.set(key, 'second-holder');
    dm.open();
    await decision;

    expect(await redis.get(key)).toBe('second-holder');
  });
});
