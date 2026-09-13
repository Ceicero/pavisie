import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild, Role } from 'discord.js';
import { deriveSetupState, describeRoleHierarchyWarnings, describeIntentWarnings, formatMemoryMb, formatUptime } from '../format';
import type { PluginManifest } from '../../sdk';
import type { PluginId } from '@pavisie/types';

const base = {
  setupCompletedAt: null as string | null,
  modRoleIds: [] as string[],
  adminRoleIds: [] as string[],
  modLogChannelId: null as string | null,
};

describe('deriveSetupState', () => {
  it('reports "wizard" whenever setupCompletedAt is set, regardless of the rest', () => {
    expect(deriveSetupState({ ...base, setupCompletedAt: '2026-08-01T00:00:00.000Z' })).toEqual({
      kind: 'wizard',
      completedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('reports "configured" when staff roles + a mod-log channel exist without the wizard ever running', () => {
    expect(deriveSetupState({ ...base, modRoleIds: ['1'], modLogChannelId: '9' })).toEqual({
      kind: 'configured',
    });
  });

  it('does NOT count admin roles alone as staff — must agree with the API overview, which only checks modRoleIds', () => {
    expect(deriveSetupState({ ...base, adminRoleIds: ['2'], modLogChannelId: '9' })).toEqual({
      kind: 'incomplete',
      missing: ['modRoles'],
    });
  });

  it('reports "incomplete" with modLogChannel missing when roles exist but no channel', () => {
    expect(deriveSetupState({ ...base, modRoleIds: ['1'] })).toEqual({
      kind: 'incomplete',
      missing: ['modLogChannel'],
    });
  });

  it('reports "incomplete" with modRoles missing when a channel exists but no staff roles', () => {
    expect(deriveSetupState({ ...base, modLogChannelId: '9' })).toEqual({
      kind: 'incomplete',
      missing: ['modRoles'],
    });
  });

  it('lists both when a fresh guild has nothing configured', () => {
    expect(deriveSetupState(base)).toEqual({ kind: 'incomplete', missing: ['modRoles', 'modLogChannel'] });
  });
});

describe('describeRoleHierarchyWarnings', () => {
  let mockGuild: Guild;
  let mockBotMember: any;
  let mockRoles: Record<string, any>;

  beforeEach(() => {
    // Setup mock roles with positions
    mockRoles = {
      'role-above': { id: 'role-above', position: 10 },
      'role-equal': { id: 'role-equal', position: 5 },
      'role-below': { id: 'role-below', position: 2 },
    };

    // Setup mock bot member with highest role at position 5
    mockBotMember = {
      roles: {
        highest: { position: 5 },
      },
    };

    // Setup mock guild
    mockGuild = {
      members: {
        me: mockBotMember,
      },
      roles: {
        cache: {
          get: (roleId: string) => mockRoles[roleId] || null,
        },
      },
    } as unknown as Guild;
  });

  it('returns empty array when all staff roles are below the bot', () => {
    const warnings = describeRoleHierarchyWarnings(mockGuild, ['role-below'], (key) => `[${key}]`);
    expect(warnings).toEqual([]);
  });

  it('returns warning when a staff role is equal to the bot (at same position)', () => {
    const warnings = describeRoleHierarchyWarnings(mockGuild, ['role-equal'], (key, vars) => `${key}:${vars?.roleId}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('role-equal');
  });

  it('returns warning when a staff role is above the bot', () => {
    const warnings = describeRoleHierarchyWarnings(mockGuild, ['role-above'], (key, vars) => `${key}:${vars?.roleId}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('role-above');
  });

  it('returns warnings for multiple roles that outrank the bot', () => {
    const warnings = describeRoleHierarchyWarnings(
      mockGuild,
      ['role-above', 'role-equal', 'role-below'],
      (key, vars) => `${key}:${vars?.roleId}`,
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes('role-above'))).toBe(true);
    expect(warnings.some((w) => w.includes('role-equal'))).toBe(true);
  });

  it('returns empty array when bot member is missing', () => {
    const guildNoBotMember = {
      members: { me: null },
      roles: { cache: { get: () => mockRoles['role-above'] } },
    } as unknown as Guild;
    const warnings = describeRoleHierarchyWarnings(guildNoBotMember, ['role-above'], () => 'warning');
    expect(warnings).toEqual([]);
  });

  it('ignores roles that do not exist in the guild', () => {
    const warnings = describeRoleHierarchyWarnings(mockGuild, ['role-above', 'non-existent-role'], (key, vars) =>
      `${key}:${vars?.roleId}`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('role-above');
  });

  it('returns empty array for empty staff role list', () => {
    const warnings = describeRoleHierarchyWarnings(mockGuild, [], () => 'warning');
    expect(warnings).toEqual([]);
  });
});

describe('describeIntentWarnings', () => {
  let mockManifests: PluginManifest[];

  function createMockManifest(
    id: PluginId,
    name: string,
    privilegedIntents: string[] = [],
    alwaysEnabled = false,
  ): PluginManifest {
    return {
      id,
      name,
      description: `Test plugin: ${name}`,
      category: 'utility',
      version: '1.0.0',
      defaultEnabled: true,
      alwaysEnabled,
      permissions: [],
      intents: [],
      privilegedIntents: privilegedIntents as any,
      requiredEnv: [],
      configSchema: vi.fn() as any,
      defaultConfig: {},
    };
  }

  beforeEach(() => {
    // Use real plugin IDs for testing
    mockManifests = [
      createMockManifest('admin', 'Plugin A', ['MessageContent']),
      createMockManifest('moderation', 'Plugin B', ['GuildMembers']),
      createMockManifest('automod', 'Plugin C', ['GuildPresences'], true),
      createMockManifest('enforcer', 'Plugin D', []),
    ];
  });

  it('returns empty array when all required intents are enabled', () => {
    const warnings = describeIntentWarnings(
      mockManifests,
      ['admin', 'moderation', 'automod'],
      {
        messageContent: true,
        guildMembers: true,
        guildPresences: true,
      },
      (key) => `[${key}]`,
    );
    expect(warnings).toEqual([]);
  });

  it('returns warning when an enabled plugin needs a disabled intent', () => {
    const warnings = describeIntentWarnings(
      mockManifests,
      ['admin'],
      {
        messageContent: false,
        guildMembers: true,
        guildPresences: true,
      },
      (key, vars) => `${vars?.plugin}:${vars?.intent}`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Plugin A');
    expect(warnings[0]).toContain('MessageContent');
  });

  it('does not warn about disabled plugins', () => {
    // Only pass non-always-enabled plugins for this test
    const disabledPlugins = mockManifests.filter((m) => !m.alwaysEnabled);
    const warnings = describeIntentWarnings(
      disabledPlugins,
      [], // No plugins enabled
      {
        messageContent: false,
        guildMembers: false,
        guildPresences: false,
      },
      (key, vars) => `${vars?.plugin}:${vars?.intent}`,
    );
    expect(warnings).toEqual([]);
  });

  it('warns about always-enabled plugins even if not in enabledPluginIds', () => {
    const warnings = describeIntentWarnings(
      mockManifests,
      ['admin'], // automod is always enabled but not in the list
      {
        messageContent: true,
        guildMembers: true,
        guildPresences: false,
      },
      (key, vars) => `${vars?.plugin}:${vars?.intent}`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Plugin C');
    expect(warnings[0]).toContain('GuildPresences');
  });

  it('ignores plugins with no privileged intents', () => {
    // Only pass plugins with no intents for this test
    const noIntentPlugins = [mockManifests[3]]; // enforcer has no intents
    const warnings = describeIntentWarnings(
      noIntentPlugins,
      ['enforcer'],
      {
        messageContent: false,
        guildMembers: false,
        guildPresences: false,
      },
      (key, vars) => `${vars?.plugin}:${vars?.intent}`,
    );
    expect(warnings).toEqual([]);
  });

  it('returns multiple warnings for a single plugin with multiple missing intents', () => {
    const multiIntentPlugin = createMockManifest(
      'logging' as PluginId,
      'Multi Intent Plugin',
      ['MessageContent', 'GuildMembers', 'GuildPresences'],
    );
    const warnings = describeIntentWarnings(
      [multiIntentPlugin],
      ['logging'],
      {
        messageContent: false,
        guildMembers: false,
        guildPresences: true,
      },
      (key, vars) => `${vars?.plugin}:${vars?.intent}`,
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes('MessageContent'))).toBe(true);
    expect(warnings.some((w) => w.includes('GuildMembers'))).toBe(true);
  });
});

describe('formatting helpers', () => {
  it('formatMemoryMb renders one decimal MB', () => {
    expect(formatMemoryMb(42.3 * 1024 * 1024)).toBe('42.3 MB');
  });

  it('formatUptime picks the two most significant units', () => {
    expect(formatUptime(3 * 86400 + 4 * 3600)).toBe('3d 4h');
    expect(formatUptime(65)).toBe('1m 5s');
    expect(formatUptime(9)).toBe('9s');
  });
});
