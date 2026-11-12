import { describe, expect, it, vi } from 'vitest';
import { ChannelType, type ChatInputCommandInteraction, type EmbedBuilder } from 'discord.js';
import { createTestContext } from '../../sdk/testing';
import type { CommandContext } from '../../sdk';
import type { HostService } from '../../sdk/services';
import { executeSetup } from '../commands/setup';
import type { EnforcerConfig } from '../manifest';

const MUTE_DENY = { SendMessages: false, SendMessagesInThreads: false, Speak: false, AddReactions: false };

function defaultConfig(overrides: Partial<EnforcerConfig> = {}): EnforcerConfig {
  return {
    ledgerChannelId: 'ledger-1',
    ledgerVisibility: 'staff',
    flagChannelId: 'flag-1',
    muteRoleId: null,
    captureContext: true,
    contextBefore: 5,
    contextAfter: 3,
    excerptMaxChars: 300,
    autoFlagEnabled: true,
    exemptStaff: true,
    aiAssist: false,
    dmOnAction: true,
    defaultTimeoutMinutes: 60,
    defaultMuteMinutes: null,
    requireReasonOn: ['kick', 'ban'],
    allowedDecisions: ['warn', 'timeout', 'mute', 'kick', 'ban', 'dismiss'],
    banDeleteMessageSeconds: 0,
    ...overrides,
  };
}

/** Minimal `host` service fake — `/enforcer setup` only reads `getGuildConfig` (for the staff role ids). */
function fakeHost(): HostService {
  return {
    getGuildConfig: vi.fn(async () => ({
      guildId: 'g1',
      adminRoleIds: [],
      modRoleIds: [],
      helperRoleIds: [],
    })),
  } as unknown as HostService;
}

interface SetupOpts {
  /** The `mute_role` option, or null to leave it unset. */
  muteRoleOptId?: string | null;
  /** What `guild.roles.fetch` resolves the mute role to (null = "I could not read that role"). */
  roleResolves?: boolean;
  config?: Partial<EnforcerConfig>;
  /** Makes Discord reject the mute-role overwrite on the one manageable channel. */
  muteEditFails?: boolean;
  /** Runs `/enforcer setup repair:true`, with the enforcer service reporting this result. */
  repair?: { muteApplied: number; muteFailed: number };
}

function buildContext(opts: SetupOpts = {}) {
  const generalEdit = vi.fn(async (..._args: unknown[]) => {
    if (opts.muteEditFails) throw new Error('Missing Permissions');
  });
  const unmanageableEdit = vi.fn(async (..._args: unknown[]) => undefined);
  const ledgerSend = vi.fn(async () => undefined);
  const setConfigCalls: Partial<EnforcerConfig>[] = [];
  const editReplies: { embeds?: EmbedBuilder[] }[] = [];
  const createdRoles: unknown[] = [];

  // Two channels in the guild cache: one the bot can manage, one it can't. Only the manageable one can be
  // given the mute deny-overwrite; the other must be reported, not quietly dropped.
  const general = {
    id: 'general',
    type: ChannelType.GuildText,
    isThread: () => false,
    manageable: true,
    isTextBased: () => true,
    isVoiceBased: () => false,
    permissionOverwrites: { edit: generalEdit },
  };
  const unmanageable = {
    id: 'staff-lounge',
    type: ChannelType.GuildText,
    isThread: () => false,
    manageable: false,
    isTextBased: () => true,
    isVoiceBased: () => false,
    permissionOverwrites: { edit: unmanageableEdit },
  };

  const role = { id: opts.muteRoleOptId ?? 'muted-1' };
  const guild = {
    id: 'g1',
    roles: {
      everyone: { id: 'everyone-1' },
      fetch: vi.fn(async () => ((opts.roleResolves ?? true) ? role : null)),
      create: vi.fn(async (payload: unknown) => {
        createdRoles.push(payload);
        return { id: 'created-role' };
      }),
    },
    members: { me: { id: 'bot-1' } },
    channels: {
      cache: new Map<string, unknown>([
        ['general', general],
        ['staff-lounge', unmanageable],
      ]),
      fetch: vi.fn(async (id: string) => channelsById[id] ?? null),
    },
  };

  const ledgerChannel = {
    id: 'ledger-1',
    type: ChannelType.GuildText,
    guild,
    permissionOverwrites: { edit: vi.fn(async () => undefined) },
    send: ledgerSend,
  };
  const flagChannel = {
    id: 'flag-1',
    type: ChannelType.GuildText,
    guild,
    permissionOverwrites: { edit: vi.fn(async () => undefined) },
  };
  const channelsById: Record<string, unknown> = { 'ledger-1': ledgerChannel, 'flag-1': flagChannel };

  const interaction = {
    user: { id: 'admin-1' },
    guild,
    options: {
      getBoolean: (name: string) => (name === 'repair' && opts.repair ? true : null),
      getChannel: () => null,
      getString: () => null,
      getRole: (name: string) =>
        name === 'mute_role' && opts.muteRoleOptId !== null ? { id: opts.muteRoleOptId ?? 'muted-1' } : null,
    },
    reply: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async (payload: { embeds?: EmbedBuilder[] }) => {
      editReplies.push(payload);
    }),
  };

  const cfg = defaultConfig(opts.config);
  const { ctx } = createTestContext({
    config: cfg,
    overrides: {
      setConfig: async <T>(_guildId: string, patch: Partial<T>) => {
        setConfigCalls.push(patch as Partial<EnforcerConfig>);
        return { ...cfg, ...patch } as T;
      },
    },
  });
  ctx.services.register('host', fakeHost());
  if (opts.repair) {
    const result = opts.repair;
    ctx.services.register('enforcer', { repairChannels: async () => result } as never);
  }

  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: 'g1',
    staffLevel: 'admin',
    locale: 'en-US' as never,
    t: (key: string) => key,
    config: async <T>() => cfg as T,
  };

  return { c, generalEdit, unmanageableEdit, setConfigCalls, editReplies, createdRoles, role };
}

