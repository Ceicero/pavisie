import { describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';

describe('Bug fixes 2026-09-08', () => {
  describe('BUG 4: Mistyped single subcommand', () => {
    it('rejects mistyped subcommand for single-subcommand command', async () => {
      // When a command has exactly one subcommand, typing a different word should error,
      // not leak into option values
      const { resolvePrefixOptions } = await import('../prefix/options');

      const message = {
        guild: { members: { cache: new Map() } },
        attachments: new Map(),
      } as never;

      const result = await resolvePrefixOptions(
        {
          options: [
            {
              type: 1, // Subcommand
              name: 'view',
              description: 'View something',
              options: [
                {
                  type: 3,
                  name: 'target',
                  required: false,
                },
              ],
            },
          ],
        },
        ['bogus'], // User typed 'bogus' instead of 'view'
        message,
        'mycommand',
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('bogus');
        expect(result.usage).toContain('view');
      }
    });

    it('auto-selects single subcommand when no token provided', async () => {
      // When a command has exactly one subcommand and the user provides no token,
      // it should auto-select and run fine
      const { resolvePrefixOptions } = await import('../prefix/options');

      const message = {
        guild: { members: { cache: new Map() } },
        attachments: new Map(),
      } as never;

      const result = await resolvePrefixOptions(
        {
          options: [
            {
              type: 1, // Subcommand
              name: 'view',
              description: 'View something',
              options: [
                {
                  type: 3,
                  name: 'target',
                  required: false,
                },
              ],
            },
          ],
        },
        [], // No tokens
        message,
        'mycommand',
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.subcommand).toBe('view');
      }
    });

    it('auto-selects single subcommand when token matches', async () => {
      // When the first token matches the single subcommand name, it should be auto-selected
      const { resolvePrefixOptions } = await import('../prefix/options');

      const message = {
        guild: { members: { cache: new Map() } },
        attachments: new Map(),
      } as never;

      const result = await resolvePrefixOptions(
        {
          options: [
            {
              type: 1, // Subcommand
              name: 'view',
              description: 'View something',
              options: [
                {
                  type: 3,
                  name: 'target',
                  required: false,
                },
              ],
            },
          ],
        },
        ['view'], // User typed the correct subcommand name
        message,
        'mycommand',
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.subcommand).toBe('view');
      }
    });
  });

  describe('BUG 5: Deferred reply guard (low priority)', () => {
    it('throws when replying after deferring', async () => {
      // When a command defers and then tries to reply, it should throw
      // (not send two separate messages)
      const { createMessageCommandInteraction } = await import('../prefix/message-command-interaction');

      const user = {
        id: 'user-123',
        username: 'testuser',
        bot: false,
      };

      const member = {
        id: 'user-123',
        user,
        roles: { cache: new Map() },
        permissions: { bitfield: 0n },
        displayName: 'TestUser',
      };

      const channel = {
        id: 'channel-123',
        name: 'test-channel',
        type: 0,
        guild: { id: 'guild-123' },
        sendTyping: vi.fn(async () => undefined),
      };

      const guild = {
        id: 'guild-123',
        preferredLocale: 'en-US',
        ownerId: 'owner-123',
        members: { cache: new Map([[user.id, member]]), me: member },
        channels: { cache: new Map([[channel.id, channel]]) },
        roles: { cache: new Map() },
      };

      const message = {
        id: 'msg-123',
        content: '+test',
        author: user,
        member: member as any,
        guild: guild as any,
        guildId: guild.id,
        channel: channel as any,
        channelId: channel.id,
        client: { user: { id: 'bot-id', username: 'testbot' } },
        attachments: new Map() as any,
        createdTimestamp: Date.now(),
        createdAt: new Date(),
        webhookId: null,
        system: false,
        inGuild: () => true,
        reply: vi.fn(async () => ({})),
      } as unknown as Message<true>;

      const fakeInteraction = createMessageCommandInteraction({
        message,
        commandName: 'test',
        resolved: { subcommand: null, subcommandGroup: null, values: new Map() },
      });

      // Defer first
      await fakeInteraction.deferReply();

      // Now try to reply (should throw)
      await expect(fakeInteraction.reply({ content: 'test' })).rejects.toThrow(
        /already been sent/,
      );
    });
  });
});
