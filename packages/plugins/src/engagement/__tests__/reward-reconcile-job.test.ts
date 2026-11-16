import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { rewardReconcileJob } from '../jobs/reward-reconcile';
import { configSchema } from '../manifest';
import {
  enqueueRewardReconcile,
  rewardReconcileBackoffMs,
  rewardReconcileListKey,
  REWARD_RECONCILE_MAX_ATTEMPTS,
} from '../reward-queue';
import { xpForLevel } from '../service';

// The reconcile list key is global, not per guild. Each test deletes it first; that is safe because vitest
// gives every test file its own module graph (so its own ioredis-mock keyspace) and tests in this file run
// serially. Distinct guild ids only keep the role-write assertions readable.
//
// A transient failure is requeued with `attempts` and `notBefore` (at most 3 tries). Malformed entries still
// consume the per-tick budget. Permanent Discord errors (unknown member, missing permissions) are not requeued.

const ROLE_5 = 'role-5';
const ROLE_10 = 'role-10';
const REWARDS = [
  { id: 'r5', level: 5, roleId: ROLE_5 },
  { id: 'r10', level: 10, roleId: ROLE_10 },
];

interface RoleWrite {
  userId: string;
  ids: string[];
}

function memberWithRoles(userId: string, roleIds: string[], removed: RoleWrite[], added: RoleWrite[]) {
  return {
    id: userId,
    roles: {
      cache: new Map(roleIds.map((id) => [id, { id }])),
      add: vi.fn(async (ids: string[]) => {
        added.push({ userId, ids: [...ids] });
      }),
      remove: vi.fn(async (ids: string[]) => {
        removed.push({ userId, ids: [...ids] });
      }),
    },
  };
}

type Member = ReturnType<typeof memberWithRoles>;

interface HarnessOptions {
  mode?: 'stack' | 'replace';
  rewards?: typeof REWARDS;
  /** Stored level per `guildId:userId`; missing keys behave like a deleted profile. */
  levels?: Record<string, number>;
  /** Members by `guildId:userId`; a missing key makes the member fetch reject (member left). */
  members?: Map<string, Member>;
  /** Called before the profile lookup; throw/reject to simulate a failing member. */
  onProfile?: (guildId: string, userId: string) => Promise<void> | void;
  /** Called before the guild fetch resolves; throw/reject to simulate a failing guild. */
  onGuild?: (guildId: string) => Promise<void> | void;
}

function harness(opts: HarnessOptions = {}) {
  const levels = opts.levels ?? {};
  const members = opts.members ?? new Map<string, Member>();
  const memberFetch = vi.fn();
  const guildFetch = vi.fn(async (guildId: string) => {
    await opts.onGuild?.(guildId);
    return {
      id: guildId,
      members: {
        fetch: async (userId: string) => {
          memberFetch(guildId, userId);
          const member = members.get(`${guildId}:${userId}`);
          if (!member) throw new Error('Unknown Member');
          return member;
        },
      },
    };
  });

  const { ctx, redis } = createTestContext({
    config: configSchema.parse({ leveling: { rewardMode: opts.mode ?? 'stack' } }),
    prismaOverrides: {
      levelReward: { findMany: async () => opts.rewards ?? REWARDS },
      levelProfile: {
        findUnique: async (args: unknown) => {
          const key = (args as { where: { guildId_userId: { guildId: string; userId: string } } }).where
            .guildId_userId;
          await opts.onProfile?.(key.guildId, key.userId);
          const level = levels[`${key.guildId}:${key.userId}`];
          return level === undefined
            ? null
            : { guildId: key.guildId, userId: key.userId, level, xp: xpForLevel(level) };
        },
      },
    },
    overrides: {
      client: { guilds: { fetch: guildFetch } } as unknown as PluginContext['client'],
    },
  });
  const warn = vi.spyOn(ctx.logger, 'warn');
  return { ctx, redis, warn, guildFetch, memberFetch };
}

const entry = (guildId: string, userId: string) => JSON.stringify({ guildId, userId });

function parsed(raw: string[]): unknown[] {
  return raw.map((r) => JSON.parse(r) as unknown);
}

