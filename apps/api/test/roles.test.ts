import { describe, expect, it } from 'vitest';
import type { PrismaStubOverrides } from '@pavisie/plugins/sdk/testing';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '666666666666666666';
const USER_ID = '777777777777777777';

/** Minimal stateful `PluginConfig` fake (mirrors apps/api/test/plugins.test.ts's `pluginStateOverrides` pattern) — needed so `GuildConfigStore.setConfig`/`getConfig` round-trip through something that actually remembers what was written. */
function pluginConfigOverrides() {
  const store = new Map<string, Record<string, unknown>>();
  const keyOf = (args: { where: { guildId_pluginId: { guildId: string; pluginId: string } } }) =>
    `${args.where.guildId_pluginId.guildId}:${args.where.guildId_pluginId.pluginId}`;

  return {
    overrides: {
      pluginConfig: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake, args shape mirrors Prisma's generated types
        findUnique: async (args: any) => {
          const config = store.get(keyOf(args));
          return config ? { config } : null;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        upsert: async (args: any) => {
          store.set(keyOf(args), args.create.config);
          return { config: args.create.config };
        },
      },
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    },
  };
}

/** Minimal stateful `RoleGroup` fake, keyed by an incrementing id. */
function roleGroupOverrides() {
  const rows = new Map<string, Record<string, unknown>>();
  let nextId = 1;

  return {
    overrides: {
      roleGroup: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: async (args: any) => {
          const id = `group${nextId++}`;
          const row = { id, createdAt: new Date(), updatedAt: new Date(), ...args.data };
          rows.set(id, row);
          return row;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany: async (args: any) => [...rows.values()].filter((r) => r.guildId === args?.where?.guildId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findFirst: async (args: any) =>
          [...rows.values()].find((r) => r.id === args.where.id && r.guildId === args.where.guildId) ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: async (args: any) => {
          const existing = rows.get(args.where.id)!;
          const updated = { ...existing, ...args.data };
          rows.set(args.where.id, updated);
          return updated;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete: async (args: any) => {
          const existing = rows.get(args.where.id);
          rows.delete(args.where.id);
          return existing;
        },
      },
      rolePanel: { updateMany: async () => ({ count: 0 }) },
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    },
  };
}

async function authedContext(overrides: PrismaStubOverrides = {}) {
  const { app, redis, queues, prismaCalls } = await buildTestApp(overrides);
  const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  const mutHeaders = {
    cookie: cookieHeader,
    origin: 'http://localhost:3000',
    'x-csrf-token': session.csrfToken,
  };
  return { app, queues, prismaCalls, cookieHeader, mutHeaders };
}

describe('roles: welcome config', () => {
  it('PUT merges into the existing welcome section instead of replacing it, GET reflects the merge', async () => {
    const { overrides } = pluginConfigOverrides();
    const { app, cookieHeader, mutHeaders } = await authedContext(overrides);

    const setChannel = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/welcome`,
      headers: mutHeaders,
      payload: { channelId: '111', enabled: true },
    });
    expect(setChannel.statusCode).toBe(200);
    expect(setChannel.json()).toMatchObject({ enabled: true, channelId: '111', message: null });

    const setMessage = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/welcome`,
      headers: mutHeaders,
      payload: { message: 'Welcome {user}!' },
    });
    expect(setMessage.statusCode).toBe(200);
    // channelId from the first PUT must still be present — proves the merge, not a replace.
    expect(setMessage.json()).toMatchObject({ enabled: true, channelId: '111', message: 'Welcome {user}!' });

    const get = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/roles/welcome`,
      headers: { cookie: cookieHeader },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ enabled: true, channelId: '111', message: 'Welcome {user}!' });

    await app.close();
  });

  it('POST /welcome/test enqueues a bot-action job with the correct type/payload shape', async () => {
    const { overrides } = pluginConfigOverrides();
    const { app, queues, mutHeaders } = await authedContext(overrides);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/roles/welcome/test`,
      headers: mutHeaders,
      payload: { channelId: '222' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: true });

    const job = queues.calls.find((c) => c.queue === 'bot-actions');
    expect(job).toBeDefined();
    expect(job!.data).toMatchObject({
      type: 'roles.testWelcome',
      guildId: GUILD_ID,
      payload: { channelId: '222', section: 'welcome' },
    });

    await app.close();
  });
});

