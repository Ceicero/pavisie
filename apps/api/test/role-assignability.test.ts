import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@pavisie/core';
import { assertPanelRolesAssignable } from '../src/lib/roles/assignability';

const GUILD = '100000000000000001';
const OWNER = '200000000000000001';
const MOD = '200000000000000002';
const BOT = '300000000000000001';
const ADMINISTRATOR = String(1n << 3n);

// positions: everyone 0, low 1, mid 3, mod-top 4, bot-top 6, high 8
const roles = [
  { id: GUILD, name: '@everyone', position: 0, managed: false, permissions: '0' },
  { id: 'low', name: 'Low', position: 1, managed: false, permissions: '0' },
  { id: 'mid', name: 'Mid', position: 3, managed: false, permissions: '0' },
  { id: 'modtop', name: 'Mod', position: 4, managed: false, permissions: '0' },
  { id: 'admin', name: 'Admin', position: 2, managed: false, permissions: ADMINISTRATOR },
  { id: 'integration', name: 'Integration', position: 2, managed: true, permissions: '0' },
  { id: 'bottop', name: 'Bot', position: 6, managed: false, permissions: '0' },
  { id: 'high', name: 'High', position: 8, managed: false, permissions: '0' },
];

function stubDiscord() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.replace('https://discord.com/api/v10', '');
      const body =
        path === `/guilds/${GUILD}/roles`
          ? roles
          : path === `/guilds/${GUILD}`
            ? { owner_id: OWNER }
            : path === '/users/@me'
              ? { id: BOT }
              : path === `/guilds/${GUILD}/members/${BOT}`
                ? { roles: ['bottop'] }
                : path === `/guilds/${GUILD}/members/${MOD}`
                  ? { roles: ['modtop', 'low'] }
                  : null;
      return new Response(JSON.stringify(body), { status: body === null ? 404 : 200 });
    }),
  );
}

const originalToken = env.DISCORD_TOKEN;
beforeEach(() => {
  env.DISCORD_TOKEN = 'test-bot-token';
  stubDiscord();
});
afterEach(() => {
  env.DISCORD_TOKEN = originalToken;
  vi.unstubAllGlobals();
});

const check = (actorId: string, roleIds: string[], allowElevatedRoles = false) =>
  assertPanelRolesAssignable({ guildId: GUILD, actorId, roleIds, allowElevatedRoles });

describe('assertPanelRolesAssignable', () => {
  it('allows roles below both the actor and the bot', async () => {
    await expect(check(MOD, ['low', 'mid'])).resolves.toBeUndefined();
  });
  it("refuses a role at or above the actor's own top role", async () => {
    await expect(check(MOD, ['modtop'])).rejects.toThrow(/your own highest role/);
  });
  it("refuses a role at or above the bot's top role, even for the owner", async () => {
    await expect(check(OWNER, ['high'])).rejects.toThrow(/bot's highest role/);
  });
  it('lets the guild owner add roles above their own position (below the bot)', async () => {
    await expect(check(OWNER, ['modtop'])).resolves.toBeUndefined();
  });
  it('refuses integration-managed roles', async () => {
    await expect(check(MOD, ['integration'])).rejects.toThrow(/managed/);
  });
  it('refuses elevated roles unless allowElevatedRoles', async () => {
    await expect(check(MOD, ['admin'])).rejects.toThrow(/elevated/);
    await expect(check(MOD, ['admin'], true)).resolves.toBeUndefined();
  });
  it('refuses unknown roles and @everyone', async () => {
    await expect(check(MOD, ['nope'])).rejects.toThrow(/not an assignable role/);
    await expect(check(MOD, [GUILD])).rejects.toThrow(/not an assignable role/);
  });
  it('fails closed with 503 when the API has no bot token', async () => {
    env.DISCORD_TOKEN = undefined as unknown as string;
    await expect(check(MOD, ['low'])).rejects.toMatchObject({
      status: 503,
      code: 'role_checks_unavailable',
      message: expect.stringContaining('Role checks unavailable'),
    });
  });
});