describe('reward reconcile job: error isolation', () => {
  async function run(failure: 'profile' | 'config') {
    const guildId = `g-iso-${failure}-20261114`;
    const removed: RoleWrite[] = [];
    const added: RoleWrite[] = [];
    const members = new Map<string, Member>([
      [`${guildId}:bad`, memberWithRoles('bad', [ROLE_10], removed, added)],
      [`${guildId}:good`, memberWithRoles('good', [ROLE_10], removed, added)],
    ]);
    const h = harness({
      members,
      levels: { [`${guildId}:bad`]: 6, [`${guildId}:good`]: 6 },
      onProfile: (_g, userId) => {
        if (failure === 'profile' && userId === 'bad') throw new Error('db down');
      },
    });
    if (failure === 'config') {
      h.ctx.getConfig = (async () => {
        throw new Error('config unavailable');
      }) as typeof h.ctx.getConfig;
    }
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, entry(guildId, 'bad'), entry(guildId, 'good'));
    return { ...h, key, removed, added };
  }

  it('keeps going and requeues when a profile lookup rejects for one member', async () => {
    const { ctx, redis, warn, key, removed, added } = await run('profile');
    await rewardReconcileJob.processor(ctx, {} as never);

    expect(warn).not.toHaveBeenCalled();
    expect(removed.map((w) => w.userId)).toEqual(['good']);
    expect(removed[0]?.ids).toEqual([ROLE_10]);
    expect(added.map((w) => w.userId)).toEqual(['good']);
    const queued = parsed(await redis.lrange(key, 0, -1));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ userId: 'bad', attempts: 1 });
  });

  it('requeues every entry when getConfig rejects, without failing the tick', async () => {
    const { ctx, redis, warn, key, removed } = await run('config');
    await rewardReconcileJob.processor(ctx, {} as never);

    expect(warn).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
    const queued = parsed(await redis.lrange(key, 0, -1));
    expect(queued.map((entry) => (entry as { userId: string }).userId)).toEqual(['bad', 'good']);
    expect(queued.every((entry) => (entry as { attempts: number }).attempts === 1)).toBe(true);
  });
});

describe('reward reconcile job: unresolvable guild or member', () => {
  it('skips an entry whose guild fetch rejects, without role writes, and still processes later entries', async () => {
    const badGuild = 'g-noguild-20261114';
    const goodGuild = 'g-goodguild-20261114';
    const removed: RoleWrite[] = [];
    const added: RoleWrite[] = [];
    const h = harness({
      members: new Map([[`${goodGuild}:u1`, memberWithRoles('u1', [ROLE_10], removed, added)]]),
      levels: { [`${goodGuild}:u1`]: 6 },
      onGuild: (guildId) => {
        if (guildId === badGuild) throw new Error('Unknown Guild');
      },
    });
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, entry(badGuild, 'u0'), entry(goodGuild, 'u1'));

    await rewardReconcileJob.processor(h.ctx, {} as never);

    expect(h.memberFetch).not.toHaveBeenCalledWith(badGuild, expect.anything());
    expect(removed.map((w) => w.userId)).toEqual(['u1']);
    expect(added.map((w) => w.userId)).toEqual(['u1']);
    expect(await h.redis.llen(key)).toBe(0);
  });

  it('skips a member who left (member fetch rejects) without role writes and still processes later entries', async () => {
    const guildId = 'g-left-20261114';
    const removed: RoleWrite[] = [];
    const added: RoleWrite[] = [];
    const h = harness({
      members: new Map([[`${guildId}:stays`, memberWithRoles('stays', [ROLE_10], removed, added)]]),
      levels: { [`${guildId}:gone`]: 6, [`${guildId}:stays`]: 6 },
    });
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, entry(guildId, 'gone'), entry(guildId, 'stays'));

    await rewardReconcileJob.processor(h.ctx, {} as never);

    expect(h.memberFetch).toHaveBeenCalledWith(guildId, 'gone');
    expect(removed.map((w) => w.userId)).toEqual(['stays']);
    expect(added.map((w) => w.userId)).toEqual(['stays']);
    expect(await h.redis.llen(key)).toBe(0);
  });
});

