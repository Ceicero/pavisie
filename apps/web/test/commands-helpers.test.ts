/**
 * Coverage for the pure command-reference helpers in `apps/web/src/lib/commands.ts`.
 *
 * Fixtures are made-up `ExportedPlugin` / `ExportedCommand` objects only. Nothing
 * here depends on the contents of `apps/web/src/data/commands.json`.
 */
import { describe, expect, it } from 'vitest';
import type { PluginId, StaffLevel } from '@pavisie/types';
import {
  countLeafCommands,
  exampleUsage,
  formatPermission,
  staffLabel,
  whoCanUse,
  type CommandOption,
  type CommandSubcommand,
  type ExportedCommand,
  type ExportedPlugin,
} from '../src/lib/commands';

function makePlugin(overrides: Partial<ExportedPlugin> = {}): ExportedPlugin {
  return {
    id: 'test-plugin' as PluginId,
    name: 'Test Plugin',
    description: '',
    category: 'moderation',
    defaultEnabled: true,
    privilegedIntents: [],
    commands: [],
    ...overrides,
  };
}

function makeCommand(overrides: Partial<ExportedCommand> = {}): ExportedCommand {
  return {
    name: 'ping',
    fullName: '/ping',
    type: 'slash',
    description: 'Ping',
    options: [],
    subcommands: [],
    ...overrides,
  };
}

function makeOption(overrides: Partial<CommandOption> & Pick<CommandOption, 'name'>): CommandOption {
  return {
    description: '',
    required: true,
    type: 'String',
    ...overrides,
  };
}

function makeSubcommand(overrides: Partial<CommandSubcommand> = {}): CommandSubcommand {
  return {
    name: 'add',
    fullName: '/tag add',
    description: 'Add a tag',
    options: [],
    ...overrides,
  };
}

describe('countLeafCommands', () => {
  it('is 0 when a plugin has no commands', () => {
    expect(countLeafCommands(makePlugin())).toBe(0);
  });

  it('counts a top-level command with no subcommands as one leaf', () => {
    expect(
      countLeafCommands(
        makePlugin({
          commands: [makeCommand(), makeCommand({ name: 'help', fullName: '/help' })],
        }),
      ),
    ).toBe(2);
  });

  it('counts subcommands instead of the parent when a command has any', () => {
    expect(
      countLeafCommands(
        makePlugin({
          commands: [
            makeCommand({
              name: 'tag',
              fullName: '/tag',
              subcommands: [
                makeSubcommand({ name: 'add', fullName: '/tag add' }),
                makeSubcommand({ name: 'remove', fullName: '/tag remove' }),
                makeSubcommand({ name: 'list', fullName: '/tag list' }),
              ],
            }),
          ],
        }),
      ),
    ).toBe(3);
  });

  it('adds leaf commands and subcommand counts together', () => {
    expect(
      countLeafCommands(
        makePlugin({
          commands: [
            makeCommand(),
            makeCommand({
              name: 'tag',
              fullName: '/tag',
              subcommands: [
                makeSubcommand({ name: 'add', fullName: '/tag add' }),
                makeSubcommand({ name: 'remove', fullName: '/tag remove' }),
              ],
            }),
          ],
        }),
      ),
    ).toBe(3);
  });
});

describe('staffLabel', () => {
  it('returns Everyone when the level is missing', () => {
    expect(staffLabel(undefined)).toBe('Everyone');
  });

  it('labels every StaffLevel', () => {
    expect(staffLabel('member')).toBe('Everyone');
    expect(staffLabel('helper')).toBe('Helper+');
    expect(staffLabel('moderator')).toBe('Moderator+');
    expect(staffLabel('admin')).toBe('Admin+');
    expect(staffLabel('owner')).toBe('Server owner');
  });

  it('falls back to the raw level string when it is not a known StaffLevel', () => {
    expect(staffLabel('custom' as StaffLevel)).toBe('custom');
  });
});

