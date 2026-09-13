import { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { PluginId } from '@pavisie/types';
import { PluginRegistry } from '../registry';
import type { Plugin } from '../types';

function createMockPlugin(id: PluginId, commands: any[]): Plugin {
  return {
    manifest: {
      id,
      name: `${id} plugin`,
      description: `${id} description`,
      category: 'utility',
      version: '0.1.0',
      defaultEnabled: true,
      alwaysEnabled: false,
      permissions: [],
      intents: [],
      requiredEnv: [],
      configSchema: {
        safeParse: () => ({ success: true }),
      } as any,
      defaultConfig: {},
    },
    commands,
    components: [],
  };
}

describe('PluginRegistry command hint application', () => {
  it('applies help hint to chat-input command descriptions', () => {
    const slashCmd = new SlashCommandBuilder()
      .setName('test')
      .setDescription('A test command');

    const plugin = createMockPlugin('test' as PluginId, [
      {
        data: slashCmd,
        requirement: { guildOnly: true },
        execute: async () => {},
      },
    ]);

    const registry = new PluginRegistry([plugin]);
    const json = registry.commandsJson();

    expect(json).toHaveLength(1);
    const desc = (json[0] as any).description as string;
    expect(desc).toContain('+help');
    expect(desc).toContain('A test command');
    expect(desc.length).toBeLessThanOrEqual(100);
  });

  it('keeps context-menu command descriptions unchanged', () => {
    const contextCmd = new ContextMenuCommandBuilder()
      .setName('user-info')
      .setType(ApplicationCommandType.User);

    const plugin = createMockPlugin('utility' as PluginId, [
      {
        data: contextCmd,
        requirement: { guildOnly: true },
        execute: async () => {},
      },
    ]);

    const registry = new PluginRegistry([plugin]);
    const json = registry.commandsJson();

    expect(json).toHaveLength(1);
    // Context menu commands don't have description field
    expect('description' in (json[0] as any)).toBe(false);
  });

  it('ensures all chat-input command descriptions are ≤ 100 characters', () => {
    const longDescCmd = new SlashCommandBuilder()
      .setName('longdesc')
      .setDescription('This is a very long description that goes on and on and on without stopping at all today');

    const plugin = createMockPlugin('test' as PluginId, [
      {
        data: longDescCmd,
        requirement: { guildOnly: true },
        execute: async () => {},
      },
    ]);

    const registry = new PluginRegistry([plugin]);
    const json = registry.commandsJson();

    const desc = (json[0] as any).description as string;
    expect(desc.length).toBeLessThanOrEqual(100);
    expect(desc).toContain('+help');
  });

  it('is idempotent when description already contains +help', () => {
    const cmdWithHelp = new SlashCommandBuilder()
      .setName('withhelp')
      .setDescription('See +help for more info');

    const plugin = createMockPlugin('test' as PluginId, [
      {
        data: cmdWithHelp,
        requirement: { guildOnly: true },
        execute: async () => {},
      },
    ]);

    const registry = new PluginRegistry([plugin]);
    const json = registry.commandsJson();

    // Should not append the suffix again if +help already mentioned
    const desc = (json[0] as any).description as string;
    expect(desc).toBe('See +help for more info');
  });
});
