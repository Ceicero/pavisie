import RedisMock from 'ioredis-mock';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { GuildConfigStore, PluginRegistry, defineManifest, definePlugin } from '../src/sdk';
import { createPrismaStub } from '../src/sdk/testing';

const configSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().default(5),
});

function buildModerationRegistry(): PluginRegistry {
  const manifest = defineManifest({
    id: 'moderation',
    name: 'Moderation',
    description: 'test plugin',
    category: 'moderation',
    version: '0.1.0',
    defaultEnabled: true,
    permissions: [],
    intents: [],
    requiredEnv: [],
    configSchema,
  });
  return new PluginRegistry([definePlugin({ manifest, commands: [] })]);
}

function buildAdminRegistry(): PluginRegistry {
  const manifest = defineManifest({
    id: 'admin',
    name: 'Admin',
    description: 'test plugin',
    category: 'admin',
    version: '0.1.0',
    defaultEnabled: true,
    alwaysEnabled: true,
    permissions: [],
    intents: [],
    requiredEnv: [],
    configSchema: z.object({}).passthrough(),
  });
  return new PluginRegistry([definePlugin({ manifest, commands: [] })]);
}

describe('GuildConfigStore', () => {
  it('getConfig merges stored config over manifest defaults and caches the result', async () => {
    const registry = buildModerationRegistry();
    const redis = new RedisMock();
    const { prisma, calls } = createPrismaStub({
      pluginConfig: { findUnique: async () => ({ config: { threshold: 9 } }) },
    });
    const store = new GuildConfigStore(prisma, redis, registry);

    const config = await store.getConfig('g1', 'moderation');
    expect(config).toEqual({ enabled: true, threshold: 9 });

    const findsBefore = calls.filter((c) => c.model === 'pluginConfig' && c.method === 'findUnique').length;
    await store.getConfig('g1', 'moderation'); // should hit the redis cache, not prisma again
    const findsAfter = calls.filter((c) => c.model === 'pluginConfig' && c.method === 'findUnique').length;
    expect(findsAfter).toBe(findsBefore);
  });

  it('setConfig shallow-merges the patch, persists it, invalidates the cache, and writes an audit entry', async () => {
    const registry = buildModerationRegistry();
    const redis = new RedisMock();
    let stored: Record<string, unknown> | null = null;
    const auditWrites: unknown[] = [];
    const { prisma } = createPrismaStub({
      pluginConfig: {
        findUnique: async () => (stored ? { config: stored } : null),
        upsert: async (...args: unknown[]) => {
          const { create } = args[0] as { create: { config: Record<string, unknown> } };
          stored = create.config;
          return { config: stored };
        },
      },
      auditLog: {
        create: async (...args: unknown[]) => {
          const { data } = args[0] as { data: unknown };
          auditWrites.push(data);
          return data;
        },
      },
    });
    const store = new GuildConfigStore(prisma, redis, registry);

    const updated = await store.setConfig('g1', 'moderation', { threshold: 10 }, { id: 'u1', source: 'bot' });
    expect(updated).toEqual({ enabled: true, threshold: 10 });
    expect(auditWrites).toHaveLength(1);

    const reread = await store.getConfig('g1', 'moderation');
    expect(reread).toEqual({ enabled: true, threshold: 10 });
  });

  it('invalidate(guildId) clears the cache for every registered plugin plus the core guild config cache', async () => {
    const registry = buildModerationRegistry();
    const redis = new RedisMock();
    const { prisma } = createPrismaStub();
    const store = new GuildConfigStore(prisma, redis, registry);

    await store.getConfig('g1', 'moderation');
    await store.getGuildConfig('g1');

    expect(await redis.get('pavisie:cfg:g1:moderation')).not.toBeNull();
    expect(await redis.get('pavisie:guildcfg:g1')).not.toBeNull();

    await store.invalidate('g1');

    expect(await redis.get('pavisie:cfg:g1:moderation')).toBeNull();
    expect(await redis.get('pavisie:guildcfg:g1')).toBeNull();
  });

  it("invalidate(guildId, pluginId) clears only that plugin's cache", async () => {
    const registry = buildModerationRegistry();
    const redis = new RedisMock();
    const { prisma } = createPrismaStub();
    const store = new GuildConfigStore(prisma, redis, registry);

    await store.getConfig('g1', 'moderation');
    await store.getGuildConfig('g1');

    await store.invalidate('g1', 'moderation');

    expect(await redis.get('pavisie:cfg:g1:moderation')).toBeNull();
    expect(await redis.get('pavisie:guildcfg:g1')).not.toBeNull();
  });

  it('isEnabled returns true for alwaysEnabled plugins without touching prisma', async () => {
    const registry = buildAdminRegistry();
    const redis = new RedisMock();
    const { prisma, calls } = createPrismaStub();
    const store = new GuildConfigStore(prisma, redis, registry);

    expect(await store.isEnabled('g1', 'admin')).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('setEnabled refuses alwaysEnabled plugins', async () => {
    const registry = buildAdminRegistry();
    const redis = new RedisMock();
    const { prisma } = createPrismaStub();
    const store = new GuildConfigStore(prisma, redis, registry);

    await expect(store.setEnabled('g1', 'admin', false, { id: 'u1', source: 'bot' })).rejects.toThrow(
      /always enabled/i,
    );
  });

  it('setConfig rejects a patch with an unknown top-level key instead of silently dropping it', async () => {
    const registry = buildModerationRegistry();
    const redis = new RedisMock();
    const { prisma, calls } = createPrismaStub();
    const store = new GuildConfigStore(prisma, redis, registry);

    await expect(
      store.setConfig('g1', 'moderation', { notAField: true }, { id: 'u1', source: 'bot' }),
    ).rejects.toThrow(/Unknown config field\(s\): "notAField".*Valid fields for plugin "moderation": enabled, threshold/);
    // Rejected before touching prisma at all — this backstop protects every caller (dashboard routes and bot
    // commands alike), not just the ones that already validate keys themselves.
    expect(calls).toHaveLength(0);
  });

  it('getGuildConfig returns platform defaults when no row exists, without writing one', async () => {
    const registry = buildModerationRegistry();
    const redis = new RedisMock();
    const { prisma, calls } = createPrismaStub({ guildConfig: { findUnique: async () => null } });
    const store = new GuildConfigStore(prisma, redis, registry);

    const config = await store.getGuildConfig('g1');
    expect(config).toMatchObject({ guildId: 'g1', locale: 'en', timezone: 'UTC', fastActions: false });
    expect(
      calls.some((c) => c.model === 'guildConfig' && (c.method === 'create' || c.method === 'upsert')),
    ).toBe(false);
  });
});
