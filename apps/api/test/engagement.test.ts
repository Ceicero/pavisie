import { describe, expect, it } from 'vitest';
import { rewardReconcileListKey } from '@pavisie/plugins/engagement/reward-queue';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '111111111111111111';
const USER_ID = '222222222222222222';
const ROLE_ID = '333333333333333333';
const TARGET_USER_ID = '444444444444444444';

async function authedApp() {
  const { app, prisma, prismaCalls, redis } = await buildTestApp({
    guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
  });
  const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  const mutHeaders = {
    cookie: cookieHeader,
    origin: 'http://localhost:3000',
    'x-csrf-token': session.csrfToken,
  };
  return { app, prisma, prismaCalls, redis, cookieHeader, mutHeaders };
}

/** In-memory `PluginConfig` fake — enough for a PUT to actually be visible to a subsequent GET. */
function pluginConfigOverrides() {
  const store = new Map<string, Record<string, unknown>>();
  const keyOf = (args: { where: { guildId_pluginId: { guildId: string; pluginId: string } } }) =>
    `${args.where.guildId_pluginId.guildId}:${args.where.guildId_pluginId.pluginId}`;

  return {
    pluginConfig: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake, args shape mirrors Prisma's generated types
      findUnique: async (args: any) => (store.has(keyOf(args)) ? { config: store.get(keyOf(args)) } : null),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
      upsert: async (args: any) => {
        store.set(keyOf(args), args.create.config);
        return { config: args.create.config };
      },
    },
  };
}