describe('reward reconcile job: per-tick cap', () => {
  // 500 is hardcoded on purpose (not REWARD_ROLE_SYNC_LIMIT) so a change to the cap fails this test.
  it('pops exactly 500 entries per run, leaves the last-enqueued one, and a second run drains it', async () => {
    const guildId = 'g-cap-20261114';
    // No rewards: syncMemberRewardRoles returns early, so only the pop and fetch counts are observable.
    const members = new Map<string, Member>();
    const h = harness({ rewards: [], members });
    for (let i = 0; i < 501; i += 1) {
      members.set(`${guildId}:u${i}`, memberWithRoles(`u${i}`, [], [], []));
    }
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, ...Array.from({ length: 501 }, (_, i) => entry(guildId, `u${i}`)));

    await rewardReconcileJob.processor(h.ctx, {} as never);

    expect(h.memberFetch).toHaveBeenCalledTimes(500);
    expect(h.memberFetch).not.toHaveBeenCalledWith(guildId, 'u500');
    expect(parsed(await h.redis.lrange(key, 0, -1))).toEqual([{ guildId, userId: 'u500' }]);

    await rewardReconcileJob.processor(h.ctx, {} as never);

    expect(h.memberFetch).toHaveBeenCalledTimes(501);
    expect(h.memberFetch).toHaveBeenLastCalledWith(guildId, 'u500');
    expect(await h.redis.llen(key)).toBe(0);
  });
});

describe('reward reconcile job: malformed entries', () => {
  it('drops JSON of the wrong shape with a warn, and still syncs valid entries after them', async () => {
    const guildId = 'g-malformed-20261114';
    const removed: RoleWrite[] = [];
    const added: RoleWrite[] = [];
    const h = harness({
      members: new Map([[`${guildId}:ok`, memberWithRoles('ok', [ROLE_10], removed, added)]]),
      levels: { [`${guildId}:ok`]: 6 },
    });
    const bad = [
      JSON.stringify({ guildId }),
      JSON.stringify({ userId: 'u' }),
      JSON.stringify({ guildId: '', userId: 'u' }),
      JSON.stringify({ guildId, userId: '' }),
      JSON.stringify({ guildId: 123, userId: 'u' }),
      JSON.stringify({ guildId, userId: 456 }),
      JSON.stringify({ guildId: null, userId: null }),
      'null',
      '42',
      JSON.stringify(['a', 'b']),
    ];
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, ...bad, entry(guildId, 'ok'));

    await rewardReconcileJob.processor(h.ctx, {} as never);

    expect(h.warn).toHaveBeenCalledTimes(bad.length);
    expect(h.guildFetch).toHaveBeenCalledTimes(1);
    expect(removed.map((w) => w.userId)).toEqual(['ok']);
    expect(added.map((w) => w.userId)).toEqual(['ok']);
    expect(await h.redis.llen(key)).toBe(0);
  });

  it('counts malformed entries toward the 500 per-tick budget', async () => {
    const guildId = 'g-malformed-budget-20261114';
    const removed: RoleWrite[] = [];
    const added: RoleWrite[] = [];
    const h = harness({
      members: new Map([[`${guildId}:ok`, memberWithRoles('ok', [ROLE_10], removed, added)]]),
      levels: { [`${guildId}:ok`]: 6 },
    });
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, ...Array.from({ length: 500 }, () => 'null'), entry(guildId, 'ok'));

    await rewardReconcileJob.processor(h.ctx, {} as never);

    // Current behavior: the valid entry sits behind a full budget of junk and waits for the next tick.
    expect(removed).toEqual([]);
    expect(parsed(await h.redis.lrange(key, 0, -1))).toEqual([{ guildId, userId: 'ok' }]);

    await rewardReconcileJob.processor(h.ctx, {} as never);

    expect(removed.map((w) => w.userId)).toEqual(['ok']);
    expect(await h.redis.llen(key)).toBe(0);
  });
});

describe('reward reconcile job: replace mode', () => {
  it('removes the higher reward role a member no longer qualifies for and adds the one they do', async () => {
    // computeLevelRewardPlan(replace, level 5): highest applicable reward is role-5, so role-10 is removed
    // and role-5 (not held) is added.
    const guildId = 'g-replace-20261114';
    const removed: RoleWrite[] = [];
    const added: RoleWrite[] = [];
    const h = harness({
      mode: 'replace',
      members: new Map([[`${guildId}:u1`, memberWithRoles('u1', [ROLE_10, 'unrelated'], removed, added)]]),
      levels: { [`${guildId}:u1`]: 5 },
    });
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, entry(guildId, 'u1'));

    await rewardReconcileJob.processor(h.ctx, {} as never);

    expect(removed).toEqual([{ userId: 'u1', ids: [ROLE_10] }]);
    expect(added).toEqual([{ userId: 'u1', ids: [ROLE_5] }]);
  });

  it('leaves the role alone when the member already holds exactly the role their level earns', async () => {
    const guildId = 'g-replace-noop-20261114';
    const removed: RoleWrite[] = [];
    const added: RoleWrite[] = [];
    const h = harness({
      mode: 'replace',
      members: new Map([[`${guildId}:u1`, memberWithRoles('u1', [ROLE_5], removed, added)]]),
      levels: { [`${guildId}:u1`]: 5 },
    });
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, entry(guildId, 'u1'));

    await rewardReconcileJob.processor(h.ctx, {} as never);

    expect(removed).toEqual([]);
    expect(added).toEqual([]);
  });
});

