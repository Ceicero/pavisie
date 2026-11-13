import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor, env } from '@pavisie/core';
import { levelProgress } from '@pavisie/plugins/engagement/service';
import { rewardReconcileListKey } from '@pavisie/plugins/engagement/reward-queue';
import {
  DISCORD_USER_CACHE_TTL_SECONDS,
  DISCORD_USER_FAILURE_TTL_SECONDS,
  DISCORD_USER_MISS_TTL_SECONDS,
  getCachedDiscordUser,
} from '../src/lib/discord-users';
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
    expect(before.json().leveling.publicLeaderboard).toBe(false);
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
    expect(put.json().leveling.publicLeaderboard).toBe(false);

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
      { userId: 'a', xp: 500, level: 4, messages: 50, voiceMinutes: 10, lastXpAt: new Date() },
      { userId: 'b', xp: 300, level: 3, messages: 30, voiceMinutes: 5 },
    ];
    const { app, redis } = await buildTestApp({
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
      levelProfile: {
        findMany: async () => rows,
        count: async () => rows.length,
      },
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
    expect(body.items.map((row: { rank: number }) => row.rank)).toEqual([1, 2]);
    expect(body.total).toBe(2);
    expect(body.items[0].lastXpAt).toBeUndefined();

    await app.close();
  });

  it('numbers rank from the page offset and returns the full profile count', async () => {
    const rows = [
      { userId: 'a', xp: 500, level: 4, messages: 50, voiceMinutes: 10 },
      { userId: 'b', xp: 300, level: 3, messages: 30, voiceMinutes: 5 },
      { userId: 'c', xp: 100, level: 1, messages: 10, voiceMinutes: 1 },
    ];
    const { app, redis } = await buildTestApp({
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
      levelProfile: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        findMany: async (args: any) => {
          const skip = args.skip ?? 0;
          const take = args.take ?? rows.length;
          return rows.slice(skip, skip + take);
        },
        count: async () => rows.length,
      },
    });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/engagement/leaderboard?cursor=${encodeCursor(1)}&limit=1`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([
      expect.objectContaining({ userId: 'b', rank: 2, xp: 300, level: 3, messages: 30, voiceMinutes: 5 }),
    ]);
    expect(body.nextCursor).toBe(encodeCursor(2));
    expect(body.total).toBe(3);

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

// Public routes share the process-wide ioredis-mock with every other test. Each case uses its own guild id
// so a config or user cache written here cannot satisfy a later case.
const PUBLIC_DISABLED_GUILD = '910000000000000011';
const PUBLIC_ABSENT_GUILD = '910000000000000012';
const PUBLIC_LIST_GUILD = '910000000000000013';
const PUBLIC_RANK_GUILD = '910000000000000014';
const PUBLIC_FAIL_GUILD = '910000000000000016';
const PUBLIC_CACHE_GUILD = '910000000000000017';

const PUBLIC_USER_A = '920000000000000021';
const PUBLIC_USER_B = '920000000000000022';
const PUBLIC_RANK_USER = '920000000000000023';
const PUBLIC_FAIL_USER = '920000000000000024';
const PUBLIC_CACHE_USER = '920000000000000025';
const PUBLIC_MISS_USER = '920000000000000026';
const PUBLIC_NO_PROFILE_USER = '920000000000000027';

const originalDiscordToken = env.DISCORD_TOKEN;

afterEach(() => {
  env.DISCORD_TOKEN = originalDiscordToken;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function enabledConfig() {
  return { config: { leveling: { publicLeaderboard: true } } };
}

describe('public leveling leaderboard', () => {
  it('returns 404 when the public leaderboard is off', async () => {
    const { app } = await buildTestApp({
      guild: { findUnique: async () => ({ id: PUBLIC_DISABLED_GUILD, botPresent: true }) },
    });

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_DISABLED_GUILD}/engagement/leaderboard/public`,
    });
    const rank = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_DISABLED_GUILD}/engagement/rank/${PUBLIC_RANK_USER}`,
    });

    expect(list.statusCode).toBe(404);
    expect(list.json().error.message).toBe('Leaderboard not found.');
    expect(rank.statusCode).toBe(404);
    expect(rank.json().error.message).toBe('Leaderboard not found.');
    await app.close();
  });

  it('returns 404 when the bot is not in the guild', async () => {
    const { app } = await buildTestApp({
      guild: { findUnique: async () => ({ id: PUBLIC_ABSENT_GUILD, botPresent: false }) },
      pluginConfig: { findUnique: async () => enabledConfig() },
    });

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_ABSENT_GUILD}/engagement/leaderboard/public`,
    });
    const rank = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_ABSENT_GUILD}/engagement/rank/${PUBLIC_RANK_USER}`,
    });

    expect(list.statusCode).toBe(404);
    expect(list.json().error.message).toBe('Leaderboard not found.');
    expect(rank.statusCode).toBe(404);
    expect(rank.json().error.message).toBe('Leaderboard not found.');
    await app.close();
  });

  it('returns the public page shape and paginates by xp desc', async () => {
    env.DISCORD_TOKEN = 'test-bot-token';
    const rows = [
      { userId: PUBLIC_USER_A, xp: 500, level: 4, messages: 50, voiceMinutes: 10, lastXpAt: new Date() },
      { userId: PUBLIC_USER_B, xp: 300, level: 3, messages: 30, voiceMinutes: 5, guildId: PUBLIC_LIST_GUILD },
    ];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const id = String(input).split('/').pop();
      if (id === PUBLIC_USER_A) {
        return jsonResponse({ id, username: 'alpha', global_name: 'Alpha', avatar: 'deadbeef' });
      }
      if (id === PUBLIC_USER_B) {
        return jsonResponse({ id, username: 'beta', global_name: null, avatar: null });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { app } = await buildTestApp({
      guild: { findUnique: async () => ({ id: PUBLIC_LIST_GUILD, botPresent: true }) },
      pluginConfig: { findUnique: async () => enabledConfig() },
      levelProfile: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        findMany: async (args: any) => {
          const skip = args.skip ?? 0;
          const take = args.take ?? rows.length;
          return rows.slice(skip, skip + take);
        },
        count: async () => rows.length,
      },
    });

    const first = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_LIST_GUILD}/engagement/leaderboard/public?limit=1`,
    });
    expect(first.statusCode).toBe(200);
    const page = first.json();
    expect(Object.keys(page).sort()).toEqual(['guildId', 'items', 'nextCursor', 'total']);
    expect(page.guildId).toBe(PUBLIC_LIST_GUILD);
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBe(encodeCursor(1));
    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]).sort()).toEqual(
      [
        'avatarUrl',
        'globalName',
        'level',
        'messages',
        'rank',
        'userId',
        'username',
        'voiceMinutes',
        'xp',
      ].sort(),
    );
    expect(page.items[0]).toEqual({
      rank: 1,
      userId: PUBLIC_USER_A,
      username: 'alpha',
      globalName: 'Alpha',
      avatarUrl: `https://cdn.discordapp.com/avatars/${PUBLIC_USER_A}/deadbeef.png`,
      xp: 500,
      level: 4,
      messages: 50,
      voiceMinutes: 10,
    });

    const second = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_LIST_GUILD}/engagement/leaderboard/public?cursor=${page.nextCursor}&limit=1`,
    });
    expect(second.statusCode).toBe(200);
    const defaultIndex = Number((BigInt(PUBLIC_USER_B) >> 22n) % 6n);
    expect(second.json().items).toEqual([
      {
        rank: 2,
        userId: PUBLIC_USER_B,
        username: 'beta',
        globalName: null,
        avatarUrl: `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`,
        xp: 300,
        level: 3,
        messages: 30,
        voiceMinutes: 5,
      },
    ]);
    expect(second.json().nextCursor).toBeNull();
    await app.close();
  });

  it('returns rank progress and 404 when the member has no profile', async () => {
    env.DISCORD_TOKEN = 'test-bot-token';
    const xp = 150;
    const progress = levelProgress(xp);
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: PUBLIC_RANK_USER,
        username: 'ranked',
        global_name: 'Ranked',
        avatar: 'a_animated',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { app } = await buildTestApp({
      guild: { findUnique: async () => ({ id: PUBLIC_RANK_GUILD, botPresent: true }) },
      pluginConfig: { findUnique: async () => enabledConfig() },
      levelProfile: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        findUnique: async (args: any) => {
          if (args.where?.guildId_userId?.userId !== PUBLIC_RANK_USER) return null;
          return {
            userId: PUBLIC_RANK_USER,
            xp,
            level: 99,
            messages: 12,
            voiceMinutes: 7,
          };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        count: async (args: any) => (args.where?.xp?.gt === xp ? 4 : 0),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_RANK_GUILD}/engagement/rank/${PUBLIC_RANK_USER}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        'avatarUrl',
        'globalName',
        'intoLevel',
        'level',
        'messages',
        'rank',
        'span',
        'userId',
        'username',
        'voiceMinutes',
        'xp',
      ].sort(),
    );
    expect(body).toEqual({
      userId: PUBLIC_RANK_USER,
      username: 'ranked',
      globalName: 'Ranked',
      avatarUrl: `https://cdn.discordapp.com/avatars/${PUBLIC_RANK_USER}/a_animated.gif`,
      rank: 5,
      level: progress.level,
      xp,
      intoLevel: progress.intoLevel,
      span: progress.span,
      messages: 12,
      voiceMinutes: 7,
    });

    const missing = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_RANK_GUILD}/engagement/rank/${PUBLIC_NO_PROFILE_USER}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe('Level profile not found.');
    await app.close();
  });

  it('returns null names when the Discord lookup fails', async () => {
    env.DISCORD_TOKEN = 'test-bot-token';
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'upstream' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    const { app } = await buildTestApp({
      guild: { findUnique: async () => ({ id: PUBLIC_FAIL_GUILD, botPresent: true }) },
      pluginConfig: { findUnique: async () => enabledConfig() },
      levelProfile: {
        findUnique: async () => ({
          userId: PUBLIC_FAIL_USER,
          xp: 10,
          level: 0,
          messages: 1,
          voiceMinutes: 0,
        }),
        count: async () => 0,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_FAIL_GUILD}/engagement/rank/${PUBLIC_FAIL_USER}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      userId: PUBLIC_FAIL_USER,
      username: null,
      globalName: null,
      avatarUrl: null,
      rank: 1,
      xp: 10,
      messages: 1,
      voiceMinutes: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('serves a cached Discord user without a second fetch', async () => {
    env.DISCORD_TOKEN = 'test-bot-token';
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: PUBLIC_CACHE_USER, username: 'cached', global_name: 'Cached', avatar: 'cafebabe' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { app } = await buildTestApp({
      guild: { findUnique: async () => ({ id: PUBLIC_CACHE_GUILD, botPresent: true }) },
      pluginConfig: { findUnique: async () => enabledConfig() },
      levelProfile: {
        findUnique: async () => ({
          userId: PUBLIC_CACHE_USER,
          xp: 40,
          level: 0,
          messages: 2,
          voiceMinutes: 1,
        }),
        count: async () => 1,
      },
    });

    const first = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_CACHE_GUILD}/engagement/rank/${PUBLIC_CACHE_USER}`,
    });
    const second = await app.inject({
      method: 'GET',
      url: `/guilds/${PUBLIC_CACHE_GUILD}/engagement/rank/${PUBLIC_CACHE_USER}`,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().username).toBe('cached');
    expect(second.json().globalName).toBe('Cached');
    expect(second.json().avatarUrl).toBe(
      `https://cdn.discordapp.com/avatars/${PUBLIC_CACHE_USER}/cafebabe.png`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('getCachedDiscordUser', () => {
  it('caches a miss and a failure briefly and does not fetch again', async () => {
    env.DISCORD_TOKEN = 'test-bot-token';
    const fetchMock = vi.fn(async (input: string | URL) => {
      const id = String(input).split('/').pop();
      if (id === PUBLIC_MISS_USER) return jsonResponse({ message: 'unknown' }, 404);
      return jsonResponse({ message: 'down' }, 503);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { app, redis } = await buildTestApp();

    const miss = await getCachedDiscordUser(redis, PUBLIC_MISS_USER);
    const missAgain = await getCachedDiscordUser(redis, PUBLIC_MISS_USER);
    expect(miss).toEqual({ username: null, globalName: null, avatarUrl: null });
    expect(missAgain).toEqual(miss);

    const failUser = '920000000000000028';
    const failure = await getCachedDiscordUser(redis, failUser);
    const failureAgain = await getCachedDiscordUser(redis, failUser);
    expect(failure).toEqual({ username: null, globalName: null, avatarUrl: null });
    expect(failureAgain).toEqual(failure);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const missTtl = await redis.ttl(`pavisie:discorduser:${PUBLIC_MISS_USER}`);
    const failTtl = await redis.ttl(`pavisie:discorduser:${failUser}`);
    expect(missTtl).toBeGreaterThan(0);
    expect(missTtl).toBeLessThanOrEqual(DISCORD_USER_MISS_TTL_SECONDS);
    expect(failTtl).toBeGreaterThan(0);
    expect(failTtl).toBeLessThanOrEqual(DISCORD_USER_FAILURE_TTL_SECONDS);
    expect(DISCORD_USER_CACHE_TTL_SECONDS).toBeGreaterThan(DISCORD_USER_MISS_TTL_SECONDS);
    await app.close();
  });
});
