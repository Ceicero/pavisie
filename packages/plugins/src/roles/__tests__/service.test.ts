import { ChannelType } from 'discord.js';
import { PermissionFlagsBits } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../sdk/testing';
import { createRolesService } from '../service';
import { filterAssignableRoles } from '../service';

function fakeRole(id: string, opts: { permissions?: bigint; position?: number; managed?: boolean } = {}) {
  return {
    id,
    permissions: { bitfield: opts.permissions ?? 0n },
    position: opts.position ?? 1,
    managed: opts.managed ?? false,
  };
}

function fakeGuild(roles: ReturnType<typeof fakeRole>[], botTopPosition = 10) {
  const cache = new Map(roles.map((r) => [r.id, r]));
  return {
    members: { me: { roles: { highest: { position: botTopPosition } } } },
    roles: { cache },
  } as unknown as import('discord.js').Guild;
}

describe('filterAssignableRoles', () => {
  it('allows safe roles and skips elevated/managed/high-position roles with a reason', () => {
    const guild = fakeGuild([
      fakeRole('safe', { permissions: PermissionFlagsBits.SendMessages, position: 2 }),
      fakeRole('elevated', { permissions: PermissionFlagsBits.BanMembers, position: 2 }),
      fakeRole('managed', { managed: true, position: 2 }),
      fakeRole('toohigh', { position: 15 }),
    ]);

    const { allowed, skipped } = filterAssignableRoles(
      guild,
      ['safe', 'elevated', 'managed', 'toohigh', 'missing'],
      false,
    );

    expect(allowed).toEqual(['safe']);
    expect(skipped.map((s) => s.roleId).sort()).toEqual(['elevated', 'managed', 'missing', 'toohigh'].sort());
  });

  it('allows elevated roles when allowElevatedRoles is true', () => {
    const guild = fakeGuild([
      fakeRole('elevated', { permissions: PermissionFlagsBits.BanMembers, position: 2 }),
    ]);
    const { allowed } = filterAssignableRoles(guild, ['elevated'], true);
    expect(allowed).toEqual(['elevated']);
  });
});

describe('createRolesService — verificationDecision', () => {
  it('throws AppError when the request is already decided (atomic race guard)', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: {
        verificationRequest: {
          findFirst: () =>
            Promise.resolve({
              id: 'req1',
              guildId: 'g1',
              userId: 'u1',
              status: 'APPROVED',
              staffMessageId: null,
            }),
          updateMany: () =>
            Promise.resolve({
              count: 0, // No rows matched the PENDING status check
            }),
        },
      },
    });

    const service = createRolesService(ctx);
    await expect(
      service.verificationDecision({
        guildId: 'g1',
        requestId: 'req1',
        approve: true,
        reviewerId: 'mod1',
      }),
    ).rejects.toThrow(/already decided/i);
  });

  it('throws NotFoundError when the request does not exist', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: { verificationRequest: { findFirst: () => Promise.resolve(null) } },
    });
    const service = createRolesService(ctx);
    await expect(
      service.verificationDecision({
        guildId: 'g1',
        requestId: 'missing',
        approve: true,
        reviewerId: 'mod1',
      }),
    ).rejects.toThrow();
  });

  it('supports the bot-actions single-object call shape for postPanel/testWelcome/verificationDecision', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: { verificationRequest: { findFirst: () => Promise.resolve(null) } },
    });
    const service = createRolesService(ctx);
    // apps/bot/src/host/bot-actions.ts calls `method.call(service, { guildId, payload, requestedBy })`.
    const dual = service.verificationDecision as unknown as (arg: {
      guildId: string;
      payload: { requestId: string; approve: boolean };
      requestedBy: string;
    }) => Promise<void>;
    await expect(
      dual({ guildId: 'g1', payload: { requestId: 'missing', approve: true }, requestedBy: 'mod1' }),
    ).rejects.toThrow();
  });
});

/** A REACTIONS-style panel with `options` and, when `messageId` is set, an already-posted message to re-post over. */
function reactionPanelFixture(input: {
  messageId: string | null;
  options: { roleId: string; emoji: string | null }[];
  existingReactions?: { emoji: string; me: boolean }[];
}) {
  const reacted: string[] = [];
  const unreacted: string[] = [];

  const message = {
    id: 'm1',
    edit: () => Promise.resolve(undefined),
    react: (emoji: string) => {
      reacted.push(emoji);
      return Promise.resolve(undefined);
    },
    reactions: {
      cache: new Map(
        (input.existingReactions ?? []).map((r) => [
          r.emoji,
          {
            emoji: { id: null, name: r.emoji, animated: false },
            me: r.me,
            users: {
              remove: () => {
                unreacted.push(r.emoji);
                return Promise.resolve(undefined);
              },
            },
          },
        ]),
      ),
    },
  };

  const channel = {
    id: 'c1',
    isTextBased: () => true,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: () => Promise.resolve(message) },
    send: () => Promise.resolve(message),
  };

  const guild = {
    id: 'g1',
    channels: { fetch: () => Promise.resolve(channel) },
    members: { me: { id: 'bot' } },
  };

  const panel = {
    id: 'p1',
    guildId: 'g1',
    channelId: 'c1',
    messageId: input.messageId,
    style: 'REACTIONS',
    title: 'Colours',
    description: null,
    options: input.options.map((opt, index) => ({
      id: `opt${index}`,
      roleId: opt.roleId,
      label: opt.roleId,
      description: null,
      emoji: opt.emoji,
      position: index,
    })),
  };

  const { ctx } = createTestContext({
    prismaOverrides: {
      rolePanel: { findFirst: () => Promise.resolve(panel), update: () => Promise.resolve(panel) },
    },
    overrides: {
      client: { guilds: { fetch: () => Promise.resolve(guild) } } as never,
    },
  });

  return { ctx, reacted, unreacted };
}

describe('createRolesService — postPanel reactions', () => {
  it('adds the missing emoji when an existing reaction panel is re-posted', async () => {
    const { ctx, reacted } = reactionPanelFixture({
      messageId: 'm1',
      options: [
        { roleId: 'red', emoji: '🔴' },
        { roleId: 'blue', emoji: '🔵' },
      ],
      existingReactions: [{ emoji: '🔴', me: true }],
    });

    await createRolesService(ctx).postPanel('g1', 'p1', 'u1');

    expect(reacted).toEqual(['🔵']);
  });

  it('drops the bot reaction for an option that no longer exists', async () => {
    const { ctx, reacted, unreacted } = reactionPanelFixture({
      messageId: 'm1',
      options: [{ roleId: 'red', emoji: '🔴' }],
      existingReactions: [
        { emoji: '🔴', me: true },
        { emoji: '⚪', me: true },
      ],
    });

    await createRolesService(ctx).postPanel('g1', 'p1', 'u1');

    expect(unreacted).toEqual(['⚪']);
    expect(reacted).toEqual([]);
  });

  it('reacts with every mapped emoji on a first post', async () => {
    const { ctx, reacted } = reactionPanelFixture({
      messageId: null,
      options: [
        { roleId: 'red', emoji: '🔴' },
        { roleId: 'blue', emoji: '🔵' },
        { roleId: 'nope', emoji: null },
      ],
    });

    await createRolesService(ctx).postPanel('g1', 'p1', 'u1');

    expect(reacted).toEqual(['🔴', '🔵']);
  });
});
