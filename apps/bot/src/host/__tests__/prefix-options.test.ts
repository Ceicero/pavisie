import { describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';
import { resolvePrefixOptions } from '../prefix/options';

// Mock helper to create a fake message with guild/members/channels/roles/attachments
function fakeCachedMessage(overrides: Partial<Message<true>> = {}): Message<true> {
  const userId = '123456789';
  const channelId = 'channel-456';
  const roleId = '987654321';

  const user = {
    id: userId,
    username: 'testuser',
    bot: false,
  };

  const member = {
    id: userId,
    user,
    roles: {
      cache: new Map([[roleId, { id: roleId, name: 'TestRole' }]]),
    },
    permissions: { bitfield: 0n },
    displayName: 'TestUser',
    permissionsIn: vi.fn(() => ({
      has: () => true,
    })),
  };

  const channel = {
    id: channelId,
    name: 'test-channel',
    type: 0,
    guild: { id: 'guild-123' },
  };

  const guild = {
    id: 'guild-123',
    preferredLocale: 'en-US',
    ownerId: 'owner-123',
    members: {
      cache: new Map([[userId, member]]),
      me: member,
    },
    channels: {
      cache: new Map([[channelId, channel]]),
    },
    roles: {
      cache: new Map([
        [roleId, { id: roleId, name: 'TestRole' }],
        ['111111111', { id: '111111111', name: 'Moderator' }],
      ]),
    },
  };

  const attachment = {
    id: 'attach-001',
    name: 'test.txt',
    url: 'https://example.com/test.txt',
  };

  return {
    id: 'msg-123',
    content: '+test',
    author: user,
    member: member as any,
    guild: guild as any,
    guildId: guild.id,
    channel: channel as any,
    channelId,
    attachments: new Map([['attach-001', attachment]]) as any,
    createdTimestamp: Date.now(),
    createdAt: new Date(),
    inGuild: () => true,
    ...overrides,
  } as unknown as Message<true>;
}

describe('resolvePrefixOptions', () => {
  it('resolves a command with no options', async () => {
    const result = await resolvePrefixOptions({ options: [] }, [], fakeCachedMessage());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.values.size).toBe(0);
    }
  });

  it('resolves positional string arguments', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 3, name: 'text', required: true, description: '' },
        ],
      },
      ['hello world'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.values.get('text')).toBe('hello world');
    }
  });

  it('resolves named arguments (key:value)', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 3, name: 'reason', required: true, description: '' },
          { type: 3, name: 'evidence', required: false, description: '' },
        ],
      },
      ['reason:spam', 'evidence:https://example.com'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.values.get('reason')).toBe('spam');
      expect(result.resolved.values.get('evidence')).toBe('https://example.com');
    }
  });

  it('greedy last string option consumes remaining positional args', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 3, name: 'user', required: true, description: '' },
          { type: 3, name: 'reason', required: false, description: '' },
        ],
      },
      ['@user', 'spamming', 'the', 'server'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.values.get('user')).toBe('@user');
      expect(result.resolved.values.get('reason')).toBe('spamming the server');
    }
  });

  it('returns error when required option is missing', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 3, name: 'user', required: true, description: '' },
        ],
      },
      [],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('required');
      expect(result.usage).toContain('user');
    }
  });

  it('resolves integer options with min/max validation', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 4, name: 'days', required: false, min_value: 1, max_value: 28, description: '' },
        ],
      },
      ['days:7'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.values.get('days')).toBe(7);
    }
  });

  it('rejects integer outside min/max range', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 4, name: 'days', required: true, min_value: 1, max_value: 28, description: '' },
        ],
      },
      ['days:40'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('at most');
    }
  });

  it('resolves boolean options with various formats', async () => {
    const tests = [
      { tokens: ['yes'], expected: true },
      { tokens: ['no'], expected: false },
      { tokens: ['true'], expected: true },
      { tokens: ['false'], expected: false },
      { tokens: ['on'], expected: true },
      { tokens: ['off'], expected: false },
      { tokens: ['1'], expected: true },
      { tokens: ['0'], expected: false },
    ];

    for (const test of tests) {
      const result = await resolvePrefixOptions(
        {
          options: [
            { type: 5, name: 'flag', required: true, description: '' },
          ],
        },
        test.tokens,
        fakeCachedMessage(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.values.get('flag')).toBe(test.expected);
      }
    }
  });

  it('rejects invalid boolean values', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 5, name: 'flag', required: true, description: '' },
        ],
      },
      ['maybe'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('true/false');
    }
  });

  it('resolves user option from mention', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 6, name: 'user', required: true, description: '' },
        ],
      },
      ['<@123456789>'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const user = result.resolved.values.get('user');
      expect(user).toBeDefined();
      expect(typeof user === 'object' && 'id' in user).toBe(true);
    }
  });

  it('resolves role option from mention', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 8, name: 'role', required: true, description: '' },
        ],
      },
      ['<@&987654321>'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const role = result.resolved.values.get('role');
      expect(role).toBeDefined();
      expect(typeof role === 'object' && 'name' in role && 'id' in role).toBe(true);
      if (typeof role === 'object' && 'id' in role) {
        expect(role.id).toBe('987654321');
      }
    }
  });

  it('validates string choices case-insensitively', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          {
            type: 3,
            name: 'severity',
            required: true,
            description: '',
            choices: [
              { name: 'Low', value: 'low' },
              { name: 'High', value: 'high' },
            ],
          },
        ],
      },
      ['HIGH'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.values.get('severity')).toBe('high');
    }
  });

  it('rejects invalid choice', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          {
            type: 3,
            name: 'severity',
            required: true,
            description: '',
            choices: [
              { name: 'Low', value: 'low' },
              { name: 'High', value: 'high' },
            ],
          },
        ],
      },
      ['medium'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('one of');
    }
  });

  it('resolves subcommand', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          {
            type: 1,
            name: 'warn',
            description: '',
            options: [
              { type: 6, name: 'user', required: true, description: '' },
            ],
          },
          {
            type: 1,
            name: 'kick',
            description: '',
            options: [
              { type: 6, name: 'user', required: true, description: '' },
            ],
          },
        ],
      },
      ['warn', '<@123456789>'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.subcommand).toBe('warn');
      expect(result.resolved.values.get('user')).toBeDefined();
    }
  });

  it('resolves subcommand group and subcommand', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          {
            type: 2,
            name: 'moderation',
            description: '',
            options: [
              {
                type: 1,
                name: 'ban',
                description: '',
                options: [
                  { type: 6, name: 'user', required: true, description: '' },
                ],
              },
            ],
          },
        ],
      },
      ['moderation', 'ban', '<@123456789>'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.subcommandGroup).toBe('moderation');
      expect(result.resolved.subcommand).toBe('ban');
      expect(result.resolved.values.get('user')).toBeDefined();
    }
  });

  it('builds usage string with required/optional brackets', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 6, name: 'user', required: true, description: '' },
          { type: 3, name: 'reason', required: false, description: '' },
        ],
      },
      [],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.usage).toMatch(/<user>/);
      expect(result.usage).toMatch(/\[reason\]/);
    }
  });

  // DEFECT 1: Real object resolution
  it('resolves users to real GuildMember objects (DEFECT 1)', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 6, name: 'user', required: true, description: '' },
        ],
      },
      ['<@123456789>'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const user = result.resolved.values.get('user');
      expect(user).toBeDefined();
      // Should be a GuildMember with user property
      expect(typeof user === 'object' && 'user' in user).toBe(true);
    }
  });

  // DEFECT 3: URL positional argument should not be misparsed
  it('keeps URL as positional argument, not named argument (DEFECT 3)', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 3, name: 'url', required: true, description: '' },
        ],
      },
      ['https://example.com/hook'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The URL should be resolved as-is, not split on the colon
      expect(result.resolved.values.get('url')).toBe('https://example.com/hook');
    }
  });

  // DEFECT 4: Choices should match by name OR value
  it('matches choices by display name (DEFECT 4)', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          {
            type: 3,
            name: 'level',
            required: true,
            description: '',
            choices: [
              { name: 'Low', value: 'low' },
              { name: 'High', value: 'high' },
            ],
          },
        ],
      },
      ['Low'],
      fakeCachedMessage(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should resolve to the internal value, not the display name
      expect(result.resolved.values.get('level')).toBe('low');
    }
  });

  // DEFECT 2: Attachment auto-binding
  it('auto-binds attachments in order (DEFECT 2)', async () => {
    const attachment1 = {
      id: 'attach-001',
      name: 'test.txt',
      url: 'https://example.com/test.txt',
    };
    const attachment2 = {
      id: 'attach-002',
      name: 'test2.txt',
      url: 'https://example.com/test2.txt',
    };
    const msg = fakeCachedMessage();
    (msg as any).attachments = new Map([
      ['attach-001', attachment1],
      ['attach-002', attachment2],
    ]);

    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 11, name: 'file1', required: true, description: '' },
          { type: 11, name: 'file2', required: true, description: '' },
        ],
      },
      [],
      msg,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const file1 = result.resolved.values.get('file1');
      const file2 = result.resolved.values.get('file2');
      expect(file1).toBeDefined();
      expect(file2).toBeDefined();
      // Should be the real attachment objects
      expect(typeof file1 === 'object' && 'id' in file1).toBe(true);
      expect(typeof file2 === 'object' && 'id' in file2).toBe(true);
    }
  });

  // DEFECT 2: Required attachment with no corresponding attachment
  it('fails with clear error when required attachment is missing (DEFECT 2)', async () => {
    const msg = fakeCachedMessage();
    (msg as any).attachments = new Map();

    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 11, name: 'file', required: true, description: '' },
        ],
      },
      [],
      msg,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('required');
      expect(result.error).toContain('attach');
    }
  });

  // DEFECT 5: Command name in usage string
  it('includes command name in usage string (DEFECT 5)', async () => {
    const result = await resolvePrefixOptions(
      {
        options: [
          { type: 6, name: 'user', required: true, description: '' },
        ],
      },
      [],
      fakeCachedMessage(),
      'warn',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.usage).toContain('warn');
      expect(result.usage).toMatch(/<user>/);
    }
  });
});