describe('roles: groups', () => {
  it('creates, lists, updates, and deletes a role group', async () => {
    const { overrides } = roleGroupOverrides();
    const { app, cookieHeader, mutHeaders } = await authedContext(overrides);

    const create = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/roles/groups`,
      headers: mutHeaders,
      payload: { name: 'Region', roleIds: ['1', '2'], exclusive: true },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created).toMatchObject({
      name: 'Region',
      roleIds: ['1', '2'],
      exclusive: true,
      maxSelections: null,
    });

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/roles/groups`,
      headers: { cookie: cookieHeader },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const update = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/groups/${created.id}`,
      headers: mutHeaders,
      payload: { exclusive: false, maxSelections: 2 },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ exclusive: false, maxSelections: 2, roleIds: ['1', '2'] });

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/roles/groups/${created.id}`,
      headers: mutHeaders,
    });
    expect(del.statusCode).toBe(204);

    const listAfter = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/roles/groups`,
      headers: { cookie: cookieHeader },
    });
    expect(listAfter.json()).toHaveLength(0);

    await app.close();
  });

  it('404s updating a group that does not exist', async () => {
    const { overrides } = roleGroupOverrides();
    const { app, mutHeaders } = await authedContext(overrides);
    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/groups/does-not-exist`,
      headers: mutHeaders,
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('roles: verification decide', () => {
  it('enqueues a bot-action job with the requestId/approve/note payload shape', async () => {
    const { app, queues, mutHeaders } = await authedContext({
      verificationRequest: {
        findFirst: async () => ({ id: 'req1', guildId: GUILD_ID, userId: 'u1', status: 'PENDING' }),
      },
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/roles/verification/req1/decide`,
      headers: mutHeaders,
      payload: { approve: true, note: 'looks good' },
    });
    expect(res.statusCode).toBe(200);

    const job = queues.calls.find((c) => c.queue === 'bot-actions');
    expect(job!.data).toMatchObject({
      type: 'roles.verificationDecision',
      guildId: GUILD_ID,
      payload: { requestId: 'req1', approve: true, note: 'looks good' },
    });

    await app.close();
  });

  it('404s when the request does not exist', async () => {
    const { app, mutHeaders } = await authedContext({
      verificationRequest: { findFirst: async () => null },
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/roles/verification/missing/decide`,
      headers: mutHeaders,
      payload: { approve: true },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('roles: persistence', () => {
  it('GET returns the disclosure text; POST toggles enabled and preserves maxDays when omitted', async () => {
    const { overrides } = pluginConfigOverrides();
    const { app, cookieHeader, mutHeaders } = await authedContext(overrides);

    const get = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/roles/persistence`,
      headers: { cookie: cookieHeader },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ enabled: false, maxDays: 30 });
    expect(get.json().disclosure).toMatch(/snapshot/i);

    const on = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/roles/persistence`,
      headers: mutHeaders,
      payload: { enabled: true, maxDays: 45 },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ enabled: true, maxDays: 45 });

    const toggleOnly = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/roles/persistence`,
      headers: mutHeaders,
      payload: { enabled: false },
    });
    expect(toggleOnly.statusCode).toBe(200);
    expect(toggleOnly.json()).toMatchObject({ enabled: false, maxDays: 45 }); // maxDays preserved from the previous write

    await app.close();
  });
});

describe('roles: auto-roles', () => {
  it('401s without a session', async () => {
    const { overrides } = pluginConfigOverrides();
    const { app } = await buildTestApp(overrides);

    const get = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/roles/autoroles` });
    expect(get.statusCode).toBe(401);

    const put = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/autoroles`,
      payload: { enabled: true },
    });
    expect(put.statusCode).toBe(401);

    await app.close();
  });

  it('GET returns defaults plus the re-check note', async () => {
    const { overrides } = pluginConfigOverrides();
    const { app, cookieHeader } = await authedContext(overrides);

    const get = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/roles/autoroles`,
      headers: { cookie: cookieHeader },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ enabled: false, roleIds: [], botRoleIds: [], delaySeconds: 0 });
    expect(get.json().note).toMatch(/re-checked at assignment time/i);

    await app.close();
  });

  it('400s on more than 5 human roles / 3 bot roles / an out-of-range delay', async () => {
    const { overrides } = pluginConfigOverrides();
    const { app, mutHeaders } = await authedContext(overrides);

    const tooManyHumans = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/autoroles`,
      headers: mutHeaders,
      payload: {
        roleIds: [
          '111111111111111111',
          '222222222222222222',
          '333333333333333333',
          '444444444444444444',
          '555555555555555555',
          '666666666666666666',
        ],
      },
    });
    expect(tooManyHumans.statusCode).toBe(400);

    const tooManyBots = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/autoroles`,
      headers: mutHeaders,
      payload: {
        botRoleIds: ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444'],
      },
    });
    expect(tooManyBots.statusCode).toBe(400);

    const delayTooLong = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/autoroles`,
      headers: mutHeaders,
      payload: { delaySeconds: 604_801 },
    });
    expect(delayTooLong.statusCode).toBe(400);

    await app.close();
  });

  it('400s when a roleId is not a valid Discord snowflake', async () => {
    const { overrides } = pluginConfigOverrides();
    const { app, mutHeaders } = await authedContext(overrides);

    const badRoleId = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/autoroles`,
      headers: mutHeaders,
      payload: { roleIds: ['not-a-snowflake'] },
    });
    expect(badRoleId.statusCode).toBe(400);

    const badBotRoleId = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/autoroles`,
      headers: mutHeaders,
      payload: { botRoleIds: ['12345'] }, // too short to be a real snowflake
    });
    expect(badBotRoleId.statusCode).toBe(400);

    await app.close();
  });

  it('PUT merges into the existing section, round-trips via GET, and writes a roles.autorole.update audit row', async () => {
    const { overrides } = pluginConfigOverrides();
    const { app, cookieHeader, mutHeaders, prismaCalls } = await authedContext(overrides);

    const first = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/autoroles`,
      headers: mutHeaders,
      payload: { enabled: true, roleIds: ['111111111111111111', '222222222222222222'], delaySeconds: 600 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      enabled: true,
      roleIds: ['111111111111111111', '222222222222222222'],
      botRoleIds: [],
      delaySeconds: 600,
    });

    // A second partial PUT must keep the earlier fields (merge, not replace).
    const second = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/autoroles`,
      headers: mutHeaders,
      payload: { botRoleIds: ['333333333333333333'] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      enabled: true,
      roleIds: ['111111111111111111', '222222222222222222'],
      botRoleIds: ['333333333333333333'],
      delaySeconds: 600,
    });

    const get = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/roles/autoroles`,
      headers: { cookie: cookieHeader },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      enabled: true,
      roleIds: ['111111111111111111', '222222222222222222'],
      botRoleIds: ['333333333333333333'],
      delaySeconds: 600,
    });
    expect(get.json().note).toMatch(/re-checked/i);

    const auditWrites = prismaCalls.filter(
      (c) =>
        c.model === 'auditLog' &&
        c.method === 'create' &&
        (c.args[0] as { data: { action: string } }).data.action === 'roles.autorole.update',
    );
    expect(auditWrites.length).toBe(2);
    const lastAudit = auditWrites[1]!.args[0] as {
      data: { actorId: string; source: string; after: { botRoleIds: string[] } };
    };
    expect(lastAudit.data.actorId).toBe(USER_ID);
    expect(lastAudit.data.source).toBe('DASHBOARD');
    expect(lastAudit.data.after.botRoleIds).toEqual(['333333333333333333']);

    await app.close();
  });
});
