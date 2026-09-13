import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Message } from 'discord.js';
import { PermissionFlagsBits, Role } from 'discord.js';
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
  type CommandRequirement,
} from '@pavisie/plugins';
import type { PluginId } from '@pavisie/types';
import { handleMessageCommand } from '../prefix';
import { routeInteraction } from '../router';
import type { LoadedHost } from '../loader';

const GUILD_ID = 'guild-1';
const OWNER_ID = 'owner-user-1';
const MOD_ROLE_ID = 'mod-role-1';
const ADMIN_ROLE_ID = 'admin-role-1';
const HELPER_ROLE_ID = 'helper-role-1';
const BOT_OWNER_ID = 'bot-owner-1';

function fakeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'moderation' as PluginId,
    name: 'Moderation',
    description: 'test plugin',
    category: 'moderation',
    version: '0.1.0',
    defaultEnabled: true,
    alwaysEnabled: false, // Can be disabled per guild
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
    t: (key: string, vars?: Record<string, string | number>) => {
      if (vars?.level) return `missing_staff_level:${vars.level}`;
      if (vars?.permission) return `missing_permission:${vars.permission}`;
      return key;
    },
    getConfig: async () => ({}),
  } as unknown as PluginContext;
}

function fakeGuildConfig(overrides: Partial<GuildConfigData> = {}): GuildConfigData {
  return {
    guildId: GUILD_ID,
    ...DEFAULT_GUILD_CONFIG,
    modRoleIds: [MOD_ROLE_ID],
    adminRoleIds: [ADMIN_ROLE_ID],
    helperRoleIds: [HELPER_ROLE_ID],
    ...overrides,
  };
}

interface FakeHostOverrides {
  commands?: LoadedHost['commands'];
  availability?: LoadedHost['availability'];
  contexts?: LoadedHost['contexts'];
  botOwnerIds?: string[];
  guildConfig?: GuildConfigData;
}

function fakeHost(overrides: FakeHostOverrides = {}): LoadedHost {
  const pluginId: PluginId = 'moderation';
  const contexts = overrides.contexts ?? new Map([[pluginId, fakeContext()]]);
  const availability = overrides.availability ?? new Map([[pluginId, { available: true }]]);
  const guildConfig = overrides.guildConfig ?? fakeGuildConfig();

  return {
    registry: {} as unknown as PluginRegistry,
    configStore: {
      getGuildConfig: async () => guildConfig,
      isEnabled: async () => true,
    } as unknown as LoadedHost['configStore'],
    services: new ServiceRegistry(),
    events: createPlatformEvents(),
    contexts,
    commands: overrides.commands ?? new Map(),
    components: new Map(),
    availability,
    botOwnerIds: overrides.botOwnerIds ?? [],
    cooldowns: new Cooldowns('memory'),
    globalRateLimiter: new MemoryRateLimiter(),
    queueCache: new Map(),
  };
}

interface MockMemberOptions {
  roleIds?: string[];
  permissions?: bigint;
  highestRolePosition?: number;
}

/**
 * Build a mock GuildMember with realistic shape for permissions.ts.
 * toMemberLike() reads:
 *   - member.id
 *   - member.roles.cache.keys() (returns role IDs)
 *   - member.permissions.bitfield
 *   - member.roles.highest.position
 *   - member.user.bot
 */
function makeMember(userId: string, options?: MockMemberOptions): {
  id: string;
  user: { id: string; bot: boolean };
  roles: { cache: Map<string, Role>; highest: { position: number } };
  permissions: { bitfield: bigint };
  displayName: string;
  permissionsIn: ReturnType<typeof vi.fn>;
} {
  const roleIds = options?.roleIds ?? [];
  const permissions = options?.permissions ?? 0n;
  const highestRolePosition = options?.highestRolePosition ?? 0;

  // Build roles.cache: a Map<string, Role> with .keys() returning role IDs
  const rolesCache = new Map<string, Role>();
  for (const roleId of roleIds) {
    rolesCache.set(roleId, { id: roleId } as unknown as Role);
  }

  return {
    id: userId,
    user: { id: userId, bot: false },
    roles: {
      cache: rolesCache,
      highest: { position: highestRolePosition },
    },
    permissions: { bitfield: permissions },
    displayName: `User${userId}`,
    permissionsIn: vi.fn(() => ({
      has: () => true,
    })),
  };
}

interface FakeMessageOverrides {
  content?: string;
  author?: { id: string; username?: string; bot?: boolean };
  member?: ReturnType<typeof makeMember>;
  channelId?: string;
}

/**
 * Build a fake Message<true> from a real Discord.js perspective.
 */
