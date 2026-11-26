import { describe, expect, it, vi } from 'vitest';
import { toRolePanelDto } from '../src/lib/dto';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

vi.mock('../src/lib/roles/assignability', () => ({ assertPanelRolesAssignable: async () => undefined }));

const GUILD_ID = '666666666666666666';
const USER_ID = '777777777777777777';

function panelRow(groupId: string | null) {
  return {
    id: 'panel1',
    guildId: GUILD_ID,
    channelId: '1',
    messageId: null,
    title: 'Pick',
    description: null,
    style: 'BUTTONS' as const,
    maxSelections: null,
    groupId,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    options: [],
  };
}

// The dashboard's edit dialog rebuilds its form from this DTO and PUTs it back whole. Without `groupId` here the
// dialog had nothing to pre-fill, sent `groupId: null`, and every edit silently unlinked the panel from its group.
describe('role panel DTO: groupId round-trip', () => {
  it('toRolePanelDto carries the linked group id', () => {
    expect(toRolePanelDto(panelRow('group1')).groupId).toBe('group1');
  });

  it('toRolePanelDto reports an unlinked panel as null, not undefined', () => {
    expect(toRolePanelDto(panelRow(null)).groupId).toBeNull();
  });

  it('GET /roles/panels returns groupId to the dashboard', async () => {
    const { app, redis } = await buildTestApp({
      rolePanel: { findMany: async () => [panelRow('group1'), panelRow(null)] },
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/roles/panels`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((p: { groupId: string | null }) => p.groupId)).toEqual(['group1', null]);
    await app.close();
  });
});