describe('reward reconcile job: retry', () => {
  function failingMember(guildId: string, userId: string, fail: () => unknown) {
    const removed: RoleWrite[] = [];
    const added: RoleWrite[] = [];
    const member = memberWithRoles(userId, [ROLE_10], removed, added);
    const originalAdd = member.roles.add;
    const add = vi.fn(async (ids: string[]) => {
      const thrown = fail();
      if (thrown) throw thrown;
      return originalAdd(ids);
    });
    member.roles.add = add;
    const members = new Map<string, Member>([[`${guildId}:${userId}`, member]]);
    return { members, removed, added, add };
  }

  it('requeues a thrown role sync, waits out the backoff, then succeeds', async () => {
    expect(REWARD_RECONCILE_MAX_ATTEMPTS).toBe(3);
    expect(rewardReconcileBackoffMs(1)).toBe(60_000);
    expect(rewardReconcileBackoffMs(2)).toBe(120_000);

    const guildId = 'g-retry-ok-20261116';
    const userId = 'u1';
    let throwSync = true;
    const { members, removed, added, add } = failingMember(guildId, userId, () =>
      throwSync ? new Error('role sync failed') : undefined,
    );
    const h = harness({ members, levels: { [`${guildId}:${userId}`]: 6 } });
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, entry(guildId, userId));

    const started = Date.now();
    await rewardReconcileJob.processor(h.ctx, {} as never);

    const first = parsed(await h.redis.lrange(key, 0, -1));
    expect(first).toHaveLength(1);
    const retry = first[0] as { guildId: string; userId: string; attempts: number; notBefore: number };
    expect(retry).toMatchObject({ guildId, userId, attempts: 1 });
    expect(retry.notBefore).toBeGreaterThanOrEqual(started + rewardReconcileBackoffMs(1));
    expect(retry.notBefore).toBeLessThanOrEqual(Date.now() + rewardReconcileBackoffMs(1));
    expect(removed).toEqual([]);
    expect(h.warn).not.toHaveBeenCalled();

    await rewardReconcileJob.processor(h.ctx, {} as never);
    expect(add).toHaveBeenCalledTimes(1);
    expect(parsed(await h.redis.lrange(key, 0, -1))).toEqual(first);

    throwSync = false;
    const now = vi.spyOn(Date, 'now').mockReturnValue(retry.notBefore + 1);
    try {
      await rewardReconcileJob.processor(h.ctx, {} as never);
    } finally {
      now.mockRestore();
    }

    expect(await h.redis.llen(key)).toBe(0);
    expect(removed).toEqual([{ userId, ids: [ROLE_10] }]);
    expect(added).toEqual([{ userId, ids: [ROLE_5] }]);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('logs once and drops the entry when the attempt cap is reached', async () => {
    const guildId = 'g-retry-cap-20261116';
    const userId = 'u1';
    const { members } = failingMember(guildId, userId, () =>
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
    );
    const h = harness({ members, levels: { [`${guildId}:${userId}`]: 6 } });
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, entry(guildId, userId));

    let nowMs = 1_763_000_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      for (let attempt = 1; attempt <= REWARD_RECONCILE_MAX_ATTEMPTS; attempt += 1) {
        await rewardReconcileJob.processor(h.ctx, {} as never);
        if (attempt < REWARD_RECONCILE_MAX_ATTEMPTS) {
          const queued = parsed(await h.redis.lrange(key, 0, -1));
          expect(queued).toEqual([
            {
              guildId,
              userId,
              attempts: attempt,
              notBefore: nowMs + rewardReconcileBackoffMs(attempt),
            },
          ]);
          nowMs = (queued[0] as { notBefore: number }).notBefore + 1;
        }
      }
    } finally {
      now.mockRestore();
    }

    expect(await h.redis.llen(key)).toBe(0);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]?.[0]).toMatchObject({ guildId, userId, attempts: 3, err: 'Service Unavailable' });
    expect(h.warn.mock.calls[0]?.[1]).toBe('engagement: dropping reward reconcile entry after retries');
  });

  it('does not requeue a missing-permissions role write or an unknown member', async () => {
    const permGuild = 'g-retry-perm-20261116';
    const goneGuild = 'g-retry-gone-20261116';
    const { members } = failingMember(permGuild, 'u1', () =>
      Object.assign(new Error('DiscordAPIError'), { code: 50013 }),
    );
    const h = harness({
      members,
      levels: { [`${permGuild}:u1`]: 6, [`${goneGuild}:gone`]: 6 },
    });
    h.guildFetch.mockImplementation(async (guildId: string) => {
      if (guildId === goneGuild) {
        return {
          id: guildId,
          members: {
            fetch: async () => {
              throw Object.assign(new Error('DiscordAPIError'), { code: 10007 });
            },
          },
        };
      }
      const member = members.get(`${guildId}:u1`);
      return {
        id: guildId,
        members: {
          fetch: async () => {
            if (!member) throw Object.assign(new Error('DiscordAPIError'), { code: 10007 });
            return member;
          },
        },
      };
    });
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    await h.redis.rpush(key, entry(permGuild, 'u1'), entry(goneGuild, 'gone'));

    await rewardReconcileJob.processor(h.ctx, {} as never);

    expect(await h.redis.llen(key)).toBe(0);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]?.[0]).toMatchObject({ guildId: permGuild, userId: 'u1' });
    expect(h.warn.mock.calls[0]?.[1]).toBe('engagement: reward reconcile skipped (missing permissions)');
  });
});