function fakeMessage(overrides?: FakeMessageOverrides): Message<true> {
  const userId = overrides?.author?.id ?? OWNER_ID;
  const member = overrides?.member ?? makeMember(userId);

  const user = overrides?.author ?? {
    id: userId,
    username: 'testuser',
    bot: false,
  };

  const channel = {
    id: overrides?.channelId ?? 'channel-123',
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
      cache: new Map([[userId, member]]),
      me: makeMember('bot-id'), // Bot member with all permissions
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

  return {
    id: 'msg-123',
    content: overrides?.content ?? '+test',
    author: user,
    member: member as unknown,
    guild: guild as unknown,
    guildId: GUILD_ID,
    channel: channel as unknown,
    channelId: channel.id,
    client: client as unknown,
    attachments: new Map() as unknown,
    createdTimestamp: Date.now(),
    createdAt: new Date(),
    webhookId: null,
    system: false,
    inGuild: () => true,
    reply: vi.fn(async () => ({})),
  } as unknown as Message<true>;
}

interface FakeSlashInteractionOverrides {
  commandName?: string;
  member?: ReturnType<typeof makeMember>;
  userId?: string;
  guildOwnerId?: string;
}

/**
 * Build a fake ChatInputCommandInteraction for testing slash commands.
 */
function fakeSlashInteraction(overrides?: FakeSlashInteractionOverrides): {
  isChatInputCommand: () => true;
  isContextMenuCommand: () => false;
  isAutocomplete: () => false;
  isButton: () => false;
  isAnySelectMenu: () => false;
  isModalSubmit: () => false;
  inGuild: () => true;
  inCachedGuild: () => true;
  commandName: string;
  commandId: string;
  commandGuildId: null;
  commandType: 1;
  guild: { id: string; ownerId: string; preferredLocale: string };
  guildId: string;
  channel: { id: string; guild: { id: string } };
  channelId: string;
  user: { id: string };
  member: ReturnType<typeof makeMember>;
  memberPermissions: { bitfield: bigint };
  locale: string;
  guildLocale: string;
  client: { user: { id: string } };
  applicationId: string;
  id: string;
  createdTimestamp: number;
  createdAt: Date;
  replied: boolean;
  deferred: boolean;
  ephemeral: boolean;
  options: unknown;
  reply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  deleteReply: ReturnType<typeof vi.fn>;
  fetchReply: ReturnType<typeof vi.fn>;
} {
  const userId = overrides?.userId ?? OWNER_ID;
  const member = overrides?.member ?? makeMember(userId);

  return {
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    inGuild: () => true,
    inCachedGuild: () => true,
    commandName: overrides?.commandName ?? 'test',
    commandId: 'cmd-123',
    commandGuildId: null,
    commandType: 1 as const,
    guild: {
      id: GUILD_ID,
      ownerId: overrides?.guildOwnerId ?? OWNER_ID,
      preferredLocale: 'en-US',
    },
    guildId: GUILD_ID,
    channel: { id: 'channel-123', guild: { id: GUILD_ID } },
    channelId: 'channel-123',
    user: { id: userId },
    member,
    memberPermissions: member.permissions,
    locale: 'en-US',
    guildLocale: 'en-US',
    client: { user: { id: 'bot-id' } },
    applicationId: 'bot-id',
    id: 'interaction-123',
    createdTimestamp: Date.now(),
    createdAt: new Date(),
    replied: false,
    deferred: false,
    ephemeral: false,
    options: {
      getSubcommand: () => null,
      getSubcommandGroup: () => null,
      getString: () => null,
      getInteger: () => null,
      getNumber: () => null,
      getBoolean: () => null,
      getUser: () => null,
      getMember: () => null,
      getChannel: () => null,
      getRole: () => null,
      getMentionable: () => null,
      getAttachment: () => null,
      get: () => null,
      data: () => ({ options: [] }),
    } as unknown,
    reply: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deleteReply: vi.fn(async () => undefined),
    fetchReply: vi.fn(async () => undefined),
  } as unknown as ReturnType<typeof fakeSlashInteraction>;
}

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as import('pino').Logger;

describe('prefix-permissions — permission enforcement over + prefix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===== Test 1: Staff-gated command refused for plain member over + =====
  describe('Test 1: staff-gated command refused for plain member over +', () => {
    it('rejects a plain member trying to use a moderator-gated command', async () => {
      const executeSpyMod = vi.fn(async () => undefined);
      const cmdMod: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'ban',
            options: [],
          }),
        } as any,
        requirement: { staffLevel: 'moderator' } as CommandRequirement,
        execute: executeSpyMod,
      };

      const commands = new Map([['ban', { plugin: fakePlugin(fakeManifest()), command: cmdMod }]]);
      const plainMember = makeMember('plain-user-1'); // No roles
      const message = fakeMessage({
        content: '+ban',
        member: plainMember,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      // Command should NOT execute
      expect(executeSpyMod).not.toHaveBeenCalled();
      // Should have replied with an error
      expect(message.reply).toHaveBeenCalled();
    });
  });

  // ===== Test 2: Same command succeeds for member with staff role =====
  describe('Test 2: staff-gated command succeeds for member with staff role', () => {
    it('allows a member with the mod role to use a moderator-gated command', async () => {
      const executeSpyMod = vi.fn(async () => undefined);
      const cmdMod: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'ban',
            options: [],
          }),
        } as any,
        requirement: { staffLevel: 'moderator' } as CommandRequirement,
        execute: executeSpyMod,
      };

      const commands = new Map([['ban', { plugin: fakePlugin(fakeManifest()), command: cmdMod }]]);
      const modMember = makeMember('mod-user-1', { roleIds: [MOD_ROLE_ID] });
      const message = fakeMessage({
        content: '+ban',
        member: modMember,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      // Command SHOULD execute
      expect(executeSpyMod).toHaveBeenCalledTimes(1);
    });
  });

  // ===== Test 3: discordPermissions requirements enforced over + =====
  describe('Test 3: discordPermissions requirements enforced over +', () => {
    it('rejects a member without ManageGuild when required', async () => {
      const executeSpyManageGuild = vi.fn(async () => undefined);
      const cmdManageGuild: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'settings',
            options: [],
          }),
        } as any,
        requirement: { discordPermissions: [PermissionFlagsBits.ManageGuild] } as CommandRequirement,
        execute: executeSpyManageGuild,
      };

      const commands = new Map([['settings', { plugin: fakePlugin(fakeManifest()), command: cmdManageGuild }]]);
      const plainMember = makeMember('plain-user-1', { permissions: 0n }); // No permissions
      const message = fakeMessage({
        content: '+settings',
        member: plainMember,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpyManageGuild).not.toHaveBeenCalled();
      expect(message.reply).toHaveBeenCalled();
    });

    it('allows a member with ManageGuild to use the command', async () => {
      const executeSpyManageGuild = vi.fn(async () => undefined);
      const cmdManageGuild: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'settings',
            options: [],
          }),
        } as any,
        requirement: { discordPermissions: [PermissionFlagsBits.ManageGuild] } as CommandRequirement,
        execute: executeSpyManageGuild,
      };

      const commands = new Map([['settings', { plugin: fakePlugin(fakeManifest()), command: cmdManageGuild }]]);
      const memberWithPerm = makeMember('user-with-perm-1', {
        permissions: PermissionFlagsBits.ManageGuild,
      });
      const message = fakeMessage({
        content: '+settings',
        member: memberWithPerm,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpyManageGuild).toHaveBeenCalledTimes(1);
    });
  });

  // ===== Test 4: botOwnerOnly is enforced over + =====
  describe('Test 4: botOwnerOnly enforcement over +', () => {
    it('rejects a non-bot-owner when botOwnerOnly is set', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'admin',
            options: [],
          }),
        } as any,
        requirement: { botOwnerOnly: true } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['admin', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      const nonOwnerMember = makeMember('non-owner-1');
      const message = fakeMessage({
        content: '+admin',
        member: nonOwnerMember,
      });

      const host = fakeHost({ commands, botOwnerIds: [BOT_OWNER_ID] });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).not.toHaveBeenCalled();
      expect(message.reply).toHaveBeenCalled();
    });

    it('allows a bot owner when botOwnerOnly is set', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'admin',
            options: [],
          }),
        } as any,
        requirement: { botOwnerOnly: true } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['admin', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      const ownerMember = makeMember(BOT_OWNER_ID);
      const message = fakeMessage({
        content: '+admin',
        member: ownerMember,
        author: { id: BOT_OWNER_ID },
      });

      const host = fakeHost({ commands, botOwnerIds: [BOT_OWNER_ID] });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ===== Test 5: Parity between + and / entry points =====
  describe('Test 5: parity between + (prefix) and / (slash) entry points', () => {
    it('resolves to same allow/deny outcome for staff-level requirement', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'warn',
            options: [],
          }),
        } as any,
        requirement: { staffLevel: 'moderator' } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['warn', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      const plainMember = makeMember('plain-user-2');

      // Prefix path
      const prefixMessage = fakeMessage({
        content: '+warn',
        member: plainMember,
      });
      const host = fakeHost({ commands });
      await handleMessageCommand(prefixMessage, host, logger, '+');
      const prefixExecuted = executeSpy.mock.calls.length > 0;

      // Reset and test slash path
      vi.clearAllMocks();
      const slashInteraction = fakeSlashInteraction({
        commandName: 'warn',
        member: plainMember,
      });
      slashInteraction.reply = vi.fn(async () => undefined);
      await routeInteraction(slashInteraction as never, host, logger);
      const slashExecuted = executeSpy.mock.calls.length > 0;

      // Both should have the same outcome (both rejected)
      expect(prefixExecuted).toBe(slashExecuted);
      expect(prefixExecuted).toBe(false); // Sanity check: should have been rejected
    });

    it('resolves to same allow/deny outcome for Discord permission requirement', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'config',
            options: [],
          }),
        } as any,
        requirement: { discordPermissions: [PermissionFlagsBits.ManageGuild] } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['config', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);

      // Test with no permission
      const noPerm = makeMember('noperm-user-1', { permissions: 0n });

      // Prefix path
      const prefixMessage = fakeMessage({
        content: '+config',
        member: noPerm,
      });
      const host = fakeHost({ commands });
      await handleMessageCommand(prefixMessage, host, logger, '+');
      const prefixExecuted = executeSpy.mock.calls.length > 0;

      // Reset and test slash path
      vi.clearAllMocks();
      const slashInteraction = fakeSlashInteraction({
        commandName: 'config',
        member: noPerm,
      });
      slashInteraction.reply = vi.fn(async () => undefined);
      await routeInteraction(slashInteraction as never, host, logger);
      const slashExecuted = executeSpy.mock.calls.length > 0;

      // Both should have the same outcome
      expect(prefixExecuted).toBe(slashExecuted);
      expect(prefixExecuted).toBe(false);
    });

    it('allows both paths when requirement is met (staff level)', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'warn',
            options: [],
          }),
        } as any,
        requirement: { staffLevel: 'moderator' } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['warn', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      const modMember = makeMember('mod-user-2', { roleIds: [MOD_ROLE_ID] });

      // Prefix path
      const prefixMessage = fakeMessage({
        content: '+warn',
        member: modMember,
      });
      const host = fakeHost({ commands });
      await handleMessageCommand(prefixMessage, host, logger, '+');
      const prefixExecuted = executeSpy.mock.calls.length > 0;

      // Reset and test slash path
      vi.clearAllMocks();
      const slashInteraction = fakeSlashInteraction({
        commandName: 'warn',
        member: modMember,
      });
      slashInteraction.reply = vi.fn(async () => undefined);
      await routeInteraction(slashInteraction as never, host, logger);
      const slashExecuted = executeSpy.mock.calls.length > 0;

      // Both should allow execution
      expect(prefixExecuted).toBe(true);
      expect(slashExecuted).toBe(true);
    });
  });

  // ===== Test 6: Staff level derived from real member on + path =====
  describe('Test 6: staff level correctly derived from member on + path', () => {
    it('resolves a member with admin role to admin staff level', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'guildconfig',
            options: [],
          }),
        } as any,
        requirement: { staffLevel: 'admin' } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['guildconfig', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      const adminMember = makeMember('admin-user-1', { roleIds: [ADMIN_ROLE_ID] });
      const message = fakeMessage({
        content: '+guildconfig',
        member: adminMember,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it('refuses a member without admin role on admin-gated command', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'guildconfig',
            options: [],
          }),
        } as any,
        requirement: { staffLevel: 'admin' } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['guildconfig', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      const modMember = makeMember('mod-user-3', { roleIds: [MOD_ROLE_ID] }); // Only mod, not admin
      const message = fakeMessage({
        content: '+guildconfig',
        member: modMember,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('allows helper role on helper-gated command via + prefix', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'assist',
            options: [],
          }),
        } as any,
        requirement: { staffLevel: 'helper' } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['assist', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      const helperMember = makeMember('helper-user-1', { roleIds: [HELPER_ROLE_ID] });
      const message = fakeMessage({
        content: '+assist',
        member: helperMember,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ===== Test 7: Plugin-disabled gating applies over + =====
  describe('Test 7: plugin-disabled gating applies over + prefix', () => {
    it('refuses to execute a command from a disabled plugin', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'test',
            options: [],
          }),
        } as any,
        requirement: undefined,
        execute: executeSpy,
      };

      const commands = new Map([['test', { plugin: fakePlugin(fakeManifest({ alwaysEnabled: false })), command: cmd }]]);
      const member = makeMember(OWNER_ID);
      const message = fakeMessage({
        content: '+test',
        member,
      });

      // Plugin is disabled for this guild
      const host = fakeHost({
        commands,
        guildConfig: fakeGuildConfig(),
      });
      // Override configStore to return disabled plugin
      host.configStore.isEnabled = async () => false;

      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).not.toHaveBeenCalled();
      expect(message.reply).toHaveBeenCalled();
    });

    it('allows command from plugin that is alwaysEnabled even when called with +', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'test',
            options: [],
          }),
        } as any,
        requirement: undefined,
        execute: executeSpy,
      };

      // Plugin marked as alwaysEnabled
      const manifest = fakeManifest({ alwaysEnabled: true });
      const commands = new Map([['test', { plugin: fakePlugin(manifest), command: cmd }]]);
      const member = makeMember(OWNER_ID);
      const message = fakeMessage({
        content: '+test',
        member,
      });

      const host = fakeHost({ commands });
      // Even if we try to disable it, alwaysEnabled should bypass
      host.configStore.isEnabled = async () => false;

      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ===== Integration: Complex permission combinations =====
  describe('Integration: complex permission combinations', () => {
    it('allows when both staffLevel and discordPermissions are satisfied', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'complex',
            options: [],
          }),
        } as any,
        requirement: {
          staffLevel: 'moderator',
          discordPermissions: [PermissionFlagsBits.ManageGuild],
        } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['complex', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      // Member is mod AND has ManageGuild
      const member = makeMember('complex-user-1', {
        roleIds: [MOD_ROLE_ID],
        permissions: PermissionFlagsBits.ManageGuild,
      });
      const message = fakeMessage({
        content: '+complex',
        member,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it('allows when staffLevel is satisfied (OR logic) even without the Discord permission', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'complex',
            options: [],
          }),
        } as any,
        requirement: {
          staffLevel: 'moderator',
          discordPermissions: [PermissionFlagsBits.ManageGuild],
        } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['complex', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      // Member is mod but does NOT have ManageGuild (should still pass due to OR logic)
      const member = makeMember('complex-user-2', {
        roleIds: [MOD_ROLE_ID],
        permissions: 0n,
      });
      const message = fakeMessage({
        content: '+complex',
        member,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects when neither staffLevel nor discordPermissions is satisfied', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'complex',
            options: [],
          }),
        } as any,
        requirement: {
          staffLevel: 'moderator',
          discordPermissions: [PermissionFlagsBits.ManageGuild],
        } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['complex', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      // Member has NEITHER mod role NOR ManageGuild permission
      const member = makeMember('complex-user-3', {
        roleIds: [],
        permissions: 0n,
      });
      const message = fakeMessage({
        content: '+complex',
        member,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).not.toHaveBeenCalled();
      expect(message.reply).toHaveBeenCalled();
    });
  });

  // ===== Edge cases and sanity checks =====
  describe('Edge cases: permission inheritance and hierarchy', () => {
    it('admin can use moderator-gated commands (hierarchy)', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'ban',
            options: [],
          }),
        } as any,
        requirement: { staffLevel: 'moderator' } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['ban', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      // Member is admin (higher than mod)
      const adminMember = makeMember('admin-user-2', { roleIds: [ADMIN_ROLE_ID] });
      const message = fakeMessage({
        content: '+ban',
        member: adminMember,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it('moderator cannot use admin-gated commands', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'serverconfig',
            options: [],
          }),
        } as any,
        requirement: { staffLevel: 'admin' } as CommandRequirement,
        execute: executeSpy,
      };

      const commands = new Map([['serverconfig', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      // Member is only mod, not admin
      const modMember = makeMember('mod-user-4', { roleIds: [MOD_ROLE_ID] });
      const message = fakeMessage({
        content: '+serverconfig',
        member: modMember,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('command without requirement is always allowed', async () => {
      const executeSpy = vi.fn(async () => undefined);
      const cmd: PluginCommand = {
        data: {
          toJSON: () => ({
            type: 1,
            name: 'ping',
            options: [],
          }),
        } as any,
        requirement: undefined, // No requirement
        execute: executeSpy,
      };

      const commands = new Map([['ping', { plugin: fakePlugin(fakeManifest()), command: cmd }]]);
      // Even plain member can use unrestricted command
      const plainMember = makeMember('plain-user-3');
      const message = fakeMessage({
        content: '+ping',
        member: plainMember,
      });

      const host = fakeHost({ commands });
      await handleMessageCommand(message, host, logger, '+');

      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