function replyText(replies: { embeds?: EmbedBuilder[] }[]): string {
  return replies[0]?.embeds?.[0]?.data.description ?? '';
}

describe('/enforcer setup — mute_role with an existing role', () => {
  it('applies the mute deny-overwrites to the channels, instead of saving the role and reporting a success the mute cannot deliver', async () => {
    const { c, generalEdit, role } = buildContext({ muteRoleOptId: 'muted-1' });

    await executeSetup(c);

    expect(generalEdit).toHaveBeenCalledWith(role, MUTE_DENY, {
      reason: 'Enforcer: apply mute role overwrite',
    });
  });

  it('saves the supplied role id in the plugin config', async () => {
    const { c, setConfigCalls } = buildContext({ muteRoleOptId: 'muted-1' });

    await executeSetup(c);

    expect(setConfigCalls[0]?.muteRoleId).toBe('muted-1');
  });

  it('reports both how many channels were covered and how many the bot cannot manage', async () => {
    const { c, editReplies, unmanageableEdit } = buildContext({ muteRoleOptId: 'muted-1' });

    await executeSetup(c);

    const text = replyText(editReplies);
    expect(text).toContain('applied deny-overwrites to 1 channel(s)');
    expect(text).toContain("1 skipped — I can't manage them");
    expect(unmanageableEdit).not.toHaveBeenCalled();
  });

  it('still saves the role and points at repair (rather than throwing) when the role cannot be read back', async () => {
    const { c, editReplies, setConfigCalls, generalEdit } = buildContext({
      muteRoleOptId: 'muted-1',
      roleResolves: false,
    });

    await executeSetup(c);

    expect(setConfigCalls[0]?.muteRoleId).toBe('muted-1');
    expect(generalEdit).not.toHaveBeenCalled();
    expect(replyText(editReplies)).toContain('/enforcer setup repair:true');
  });
});

describe('/enforcer setup — mute role created for a guild that has none', () => {
  it('reports skipped channels on the create-a-role branch too', async () => {
    const { c, editReplies, generalEdit } = buildContext({ muteRoleOptId: null });

    await executeSetup(c);

    expect(generalEdit).toHaveBeenCalledWith({ id: 'created-role' }, MUTE_DENY, {
      reason: 'Enforcer: apply mute role overwrite',
    });
    const text = replyText(editReplies);
    expect(text).toContain('applied deny-overwrites to 1 channel(s)');
    expect(text).toContain("1 skipped — I can't manage them");
  });
});

// A failed mute-role overwrite is not always about Manage Roles / Manage Channels: Discord also rejects an
// overwrite that denies a permission the bot does not hold itself, so a bot missing Speak fails the same way.
// The hint has to say so, or an admin fixes the two permissions it names and is still stuck.
describe('/enforcer setup — hint when the mute role cannot be applied', () => {
  it('names Speak as a possible cause when an overwrite fails during setup', async () => {
    const { c, editReplies } = buildContext({ muteRoleOptId: 'muted-1', muteEditFails: true });

    await executeSetup(c);

    const text = replyText(editReplies);
    expect(text).toContain('1 failed');
    expect(text).toContain('Manage Roles and Manage Channels');
    expect(text).toContain('Speak');
    expect(text).toContain('Send Messages in Threads');
    expect(text).toContain('Add Reactions');
  });

  it('names Speak as a possible cause when an overwrite fails during repair', async () => {
    const { c, editReplies } = buildContext({ repair: { muteApplied: 3, muteFailed: 2 } });

    await executeSetup(c);

    const text = replyText(editReplies);
    expect(text).toContain('mute role on 3 channel(s)');
    expect(text).toContain('2 failed');
    expect(text).toContain('Manage Roles and Manage Channels');
    expect(text).toContain('Speak');
  });

  it('gives no hint when every overwrite was applied', async () => {
    const { c, editReplies } = buildContext({ repair: { muteApplied: 5, muteFailed: 0 } });

    await executeSetup(c);

    const text = replyText(editReplies);
    expect(text).toContain('mute role on 5 channel(s)');
    expect(text).not.toContain('Speak');
    expect(text).not.toContain('failed');
  });
});
