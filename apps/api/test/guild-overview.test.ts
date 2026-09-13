import type { PrismaStubOverrides } from '@pavisie/plugins/sdk/testing';
import { describe, expect, it } from 'vitest';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const USER_ID = '700000000000000002';

// A distinct guildId per test, not just per `it` block sharing one constant: `GuildConfigStore.getGuildConfig`
// caches in the (globally-shared, same-host:port) `ioredis-mock` store for 300s, so reusing one guildId across
// tests in this file would let an earlier test's cached config leak into a later test's assertions.
function guildRow(guildId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: guildId,
    name: 'Test Guild',
    iconHash: 'abc123hash',
    ownerId: '700000000000000099',
    botPresent: true,
    memberCount: 42,
    joinedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** `GuildConfig` row with no mod-log channel and no mod roles set — the platform default shape. */
function incompleteConfigRow(guildId: string) {
  return {
    guildId,
    locale: 'en',
    timezone: 'UTC',
    adminRoleIds: [],
    modRoleIds: [],
    helperRoleIds: [],
    modLogChannelId: null,
    staffChannelId: null,
    appealsChannelId: null,
    fastActions: false,
    dataCollectionEnabled: false,
    logMessageContent: false,
    dmOnModeration: true,
    setupCompletedAt: null,
  };
}

/** Same guild, but setup has been completed: a mod-log channel and at least one mod role are configured. */
function completeConfigRow(guildId: string) {
  return {
    ...incompleteConfigRow(guildId),
    modLogChannelId: '700000000000000003',
    modRoleIds: ['700000000000000004'],
  };
}

function overridesWithCounts(extra: PrismaStubOverrides = {}): PrismaStubOverrides {
  return {
    ticket: { count: async () => 2 },
    enforcerRecord: { count: async () => 1 },
    moderationCase: { count: async () => 3 },
    ...extra,
  };
}

describe('GET /guilds/:guildId overview', () => {
  it('returns the full overview for a guild the user manages, with setup issues when config is unset', async () => {
    const guildId = '700000000000000101';
    const { app, redis } = await buildTestApp(
      overridesWithCounts({
        guild: { findUnique: async () => guildRow(guildId) },
        guildConfig: { findUnique: async () => incompleteConfigRow(guildId) },
      }),
    );
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: guildId, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${guildId}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.guild.name).toBe('Test Guild');
    expect(body.guild.iconUrl).toBe(`https://cdn.discordapp.com/icons/${guildId}/abc123hash.png`);
    expect(body.guild.botPresent).toBe(true);

    expect(body.stats.memberCount).toBe(42);
    expect(body.stats.openTickets).toBe(2);
    expect(body.stats.pendingReviews).toBe(1);
    expect(body.stats.moderationCasesLast7d).toBe(3);

    expect(Array.isArray(body.plugins)).toBe(true);
    expect(body.plugins.length).toBeGreaterThan(0);
    const expectedEnabled = body.plugins.filter((p: { enabled: boolean }) => p.enabled).length;
    expect(body.stats.pluginsEnabled).toBe(expectedEnabled);
    expect(body.stats.pluginCount).toBe(body.plugins.length);

    expect(body.setupIncomplete).toBe(true);
    expect(body.setupIssues).toEqual(
      expect.arrayContaining([
        'No mod-log channel configured (set one under Settings).',
        'No moderator roles configured (set them under Settings).',
      ]),
    );
    // Bot is present, so the "not in this server" issue must not appear.
    expect(body.setupIssues).not.toEqual(
      expect.arrayContaining(['Pavisie is not in this server yet — invite it from the server list.']),
    );

    await app.close();
  });

  it('reports no setup issues once mod-log channel and mod roles are configured', async () => {
    const guildId = '700000000000000102';
    const { app, redis } = await buildTestApp(
      overridesWithCounts({
        guild: { findUnique: async () => guildRow(guildId) },
        guildConfig: { findUnique: async () => completeConfigRow(guildId) },
      }),
    );
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: guildId, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${guildId}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.setupIncomplete).toBe(false);
    expect(body.setupIssues).toEqual([]);

    await app.close();
  });

  it('returns an "Unknown server" placeholder guild, botPresent false, when the guild row is missing', async () => {
    const guildId = '700000000000000103';
    const { app, redis } = await buildTestApp(
      overridesWithCounts({
        guild: { findUnique: async () => null },
        guildConfig: { findUnique: async () => incompleteConfigRow(guildId) },
      }),
    );
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    // Session user can manage the guild per their cached Discord guild list even though the bot has never synced it.
    await seedUserGuilds(redis, USER_ID, [{ id: guildId, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${guildId}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.guild.name).toBe('Unknown server');
    expect(body.guild.iconUrl).toBeNull();
    expect(body.guild.botPresent).toBe(false);
    expect(body.guild.canManage).toBe(true);
    expect(body.guild.owner).toBe(false);
    expect(body.setupIncomplete).toBe(true);
    expect(body.setupIssues).toEqual(
      expect.arrayContaining(['Pavisie is not in this server yet — invite it from the server list.']),
    );

    await app.close();
  });

  it('keeps the deprecated top-level pluginCount/pluginsEnabled in sync with stats', async () => {
    const guildId = '700000000000000104';
    const { app, redis } = await buildTestApp(
      overridesWithCounts({
        guild: { findUnique: async () => guildRow(guildId) },
        guildConfig: { findUnique: async () => completeConfigRow(guildId) },
      }),
    );
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: guildId, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${guildId}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.pluginCount).toBe(body.stats.pluginCount);
    expect(body.pluginsEnabled).toBe(body.stats.pluginsEnabled);

    await app.close();
  });
});