describe('formatPermission', () => {
  it('inserts a space before each capital in a camelCase or PascalCase name', () => {
    expect(formatPermission('ManageMessages')).toBe('Manage Messages');
    expect(formatPermission('kickMembers')).toBe('kick Members');
    expect(formatPermission('ModerateMembers')).toBe('Moderate Members');
    expect(formatPermission('ViewAuditLog')).toBe('View Audit Log');
  });

  it('leaves SCREAMING_CASE and a single-word name unchanged', () => {
    expect(formatPermission('MANAGE_MESSAGES')).toBe('MANAGE_MESSAGES');
    expect(formatPermission('KICK_MEMBERS')).toBe('KICK_MEMBERS');
    expect(formatPermission('Administrator')).toBe('Administrator');
  });
});

describe('whoCanUse', () => {
  it('is the staff label when there are no Discord permissions', () => {
    expect(whoCanUse({})).toBe('Everyone');
    expect(whoCanUse({ staffLevel: 'moderator' })).toBe('Moderator+');
    expect(whoCanUse({ staffLevel: 'admin', discordPermissions: [] })).toBe('Admin+');
  });

  it('appends formatted Discord permissions when they are present', () => {
    expect(whoCanUse({ staffLevel: 'moderator', discordPermissions: ['ManageMessages'] })).toBe(
      'Moderator+ with Manage Messages',
    );
    expect(whoCanUse({ discordPermissions: ['KickMembers', 'BanMembers'] })).toBe(
      'Everyone with Kick Members, Ban Members',
    );
    expect(whoCanUse({ staffLevel: 'owner', discordPermissions: ['Administrator'] })).toBe(
      'Server owner with Administrator',
    );
  });
});

describe('exampleUsage', () => {
  it('returns the full name when there are no options', () => {
    expect(exampleUsage({ fullName: '/ping', options: [] })).toBe('/ping');
  });

  it('renders required options bare and optional options in brackets', () => {
    expect(
      exampleUsage({
        fullName: '/warn',
        options: [
          makeOption({ name: 'user', type: 'User', required: true }),
          makeOption({ name: 'reason', type: 'String', required: false }),
        ],
      }),
    ).toBe('/warn user:@user [reason:"spamming links"]');
  });

  it('builds the same kind of example for a subcommand', () => {
    expect(
      exampleUsage({
        fullName: '/tag add',
        options: [
          makeOption({ name: 'name', type: 'String', required: true }),
          makeOption({ name: 'content', type: 'String', required: false }),
        ],
      }),
    ).toBe('/tag add name:"name" [content:"content"]');
  });

  it('picks example values from the option name before the type', () => {
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'user' })] })).toBe('/x user:@user');
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'member' })] })).toBe(
      '/x member:@user',
    );
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'target' })] })).toBe(
      '/x target:@user',
    );
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'channel' })] })).toBe(
      '/x channel:#general',
    );
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'role' })] })).toBe(
      '/x role:@Moderators',
    );
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'reason' })] })).toBe(
      '/x reason:"spamming links"',
    );
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'duration' })] })).toBe(
      '/x duration:1h',
    );
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'key' })] })).toBe(
      '/x key:guild.locale',
    );
  });

  it('falls back to the option type when the name has no hint', () => {
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'who', type: 'User' })] })).toBe(
      '/x who:@user',
    );
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'where', type: 'Channel' })] })).toBe(
      '/x where:#general',
    );
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'which', type: 'Role' })] })).toBe(
      '/x which:@role',
    );
    expect(
      exampleUsage({ fullName: '/x', options: [makeOption({ name: 'enabled', type: 'Boolean' })] }),
    ).toBe('/x enabled:true');
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'count', type: 'Integer' })] })).toBe(
      '/x count:10',
    );
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'amount', type: 'Number' })] })).toBe(
      '/x amount:10',
    );
    expect(exampleUsage({ fullName: '/x', options: [makeOption({ name: 'text', type: 'String' })] })).toBe(
      '/x text:"text"',
    );
  });
});