describe('engagement config', () => {
  it('GET returns the manifest defaults when nothing is stored, PUT persists a patch', async () => {
    const { app, redis } = await buildTestApp({
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
      ...pluginConfigOverrides(),
    });
    const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
    const mutHeaders = {
      cookie: cookieHeader,
      origin: 'http://localhost:3000',
      'x-csrf-token': session.csrfToken,
    };

    const before = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/engagement/config`,
      headers: { cookie: cookieHeader },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().leveling.enabled).toBe(true);
    expect(before.json().leveling.xpPerMessageMin).toBe(15);
    expect(before.json().starboard.channelId).toBeNull();

    const put = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/engagement/config`,
      headers: mutHeaders,
      payload: {
        leveling: {
          enabled: true,
          xpPerMessageMin: 10,
          xpPerMessageMax: 30,
          xpCooldownSeconds: 45,
          maxXpPerHour: 500,
          voiceXpPerMinute: 5,
          ignoredChannelIds: [],
          ignoredRoleIds: [],
          levelUpChannel: 'current',
          levelUpMessage: 'gg {user} level {level}',
          rewardMode: 'stack',
        },
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().leveling.xpPerMessageMin).toBe(10);

    const after = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/engagement/config`,
      headers: { cookie: cookieHeader },
    });
    expect(after.json().leveling.xpPerMessageMin).toBe(10);
    // untouched sub-configs keep their defaults
    expect(after.json().rep.enabled).toBe(true);

    await app.close();
  });

  it('rejects an unauthenticated request', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/engagement/config` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('engagement leaderboard', () => {
  it('returns level profiles ordered by xp desc, paginated', async () => {
    const rows = [
      { userId: 'a', xp: 500, level: 4, messages: 50, voiceMinutes: 10 },
      { userId: 'b', xp: 300, level: 3, messages: 30, voiceMinutes: 5 },
    ];
    const { app, redis } = await buildTestApp({
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
      levelProfile: { findMany: async () => rows },
    });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/engagement/leaderboard`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].userId).toBe('a');

    await app.close();
  });
});

describe('engagement level rewards', () => {
  it('creates, lists, and deletes a reward, refusing a duplicate level+role', async () => {
    const store: { id: string; guildId: string; level: number; roleId: string; createdAt: Date }[] = [];
    let nextId = 1;

    const { app, cookieHeader, mutHeaders } = await (async () => {
      const built = await buildTestApp({
        guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
        levelReward: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
          findFirst: async (args: any) => {
            const where = args.where;
            if (where.id !== undefined) {
              return store.find((r) => r.id === where.id && r.guildId === where.guildId) ?? null;
            }
            return (
              store.find(
                (r) => r.guildId === where.guildId && r.level === where.level && r.roleId === where.roleId,
              ) ?? null
            );
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
          create: async (args: any) => {
            const row = { id: String(nextId++), createdAt: new Date(), ...args.data };
            store.push(row);
            return row;
          },
          findMany: async () => [...store].sort((a, b) => a.level - b.level),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
          delete: async (args: any) => {
            const idx = store.findIndex((r) => r.id === args.where.id);
            const [removed] = store.splice(idx, 1);
            return removed;
          },
        },
      });
      const { cookieHeader: cookie, session } = await loginAs(built.app, built.redis, { userId: USER_ID });
      await seedUserGuilds(built.redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
      return {
        app: built.app,
        cookieHeader: cookie,
        mutHeaders: { cookie, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken },
      };
    })();

    const create = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/engagement/rewards`,
      headers: mutHeaders,
      payload: { level: 5, roleId: ROLE_ID },
    });
    expect(create.statusCode).toBe(201);
    const rewardId = create.json().id;

    const dup = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/engagement/rewards`,
      headers: mutHeaders,
      payload: { level: 5, roleId: ROLE_ID },
    });
    expect(dup.statusCode).toBe(400);

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/engagement/rewards`,
      headers: { cookie: cookieHeader },
    });
    expect(list.json()).toHaveLength(1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/engagement/rewards/${rewardId}`,
      headers: mutHeaders,
    });
    expect(del.statusCode).toBe(204);

    const listAfter = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/engagement/rewards`,
      headers: { cookie: cookieHeader },
    });
    expect(listAfter.json()).toHaveLength(0);

    await app.close();
  });

  it('404s deleting a reward that does not belong to the guild', async () => {
    const { app, mutHeaders } = await authedApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/engagement/rewards/does-not-exist`,
      headers: mutHeaders,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('engagement xp-adjust', () => {
  it('give/remove/set all persist through levelProfile upsert and return the new level', async () => {
    const profiles = new Map<string, { xp: number; level: number }>();
    const { app, mutHeaders } = await (async () => {
      const built = await buildTestApp({
        guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
        levelProfile: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
          findUnique: async (args: any) => {
            const key = args.where.guildId_userId.userId;
            return profiles.has(key) ? { userId: key, ...profiles.get(key)! } : null;
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
          upsert: async (args: any) => {
            const key = args.where.guildId_userId.userId;
            const data = { xp: args.create.xp, level: args.create.level };
            profiles.set(key, data);
            return { userId: key, messages: 0, voiceMinutes: 0, ...data };
          },
        },
      });
      const { cookieHeader: cookie, session } = await loginAs(built.app, built.redis, { userId: USER_ID });
      await seedUserGuilds(built.redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
      return {
        app: built.app,
        mutHeaders: { cookie, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken },
      };
    })();

    const give = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/engagement/xp-adjust`,
      headers: mutHeaders,
      payload: { userId: TARGET_USER_ID, mode: 'give', amount: 100 },
    });
    expect(give.statusCode).toBe(200);
    expect(give.json().xp).toBe(100);
    expect(give.json().level).toBe(1); // xpForLevel(1) === 100, so exactly 100 xp is level 1 (see engagement/__tests__/service.test.ts)

    const give2 = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/engagement/xp-adjust`,
      headers: mutHeaders,
      payload: { userId: TARGET_USER_ID, mode: 'give', amount: 200 },
    });
    expect(give2.json().xp).toBe(300);
    expect(give2.json().level).toBeGreaterThanOrEqual(give.json().level);

    const set = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/engagement/xp-adjust`,
      headers: mutHeaders,
      payload: { userId: TARGET_USER_ID, mode: 'set', amount: 0 },
    });
    expect(set.json().xp).toBe(0);
    expect(set.json().level).toBe(0);

    const removeBelowZero = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/engagement/xp-adjust`,
      headers: mutHeaders,
      payload: { userId: TARGET_USER_ID, mode: 'remove', amount: 50 },
    });
    expect(removeBelowZero.json().xp).toBe(0); // clamped, never negative

    await app.close();
  });
});

describe('engagement reputation leaderboard', () => {
  it('aggregates ReputationEvent by recipient, sorted desc', async () => {
    const { app, cookieHeader } = await (async () => {
      const built = await buildTestApp({
        guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
        reputationEvent: {
          groupBy: async () => [
            { toUserId: 'a', _sum: { amount: 5 }, _count: { _all: 5 } },
            { toUserId: 'b', _sum: { amount: 2 }, _count: { _all: 2 } },
          ],
        },
      });
      const { cookieHeader: cookie } = await loginAs(built.app, built.redis, { userId: USER_ID });
      await seedUserGuilds(built.redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
      return { app: built.app, cookieHeader: cookie };
    })();

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/engagement/rep/leaderboard`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([
      { userId: 'a', total: 5, eventCount: 5 },
      { userId: 'b', total: 2, eventCount: 2 },
    ]);

    await app.close();
  });
});

