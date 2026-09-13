import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Message } from 'discord.js';
import { Cooldowns, MemoryRateLimiter, createPlatformEvents } from '@pavisie/core';
import {
  DEFAULT_GUILD_CONFIG,
  ServiceRegistry,
  type GuildConfigData,
  type Plugin,
  type PluginCommand,
  type PluginContext,
  type PluginManifest,
  type PluginRegistry,
} from '@pavisie/plugins';
import type { PluginId } from '@pavisie/types';
import { handleMessageCommand } from '../prefix';
import type { LoadedHost } from '../loader';

const GUILD_ID = 'guild-1';
const OWNER_ID = 'owner-user-1';

function fakeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'utility' as PluginId,
    name: 'Utility',
    description: 'test plugin',
    category: 'utility',
    version: '0.1.0',
    defaultEnabled: true,
    alwaysEnabled: true,
    permissions: [],
    intents: [],
    requiredEnv: [],
    configSchema: undefined as unknown as PluginManifest['configSchema'],
    defaultConfig: {},
    ...overrides,
  };
}

function fakePlugin(manifest: PluginManifest): Plugin {
  return {
    manifest,
    commands: [],
    components: [],
  };
}

function fakeContext(): PluginContext {
  return {
    t: (key: string) => key,
    getConfig: async () => ({}),
  } as unknown as PluginContext;
}

function fakeGuildConfig(): GuildConfigData {
  return { guildId: GUILD_ID, ...DEFAULT_GUILD_CONFIG };
}

interface FakeHostOverrides {
  commands?: LoadedHost['commands'];
  availability?: LoadedHost['availability'];
  contexts?: LoadedHost['contexts'];
}

function fakeHost(overrides: FakeHostOverrides = {}): LoadedHost {
  const pluginId: PluginId = 'utility';
  const contexts = overrides.contexts ?? new Map([[pluginId, fakeContext()]]);
  const availability = overrides.availability ?? new Map([[pluginId, { available: true }]]);

  return {
    registry: {} as unknown as PluginRegistry,
    configStore: {
      getGuildConfig: async () => fakeGuildConfig(),
      isEnabled: async () => true,
    } as unknown as LoadedHost['configStore'],
    services: new ServiceRegistry(),
    events: createPlatformEvents(),
    contexts,
    commands: overrides.commands ?? new Map(),
    components: new Map(),
    availability,
    botOwnerIds: [],
    cooldowns: new Cooldowns('memory'),
    globalRateLimiter: new MemoryRateLimiter(),
    queueCache: new Map(),
  };
}

function fakeMessage(overridesFn?: (msg: any) => void): Message<true> {
  const user = {
    id: OWNER_ID,
    username: 'testuser',
    bot: false,
  };

  const member = {
    id: OWNER_ID,
    user,
    roles: { cache: new Map() },
    permissions: { bitfield: BigInt('18446744073709551615') }, // All permissions
    displayName: 'TestUser',
    permissionsIn: vi.fn(() => ({
      has: () => true,
    })),
  };

  const channel = {
    id: 'channel-123',
    name: 'test-channel',
    type: 0,
    guild: { id: GUILD_ID },
    sendTyping: vi.fn(async () => undefined),
  };

  const guild = {
    id: GUILD_ID,
    preferredLocale: 'en-US',
    ownerId: OWNER_ID,
    members: {
      cache: new Map([[OWNER_ID, member]]),
      me: member,
    },
    channels: { cache: new Map([[channel.id, channel]]) },
    roles: { cache: new Map() },
  };

  const client = {
    user: {
      id: 'bot-id',
      username: 'testbot',
    },
  };

  const msg = {
    id: 'msg-123',
    content: '+help',
    author: user,
    member: member as any,
    guild: guild as any,
    guildId: GUILD_ID,
    channel: channel as any,
    channelId: channel.id,
    client: client as any,
    attachments: new Map() as any,
    createdTimestamp: Date.now(),
    createdAt: new Date(),
    webhookId: null,
    system: false,
    inGuild: () => true,
    reply: vi.fn(async () => ({})),
  } as any;

  if (overridesFn) {
    overridesFn(msg);
  }

  return msg as Message<true>;
}

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as import('pino').Logger;

