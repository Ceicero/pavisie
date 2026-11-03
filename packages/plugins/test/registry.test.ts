import { SlashCommandBuilder } from 'discord.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { GatewayIntentBits } from 'discord.js';
import { PluginRegistry, defineManifest, definePlugin, type Plugin } from '../src/sdk';
import { allPlugins } from '../src/index';

function makeCommand(name: string) {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(`Test command ${name}`),
    async execute() {
      /* no-op for tests */
    },
  };
}

function makePlugin(
  id: string,
  opts: { commandNames?: string[]; componentActions?: string[]; alwaysEnabled?: boolean } = {},
): Plugin {
  const manifest = defineManifest({
    // Cast: test fixtures use arbitrary ids outside the real PluginId union on purpose.
    id: id as never,
    name: id,
    description: `Test plugin ${id}`,
    category: 'utility',
    version: '0.1.0',
    defaultEnabled: true,
    alwaysEnabled: opts.alwaysEnabled,
    permissions: [],
    intents: [],
    requiredEnv: [],
    configSchema: z.object({}).passthrough(),
  });

  return definePlugin({
    manifest,
    commands: (opts.commandNames ?? []).map(makeCommand),
    components: (opts.componentActions ?? []).map((action) => ({
      action,
      kind: 'button' as const,
      async handler() {
        /* no-op */
      },
    })),
  });
}

describe('PluginRegistry', () => {
  it('throws on duplicate plugin ids', () => {
    const a = makePlugin('dup');
    const b = makePlugin('dup');
    expect(() => new PluginRegistry([a, b])).toThrow(/duplicate plugin id/i);
  });

  it('throws on duplicate command names across plugins', () => {
    const a = makePlugin('a', { commandNames: ['shared'] });
    const b = makePlugin('b', { commandNames: ['shared'] });
    expect(() => new PluginRegistry([a, b])).toThrow(/duplicate command name/i);
  });

  it('throws on duplicate component actions within a plugin', () => {
    const a = makePlugin('a', { componentActions: ['confirm', 'confirm'] });
    expect(() => new PluginRegistry([a])).toThrow(/duplicate component action/i);
  });

  it('throws when defaultConfig fails its own configSchema', () => {
    // Build with a *valid* defaultConfig first (defineManifest validates eagerly and would throw otherwise),
    // then corrupt it afterwards to exercise PluginRegistry's own independent validation.
    const manifest = defineManifest({
      id: 'bad' as never,
      name: 'bad',
      description: 'bad',
      category: 'utility',
      version: '0.1.0',
      defaultEnabled: true,
      permissions: [],
      intents: [],
      requiredEnv: [],
      configSchema: z.object({ required: z.string() }),
      defaultConfig: { required: 'ok' },
    });
    const brokenManifest = { ...manifest, defaultConfig: {} };
    const plugin = definePlugin({ manifest: brokenManifest, commands: [] });
    expect(() => new PluginRegistry([plugin])).toThrow(/defaultConfig/);
  });

  it('builds commandsJson, requiredIntents, and availability for a valid set of plugins', () => {
    const a = makePlugin('a', { commandNames: ['cmd-a'] });
    const registry = new PluginRegistry([a]);

    expect(registry.get('a' as never)).toBe(a);
    expect(registry.list()).toEqual([a]);
    expect(registry.commandsJson()).toHaveLength(1);
    expect(registry.commandsJson()[0]).toMatchObject({ name: 'cmd-a' });

    const intents = registry.requiredIntents({
      messageContent: true,
      guildMembers: true,
      guildPresences: true,
    });
    expect(intents).toEqual([]); // plugin 'a' declares no intents and no privileged intents

    const availability = registry.availability(
      {},
      { messageContent: false, guildMembers: true, guildPresences: false },
    );
    expect(availability.get('a' as never)).toEqual({ available: true });
  });

  it('reports unavailable plugins with missing required env vars', () => {
    const manifest = defineManifest({
      id: 'needs-env' as never,
      name: 'needs-env',
      description: 'needs env',
      category: 'utility',
      version: '0.1.0',
      defaultEnabled: true,
      permissions: [],
      intents: [],
      requiredEnv: ['SOME_VAR'],
      configSchema: z.object({}).passthrough(),
    });
    const plugin = definePlugin({ manifest, commands: [] });
    const registry = new PluginRegistry([plugin]);

    const availability = registry.availability(
      {},
      { messageContent: false, guildMembers: false, guildPresences: false },
    );
    expect(availability.get('needs-env' as never)).toMatchObject({
      available: false,
      reason: expect.stringContaining('SOME_VAR'),
    });
  });

  it('reports degraded plugins when a needed privileged intent is not enabled', () => {
    const manifest = defineManifest({
      id: 'needs-intent' as never,
      name: 'needs-intent',
      description: 'needs intent',
      category: 'utility',
      version: '0.1.0',
      defaultEnabled: true,
      permissions: [],
      intents: [],
      privilegedIntents: ['MessageContent'],
      requiredEnv: [],
      configSchema: z.object({}).passthrough(),
    });
    const plugin = definePlugin({ manifest, commands: [] });
    const registry = new PluginRegistry([plugin]);

    const availability = registry.availability(
      {},
      { messageContent: false, guildMembers: false, guildPresences: false },
    );
    expect(availability.get('needs-intent' as never)).toMatchObject({ available: true, degraded: true });

    const intents = registry.requiredIntents({
      messageContent: true,
      guildMembers: false,
      guildPresences: false,
    });
    expect(intents).toEqual([GatewayIntentBits.MessageContent]);
  });

  it('constructs successfully from the real allPlugins export (smoke test)', () => {
    expect(() => new PluginRegistry(allPlugins)).not.toThrow();
    const registry = new PluginRegistry(allPlugins);
    expect(registry.get('admin')).toBeDefined();
    expect(registry.list()).toHaveLength(14);
    expect(registry.commandsJson().length).toBeGreaterThanOrEqual(5); // admin's 5 commands, at minimum
  });
});