describe('engagement reset', () => {
  // Own guild and user ids (dated snowflakes). ioredis-mock is shared, and this route writes the
  // reward-reconcile list plus the session guild cache.
  const GUILD = '202611130000000101';
  const ACTOR = '202611130000000102';
  const MEMBER_A = '202611130000000103';
  const MEMBER_B = '202611130000000104';
  const OUTSIDER = '202611130000000105';
  const SINGLE_GUILD = '202611130000000111';
  const SINGLE_ACTOR = '202611130000000112';
  const SINGLE_MEMBER = '202611130000000113';

  async function listedFor(
    redis: { lrange: (key: string, start: number, stop: number) => Promise<string[]> },
    guildId: string,
  ) {
    const raw = await redis.lrange(rewardReconcileListKey(), 0, -1);
    return raw
      .map((item) => JSON.parse(item) as { guildId: string; userId: string })
      .filter((entry) => entry.guildId === guildId);
  }

  it('rejects an unauthenticated request', async () => {
    const { app, prismaCalls } = await buildTestApp({
      guild: { findUnique: async () => ({ id: GUILD, botPresent: true }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD}/engagement/reset`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(prismaCalls.some((call) => call.model === 'levelProfile' && call.method === 'deleteMany')).toBe(
      false,
    );
    await app.close();
  });

  it('rejects a signed-in member who is not an admin', async () => {
    const { app, redis, prismaCalls } = await buildTestApp({
      guild: { findUnique: async () => ({ id: GUILD, botPresent: true }) },
    });
    const { cookieHeader, session } = await loginAs(app, redis, { userId: OUTSIDER });
    await seedUserGuilds(redis, OUTSIDER, [{ id: GUILD, owner: false, permissions: '0' }]);
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD}/engagement/reset`,
      headers: { cookie: cookieHeader, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(prismaCalls.some((call) => call.model === 'levelProfile' && call.method === 'deleteMany')).toBe(
      false,
    );
    await app.close();
  });

  it('deletes every profile, writes an audit row, and enqueues each member', async () => {
    const rows = [
      { userId: MEMBER_A, xp: 50, level: 2 },
      { userId: MEMBER_B, xp: 10, level: 1 },
    ];
    const { app, redis, prismaCalls } = await buildTestApp({
      guild: { findUnique: async () => ({ id: GUILD, botPresent: true }) },
      levelProfile: {
        findMany: async () => rows,
        deleteMany: async () => ({ count: rows.length }),
      },
    });
    const { cookieHeader, session } = await loginAs(app, redis, { userId: ACTOR });
    await seedUserGuilds(redis, ACTOR, [{ id: GUILD, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD}/engagement/reset`,
      headers: { cookie: cookieHeader, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 2 });

    const levelCalls = prismaCalls.filter((call) => call.model === 'levelProfile');
    expect(levelCalls.map((call) => call.method)).toEqual(['findMany', 'deleteMany']);
    expect(levelCalls[1]?.args[0]).toEqual({ where: { guildId: GUILD } });

    const audit = prismaCalls.find((call) => call.model === 'auditLog' && call.method === 'create');
    expect(audit?.args[0]).toMatchObject({
      data: {
        guildId: GUILD,
        actorId: ACTOR,
        actorType: 'USER',
        action: 'engagement.level.reset',
        targetType: 'level_profile',
        targetId: 'all',
        source: 'DASHBOARD',
        after: { count: 2 },
      },
    });

    const queued = await listedFor(redis, GUILD);
    expect(queued.map((entry) => entry.userId).sort()).toEqual([MEMBER_A, MEMBER_B].sort());
    await app.close();
  });

  it('deletes and enqueues only the requested member', async () => {
    const { app, redis, prismaCalls } = await buildTestApp({
      guild: { findUnique: async () => ({ id: SINGLE_GUILD, botPresent: true }) },
      levelProfile: {
        deleteMany: async () => ({ count: 1 }),
      },
    });
    const { cookieHeader, session } = await loginAs(app, redis, { userId: SINGLE_ACTOR });
    await seedUserGuilds(redis, SINGLE_ACTOR, [
      { id: SINGLE_GUILD, owner: false, permissions: String(0x20n) },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${SINGLE_GUILD}/engagement/reset`,
      headers: { cookie: cookieHeader, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken },
      payload: { userId: SINGLE_MEMBER },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 1 });
    const levelCalls = prismaCalls.filter((call) => call.model === 'levelProfile');
    expect(levelCalls.map((call) => call.method)).toEqual(['deleteMany']);
    expect(levelCalls[0]?.args[0]).toEqual({ where: { guildId: SINGLE_GUILD, userId: SINGLE_MEMBER } });
    const audit = prismaCalls.find((call) => call.model === 'auditLog' && call.method === 'create');
    expect(audit?.args[0]).toMatchObject({
      data: { action: 'engagement.level.reset', targetId: SINGLE_MEMBER, actorId: SINGLE_ACTOR },
    });
    expect(await listedFor(redis, SINGLE_GUILD)).toEqual([{ guildId: SINGLE_GUILD, userId: SINGLE_MEMBER }]);
    await app.close();
  });
});

describe('engagement xp-adjust reward reconcile', () => {
  const GUILD = '202611130000000201';
  const ACTOR = '202611130000000202';
  const TARGET = '202611130000000203';

  it('enqueues a reconcile entry only when the stored level changes', async () => {
    const profiles = new Map<string, { xp: number; level: number }>();
    const { app, redis } = await buildTestApp({
      guild: { findUnique: async () => ({ id: GUILD, botPresent: true }) },
      levelProfile: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        findUnique: async (args: any) => {
          const key = args.where.guildId_userId.userId;
          return profiles.has(key) ? { userId: key, ...profiles.get(key)! } : null;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        upsert: async (args: any) => {
          const key = args.where.guildId_userId.userId;
          const data = { xp: args.create.xp, level: args.create.level };
          profiles.set(key, data);
          return { userId: key, messages: 0, voiceMinutes: 0, ...data };
        },
      },
    });
    const { cookieHeader, session } = await loginAs(app, redis, { userId: ACTOR });
    await seedUserGuilds(redis, ACTOR, [{ id: GUILD, owner: true, permissions: '8' }]);
    const headers = {
      cookie: cookieHeader,
      origin: 'http://localhost:3000',
      'x-csrf-token': session.csrfToken,
    };

    const give = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD}/engagement/xp-adjust`,
      headers,
      payload: { userId: TARGET, mode: 'give', amount: 100 },
    });
    expect(give.json().level).toBe(1);

    const stillSameLevel = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD}/engagement/xp-adjust`,
      headers,
      payload: { userId: TARGET, mode: 'give', amount: 1 },
    });
    expect(stillSameLevel.json().level).toBe(1);

    const cleared = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD}/engagement/xp-adjust`,
      headers,
      payload: { userId: TARGET, mode: 'set', amount: 0 },
    });
    expect(cleared.json().level).toBe(0);

    const raw = await redis.lrange(rewardReconcileListKey(), 0, -1);
    const queued = raw
      .map((item) => JSON.parse(item) as { guildId: string; userId: string })
      .filter((entry) => entry.guildId === GUILD);
    expect(queued).toEqual([
      { guildId: GUILD, userId: TARGET },
      { guildId: GUILD, userId: TARGET },
    ]);
    await app.close();
  });
});
