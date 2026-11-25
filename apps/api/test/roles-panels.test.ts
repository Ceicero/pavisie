import { describe, expect, it, vi } from 'vitest';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

// Discord role-hierarchy checks need a live bot token; they are covered elsewhere. Here we only care about persistence.
vi.mock('../src/lib/roles/assignability', () => ({ assertPanelRolesAssignable: async () => undefined }));

const GUILD_ID = '666666666666666666';
const USER_ID = '777777777777777777';
const PANEL_ID = 'panel1';

describe('roles: panel update', () => {
  it('replaces options in the same update call, never in a separate delete', async () => {
    const row = {
      id: PANEL_ID,
      guildId: GUILD_ID,
      channelId: '1',
      messageId: null,
      title: 'Pick',
      description: null,
      style: 'BUTTONS',
      maxSelections: null,
      groupId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      options: [],
    };
    const { app, redis, prismaCalls } = await buildTestApp({
      rolePanel: { findFirst: async () => row, update: async () => row },
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
      pluginConfig: { findUnique: async () => null, upsert: async () => ({ config: {} }) },
    });
    const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/panels/${PANEL_ID}`,
      headers: { cookie: cookieHeader, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken },
      payload: { options: [{ roleId: '5', label: 'A' }] },
    });
    expect(res.statusCode).toBe(200);

    expect(prismaCalls.some((c) => c.model === 'rolePanelOption' && c.method === 'deleteMany')).toBe(false);
    const update = prismaCalls.find((c) => c.model === 'rolePanel' && c.method === 'update');
    const data = (update!.args[0] as { data: { options: { deleteMany: unknown; create: unknown[] } } }).data;
    expect(data.options.deleteMany).toEqual({});
    expect(data.options.create).toHaveLength(1);
  });

  it('keeps the submitted option order when the dashboard omits position', async () => {
    const { app, cookieHeader, session, prismaCalls } = await setupPanelApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/panels/${PANEL_ID}`,
      headers: { cookie: cookieHeader, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken },
      payload: {
        options: [
          { roleId: '5', label: 'A' },
          { roleId: '6', label: 'B' },
          { roleId: '7', label: 'C' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(createdPositions(prismaCalls, 'update')).toEqual([0, 1, 2]);
  });

  it('honors an explicit position on update', async () => {
    const { app, cookieHeader, session, prismaCalls } = await setupPanelApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/roles/panels/${PANEL_ID}`,
      headers: { cookie: cookieHeader, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken },
      payload: {
        options: [
          { roleId: '5', label: 'A', position: 2 },
          { roleId: '6', label: 'B', position: 0 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(createdPositions(prismaCalls, 'update')).toEqual([2, 0]);
  });
});

describe('roles: panel create', () => {
  it('keeps the submitted option order when the dashboard omits position', async () => {
    const { app, cookieHeader, session, prismaCalls } = await setupPanelApp();
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/roles/panels`,
      headers: { cookie: cookieHeader, origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken },
      payload: {
        channelId: '1',
        title: 'Pick',
        style: 'BUTTONS',
        options: [
          { roleId: '5', label: 'A' },
          { roleId: '6', label: 'B' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(createdPositions(prismaCalls, 'create')).toEqual([0, 1]);
  });
});

function panelRow() {
  return {
    id: PANEL_ID,
    guildId: GUILD_ID,
    channelId: '1',
    messageId: null,
    title: 'Pick',
    description: null,
    style: 'BUTTONS',
    maxSelections: null,
    groupId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    options: [],
  };
}

async function setupPanelApp() {
  const row = panelRow();
  const { app, redis, prismaCalls } = await buildTestApp({
    rolePanel: { findFirst: async () => row, update: async () => row, create: async () => row },
    guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    pluginConfig: { findUnique: async () => null, upsert: async () => ({ config: {} }) },
  });
  const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  return { app, cookieHeader, session, prismaCalls };
}

/** Positions of the option rows written by the `rolePanel.create`/`rolePanel.update` nested write, in submitted order. */
function createdPositions(
  prismaCalls: { model: string; method: string; args: unknown[] }[],
  method: 'create' | 'update',
): unknown[] {
  const call = prismaCalls.find((c) => c.model === 'rolePanel' && c.method === method);
  const data = (call!.args[0] as { data: { options: { create: { position: unknown }[] } } }).data;
  return data.options.create.map((o) => o.position);
}