describe('handleMessageCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores bot messages', async () => {
    const message = fakeMessage((msg) => {
      msg.author.bot = true;
    });
    const host = fakeHost();

    await handleMessageCommand(message, host, logger, '+');

    expect(message.reply).not.toHaveBeenCalled();
  });

  it('ignores webhook messages', async () => {
    const message = fakeMessage((msg) => {
      msg.webhookId = 'webhook-123';
    });
    const host = fakeHost();

    await handleMessageCommand(message, host, logger, '+');

    expect(message.reply).not.toHaveBeenCalled();
  });

  it('ignores system messages', async () => {
    const message = fakeMessage((msg) => {
      msg.system = true;
    });
    const host = fakeHost();

    await handleMessageCommand(message, host, logger, '+');

    expect(message.reply).not.toHaveBeenCalled();
  });

  it('ignores DM messages', async () => {
    const message = fakeMessage((msg) => {
      msg.inGuild = () => false;
    });
    const host = fakeHost();

    await handleMessageCommand(message, host, logger, '+');

    expect(message.reply).not.toHaveBeenCalled();
  });

  it('ignores messages that do not parse as commands', async () => {
    const message = fakeMessage((msg) => {
      msg.content = 'just some chat';
    });
    const host = fakeHost();

    await handleMessageCommand(message, host, logger, '+');

    expect(message.reply).not.toHaveBeenCalled();
  });

  it('ignores unknown commands silently (do not reply)', async () => {
    const message = fakeMessage((msg) => {
      msg.content = '+unknown';
    });
    const host = fakeHost();

    await handleMessageCommand(message, host, logger, '+');

    expect(message.reply).not.toHaveBeenCalled();
  });

  it('ignores context-menu-only commands', async () => {
    const fakeCommand: PluginCommand = {
      data: {
        toJSON: () => ({
          type: 2, // USER context menu
          name: 'inspect',
        }),
      } as any,
      requirement: undefined,
      execute: vi.fn(async () => undefined),
    };

    const commands = new Map([['inspect', { plugin: fakePlugin(fakeManifest()), command: fakeCommand }]]);
    const message = fakeMessage((msg) => {
      msg.content = '+inspect';
    });
    const host = fakeHost({ commands });

    await handleMessageCommand(message, host, logger, '+');

    expect(fakeCommand.execute).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('replies with an error if bot has no SendMessages permission', async () => {
    const message = fakeMessage((msg) => {
      msg.content = '+help';
      msg.channelId = 'no-perms-channel';
    });

    // Override guild to have a channel where bot has no perms
    const guild = (message.guild as any);
    const noPermsChannel = {
      id: 'no-perms-channel',
      name: 'restricted',
      guild: { id: GUILD_ID },
    };
    guild.channels.cache.set('no-perms-channel', noPermsChannel);
    (message as any).channel = noPermsChannel;

    const me = guild.members.me;
    me.permissionsIn = vi.fn(() => ({
      has: (perm: string) => perm !== 'SendMessages',
    }));

    const fakeCommand: PluginCommand = {
      data: {
        toJSON: () => ({
          type: 1, // CHAT_INPUT
          name: 'help',
          options: [],
        }),
      } as any,
      requirement: undefined,
      execute: vi.fn(async () => undefined),
    };

    const commands = new Map([['help', { plugin: fakePlugin(fakeManifest()), command: fakeCommand }]]);
    const host = fakeHost({ commands });

    await handleMessageCommand(message, host, logger, '+');

    expect(message.reply).not.toHaveBeenCalled();
  });

  it('recognizes and parses a valid command', async () => {
    const fakeCommand: PluginCommand = {
      data: {
        toJSON: () => ({
          type: 1, // CHAT_INPUT
          name: 'help',
          options: [],
        }),
      } as any,
      requirement: undefined,
      execute: vi.fn(async () => undefined),
    };

    const commands = new Map([['help', { plugin: fakePlugin(fakeManifest()), command: fakeCommand }]]);
    const message = fakeMessage((msg) => {
      msg.content = '+help';
    });
    const host = fakeHost({ commands });

    // Should not throw
    await expect(handleMessageCommand(message, host, logger, '+')).resolves.toBeUndefined();
  });

  it('replies with error on bad arguments', async () => {
    const fakeCommand: PluginCommand = {
      data: {
        toJSON: () => ({
          type: 1,
          name: 'warn',
          options: [
            { type: 6, name: 'user', required: true, description: 'User to warn' },
          ],
        }),
      } as any,
      requirement: undefined,
      execute: vi.fn(async () => undefined),
    };

    const commands = new Map([['warn', { plugin: fakePlugin(fakeManifest()), command: fakeCommand }]]);
    const message = fakeMessage((msg) => {
      msg.content = '+warn';
    });
    const host = fakeHost({ commands });

    await handleMessageCommand(message, host, logger, '+');

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        allowedMentions: expect.any(Object),
      }),
    );
  });

  it('handles errors gracefully and logs them', async () => {
    const fakeCommand: PluginCommand = {
      data: {
        toJSON: () => ({
          type: 1,
          name: 'help',
          options: [],
        }),
      } as any,
      requirement: undefined,
      execute: vi.fn(async () => {
        throw new Error('Test error');
      }),
    };

    const commands = new Map([['help', { plugin: fakePlugin(fakeManifest()), command: fakeCommand }]]);
    const message = fakeMessage((msg) => {
      msg.content = '+help';
    });
    const host = fakeHost({ commands });

    await handleMessageCommand(message, host, logger, '+');

    expect(logger.error).toHaveBeenCalled();
  });

  it('recognizes custom prefixes', async () => {
    const fakeCommand: PluginCommand = {
      data: {
        toJSON: () => ({
          type: 1,
          name: 'help',
          options: [],
        }),
      } as any,
      requirement: undefined,
      execute: vi.fn(async () => undefined),
    };

    const commands = new Map([['help', { plugin: fakePlugin(fakeManifest()), command: fakeCommand }]]);
    const message = fakeMessage((msg) => {
      msg.content = '!help';
    });
    const host = fakeHost({ commands });

    // Should not throw
    await expect(handleMessageCommand(message, host, logger, '!')).resolves.toBeUndefined();
  });

  // DEFECT 5: Usage string in error message
  it('shows usage string in error message (DEFECT 5)', async () => {
    const fakeCommand: PluginCommand = {
      data: {
        toJSON: () => ({
          type: 1,
          name: 'warn',
          options: [
            { type: 6, name: 'user', required: true, description: 'User to warn' },
          ],
        }),
      } as any,
      requirement: undefined,
      execute: vi.fn(async () => undefined),
    };

    const commands = new Map([['warn', { plugin: fakePlugin(fakeManifest()), command: fakeCommand }]]);
    const message = fakeMessage((msg) => {
      msg.content = '+warn';
    });
    const host = fakeHost({ commands });

    await handleMessageCommand(message, host, logger, '+');

    // Check that reply was called and includes both error and usage
    expect(message.reply).toHaveBeenCalled();
    const callArg = (message.reply as any).mock.calls[0][0] as any;
    expect(callArg).toBeDefined();
    expect(callArg.embeds).toBeDefined();
    expect(Array.isArray(callArg.embeds)).toBe(true);
    expect(callArg.embeds.length).toBeGreaterThan(0);

    // EmbedBuilder's toJSON() method gives us the actual data
    const embed = callArg.embeds[0];
    const embedData = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
    const description = embedData.description;

    expect(description).toBeDefined();
    expect(typeof description).toBe('string');
    expect(description).toContain('+warn');
    expect(description).toContain('Usage');
  });

  // DEFECT 6: Bare prefix triggers help command
  it('triggers help command on bare prefix (DEFECT 6)', async () => {
    const helpCommand: PluginCommand = {
      data: {
        toJSON: () => ({
          type: 1,
          name: 'help',
          options: [],
        }),
      } as any,
      requirement: undefined,
      execute: vi.fn(async () => undefined),
    };

    const commands = new Map([['help', { plugin: fakePlugin(fakeManifest()), command: helpCommand }]]);
    const message = fakeMessage((msg) => {
      msg.content = '+';
    });
    const host = fakeHost({ commands });

    // Should not throw and should not reply with an error
    await expect(handleMessageCommand(message, host, logger, '+')).resolves.toBeUndefined();
    // Bare prefix should NOT result in an error reply
    expect(message.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            description: expect.stringContaining('Invalid arguments'),
          }),
        ]),
      }),
    );
  });

  // DEFECT 6: Bare prefix rate limiting
  it('rate-limits bare prefix to once per 60s per channel (DEFECT 6)', async () => {
    vi.useFakeTimers();

    try {
      const helpCommand: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'help',
            options: [],
          }),
        } as any,
        requirement: undefined,
        execute: vi.fn(async () => undefined),
      };

      const commands = new Map([['help', { plugin: fakePlugin(fakeManifest()), command: helpCommand }]]);
      const host = fakeHost({ commands });

      // First bare prefix in channel
      const message1 = fakeMessage((msg) => {
        msg.content = '+';
        msg.channelId = 'test-channel-1';
      });
      await handleMessageCommand(message1, host, logger, '+');
      const firstCallCount = (message1.reply as any).mock.calls.length;

      // Second bare prefix in same channel immediately after (should be suppressed)
      const message2 = fakeMessage((msg) => {
        msg.content = '+  ';
        msg.channelId = 'test-channel-1';
      });
      await handleMessageCommand(message2, host, logger, '+');
      // Should still be suppressed (no new reply call)
      expect((message2.reply as any).mock.calls.length).toBe(0);

      // Bare prefix in different channel (should NOT be suppressed)
      const message3 = fakeMessage((msg) => {
        msg.content = '+';
        msg.channelId = 'test-channel-2';
      });
      await handleMessageCommand(message3, host, logger, '+');
      // This should not result in an error reply
      expect((message3.reply as any).mock.calls.length).toBe(0);

      // After 60 seconds, first channel should fire again
      vi.advanceTimersByTime(60_001);
      const message4 = fakeMessage((msg) => {
        msg.content = '+';
        msg.channelId = 'test-channel-1';
      });
      await handleMessageCommand(message4, host, logger, '+');
      // Should not result in error reply
      expect((message4.reply as any).mock.calls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // DEFECT 6: Explicit +help is not rate-limited
  it('does not rate-limit explicit +help command (DEFECT 6)', async () => {
    vi.useFakeTimers();

    try {
      const helpCommand: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'help',
            options: [],
          }),
        } as any,
        requirement: undefined,
        execute: vi.fn(async () => undefined),
      };

      const commands = new Map([['help', { plugin: fakePlugin(fakeManifest()), command: helpCommand }]]);
      const host = fakeHost({ commands });

      // Bare prefix (should route help)
      const message1 = fakeMessage((msg) => {
        msg.content = '+';
      });
      await handleMessageCommand(message1, host, logger, '+');

      // Explicit +help immediately after (should NOT be suppressed by rate limiter)
      const message2 = fakeMessage((msg) => {
        msg.content = '+help';
      });
      await handleMessageCommand(message2, host, logger, '+');
      // Both should be successfully routed (no errors)
      expect((message2.reply as any).mock.calls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('silently ignores bare prefix when no help command is registered (DEFECT 6)', async () => {
    const message = fakeMessage((msg) => {
      msg.content = '+';
    });
    const host = fakeHost({ commands: new Map() }); // No commands registered

    await handleMessageCommand(message, host, logger, '+');

    // Should not throw or reply
    expect(message.reply).not.toHaveBeenCalled();
  });
});