describe('enqueueRewardReconcile', () => {
  it('makes no Redis call for an empty array', async () => {
    const { redis } = createTestContext();
    const rpush = vi.spyOn(redis, 'rpush');
    await redis.del(rewardReconcileListKey());

    await enqueueRewardReconcile(redis, []);

    expect(rpush).not.toHaveBeenCalled();
    expect(await redis.llen(rewardReconcileListKey())).toBe(0);
  });

  it('chunks 1201 entries into 500/500/201 rpush calls, keeps order, strips extra properties, and the job drains FIFO', async () => {
    const guildId = 'g-enqueue-20261114';
    const total = 1201;
    const entries = Array.from({ length: total }, (_, i) => ({
      guildId,
      userId: `u${i}`,
      extra: 'should-not-be-serialized',
      level: i,
    }));
    const seen: string[] = [];
    const h = harness({ rewards: [] });
    h.guildFetch.mockImplementation(async (id: string) => ({
      id,
      members: {
        fetch: async (userId: string) => {
          seen.push(userId);
          return memberWithRoles(userId, [], [], []);
        },
      },
    }));
    const key = rewardReconcileListKey();
    await h.redis.del(key);
    const rpush = vi.spyOn(h.redis, 'rpush');

    await enqueueRewardReconcile(h.redis, entries);

    expect(rpush).toHaveBeenCalledTimes(3);
    expect(rpush.mock.calls.map((call) => call.length - 1)).toEqual([500, 500, 201]);
    for (const call of rpush.mock.calls) expect(call[0]).toBe(key);

    const stored = await h.redis.lrange(key, 0, -1);
    expect(stored).toHaveLength(total);
    expect(parsed(stored)).toEqual(entries.map((e) => ({ guildId: e.guildId, userId: e.userId })));
    expect(stored[0]).toBe(entry(guildId, 'u0'));

    // Three ticks: 500 + 500 + 201, strictly in enqueue order.
    await rewardReconcileJob.processor(h.ctx, {} as never);
    expect(seen).toHaveLength(500);
    expect(await h.redis.llen(key)).toBe(701);
    await rewardReconcileJob.processor(h.ctx, {} as never);
    await rewardReconcileJob.processor(h.ctx, {} as never);
    expect(seen).toEqual(entries.map((e) => e.userId));
    expect(await h.redis.llen(key)).toBe(0);
  });
});
