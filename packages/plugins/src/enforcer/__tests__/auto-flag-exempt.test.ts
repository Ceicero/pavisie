import { describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits, type Client, type Message } from 'discord.js';
import type { PrismaClient } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import { messageCreateHandler } from '../events/message-create';
import type { EnforcerConfig } from '../manifest';
import type { HostService } from '../../sdk/services';

function defaultConfig(overrides: Partial<EnforcerConfig> = {}): EnforcerConfig {
  return {
    ledgerChannelId: null,
    ledgerVisibility: 'staff',
    flagChannelId: null,
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

function fakeHost(staffRoles: {
  adminRoleIds?: string[];
  modRoleIds?: string[];
  helperRoleIds?: string[];
}): HostService {
  return {
    getGuildConfig: vi.fn(async () => ({
      guildId: 'g1',
      adminRoleIds: staffRoles.adminRoleIds ?? [],
      modRoleIds: staffRoles.modRoleIds ?? [],
      helperRoleIds: staffRoles.helperRoleIds ?? [],
    })),
  } as unknown as HostService;
}

/** Prisma fake with one enabled "Discord invite links" policy, recording every FLAG row `flagRecord` writes. */
function makePrisma(created: Record<string, unknown>[]): PrismaClient {
  return {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ enforcerRecord: { aggregate: async () => ({ _max: { recordNumber: 0 } }) } }),
    enforcerPolicy: {
      findMany: async () => [
        {
          id: 'pol-1',
          name: 'Discord invite links',
          enabled: true,
          severity: 'MEDIUM',
          matchers: [{ type: 'invite', value: 'discord-invite' }],
          channelIds: [],
          exemptRoleIds: [],
          exemptChannelIds: [],
        },
      ],
    },
    enforcerRecord: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'rec-1', recordNumber: 1 };
      },
    },
  } as unknown as PrismaClient;
}

/** Guild fake with no ledger/flag-queue channels configured, so `flagRecord` stops after the database write. */
function fakeClient(): Client<true> {
  const guild = { id: 'g1', channels: { fetch: async () => null } };
  return { guilds: { fetch: async () => guild } } as unknown as Client<true>;
}

interface AuthorSpec {
  id: string;
  roleIds?: string[];
  permissions?: bigint;
}

const GUILD_OWNER_ID = 'owner-1';

function fakeMessage(messageId: string, author: AuthorSpec): Message {
  const member = {
    id: author.id,
    user: { bot: false },
    permissions: { bitfield: author.permissions ?? 0n },
    roles: {
      cache: new Map((author.roleIds ?? []).map((id) => [id, { id }])),
      highest: { position: 1 },
    },
  };
  return {
    id: messageId,
    guildId: 'g1',
    guild: { id: 'g1', ownerId: GUILD_OWNER_ID },
    inGuild: () => true,
    author: { id: author.id, bot: false },
    webhookId: null,
    system: false,
    content: 'come join discord.gg/abcdefg',
    channelId: 'chan-1',
    member,
    mentions: { users: { size: 0 }, roles: { size: 0 }, everyone: false },
    attachments: new Map(),
  } as unknown as Message;
}

function buildCtx(
  created: Record<string, unknown>[],
  opts: { config?: Partial<EnforcerConfig>; staffRoles?: Parameters<typeof fakeHost>[0] } = {},
) {
  const { ctx } = createTestContext({
    config: defaultConfig(opts.config),
    intentsEnabled: { messageContent: true },
    overrides: { prisma: makePrisma(created), client: fakeClient() },
  });
  ctx.services.register('host', fakeHost(opts.staffRoles ?? {}));
  return ctx;
}

/** Runs the handler with the fake message — `as never` matches how the other event-handler tests here call in. */
async function run(ctx: Parameters<typeof messageCreateHandler.handler>[0], message: Message): Promise<void> {
  await messageCreateHandler.handler(ctx, message as never);
}

describe('enforcer auto-flag — exemptStaff uses the same staff resolution as the rest of the plugin', () => {
  it('flags an ordinary member (control)', async () => {
    const created: Record<string, unknown>[] = [];
    const ctx = buildCtx(created);

    await run(ctx, fakeMessage('m-control', { id: 'member-1' }));

    expect(created).toHaveLength(1);
    expect(created[0]?.kind).toBe('FLAG');
  });

  it('exempts the guild owner, who holds no configured staff role at all', async () => {
    const created: Record<string, unknown>[] = [];
    const ctx = buildCtx(created);

    await run(ctx, fakeMessage('m-owner', { id: GUILD_OWNER_ID }));

    expect(created).toHaveLength(0);
  });

  it('exempts a moderator identified by Discord permissions when the staff-role config is empty', async () => {
    const created: Record<string, unknown>[] = [];
    const ctx = buildCtx(created);

    await run(ctx, fakeMessage('m-perm-mod', { id: 'mod-1', permissions: PermissionFlagsBits.ManageMessages }));

    expect(created).toHaveLength(0);
  });

  it('exempts an admin identified by ManageGuild when the staff-role config is empty', async () => {
    const created: Record<string, unknown>[] = [];
    const ctx = buildCtx(created);

    await run(ctx, fakeMessage('m-perm-admin', { id: 'admin-1', permissions: PermissionFlagsBits.ManageGuild }));

    expect(created).toHaveLength(0);
  });

  it('still exempts a member holding a configured staff role', async () => {
    const created: Record<string, unknown>[] = [];
    const ctx = buildCtx(created, { staffRoles: { helperRoleIds: ['helper-role'] } });

    await run(ctx, fakeMessage('m-configured', { id: 'helper-1', roleIds: ['helper-role'] }));

    expect(created).toHaveLength(0);
  });

  it('flags staff like anyone else when exemptStaff is turned off', async () => {
    const created: Record<string, unknown>[] = [];
    const ctx = buildCtx(created, { config: { exemptStaff: false } });

    // A user id no other test flags: ioredis-mock shares one keyspace across instances, so reusing an id that
    // another test already flagged would hit the per-user/per-policy cooldown instead of this assertion.
    await run(
      ctx,
      fakeMessage('m-staff-not-exempt', { id: 'mod-9', permissions: PermissionFlagsBits.ManageMessages }),
    );

    expect(created).toHaveLength(1);
  });
});
