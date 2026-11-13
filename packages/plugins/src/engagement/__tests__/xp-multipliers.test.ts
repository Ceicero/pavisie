import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChatInputCommandInteraction,
  EmbedBuilder,
  Message,
  OmitPartialGroupDMChannel,
  VoiceState,
} from 'discord.js';
import { redisKey } from '@pavisie/core';
import type { CommandContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { command as levelCommand } from '../commands/level';
import en from '../locales/en.json';
import { configSchema } from '../manifest';
import { messageCreateHandler } from '../events/message-create';
import { voiceStateUpdateHandler } from '../events/voice-state-update';
import { resolveXpMultiplier, tryAwardMessageXp, voiceXpForMinutes, type XpSubject } from '../service';

// ioredis-mock shares one keyspace across files. These cases never flushall. Every Redis write uses its
// own guild id plus the 2026-11-13 suffix so it cannot collide with another test's cooldown or hour key.

const DATE = '20261113';

function multipliers(
  role: { id: string; multiplier: number }[] = [],
  channel: { id: string; multiplier: number }[] = [],
) {
  return { roleMultipliers: role, channelMultipliers: channel };
}

describe('XP multiplier config', () => {
  it('parses a saved leveling config that has no multiplier keys', () => {
    const parsed = configSchema.parse({
      leveling: {
        enabled: true,
        xpPerMessageMin: 15,
        xpPerMessageMax: 25,
        xpCooldownSeconds: 60,
        maxXpPerHour: 600,
        voiceXpPerMinute: 5,
        ignoredChannelIds: ['kept-channel'],
        ignoredRoleIds: ['kept-role'],
        levelUpChannel: 'current',
        levelUpMessage: '🎉 {user} just reached **level {level}**!',
        rewardMode: 'stack',
      },
    });

    expect(parsed.leveling.roleMultipliers).toEqual([]);
    expect(parsed.leveling.channelMultipliers).toEqual([]);
    expect(parsed.leveling.ignoredChannelIds).toEqual(['kept-channel']);
    expect(parsed.leveling.ignoredRoleIds).toEqual(['kept-role']);
  });

  it('defaults both multiplier lists when the whole config is missing', () => {
    const parsed = configSchema.parse({});
    expect(parsed.leveling.roleMultipliers).toEqual([]);
    expect(parsed.leveling.channelMultipliers).toEqual([]);
  });

  it('clamps a multiplier into 0.25–5 instead of rejecting the saved config', () => {
    const parsed = configSchema.parse({
      leveling: {
        roleMultipliers: [
          { id: 'role-high', multiplier: 10 },
          { id: 'role-low', multiplier: 0 },
          { id: 'role-negative', multiplier: -4 },
          { id: 'role-ok', multiplier: 1.5 },
        ],
        channelMultipliers: [
          { id: 'channel-min', multiplier: 0.25 },
          { id: 'channel-max', multiplier: 5 },
          { id: 'channel-over', multiplier: 5.2 },
        ],
      },
    });

    expect(parsed.leveling.roleMultipliers).toEqual([
      { id: 'role-high', multiplier: 5 },
      { id: 'role-low', multiplier: 0.25 },
      { id: 'role-negative', multiplier: 0.25 },
      { id: 'role-ok', multiplier: 1.5 },
    ]);
    expect(parsed.leveling.channelMultipliers).toEqual([
      { id: 'channel-min', multiplier: 0.25 },
      { id: 'channel-max', multiplier: 5 },
      { id: 'channel-over', multiplier: 5 },
    ]);
  });
});

describe('resolveXpMultiplier', () => {
  it('uses a matching role multiplier', () => {
    const factor = resolveXpMultiplier(multipliers([{ id: 'booster', multiplier: 2 }]), {
      roleIds: ['everyone', 'booster'],
    });
    expect(factor).toBe(2);
  });

  it('uses a matching channel multiplier', () => {
    const factor = resolveXpMultiplier(multipliers([], [{ id: 'general', multiplier: 1.5 }]), {
      channelId: 'general',
    });
    expect(factor).toBe(1.5);
  });

  it('keeps the highest matching role and does not multiply roles together', () => {
    const factor = resolveXpMultiplier(
      multipliers([
        { id: 'a', multiplier: 2 },
        { id: 'b', multiplier: 3 },
        { id: 'a', multiplier: 1.25 },
      ]),
      { roleIds: ['a', 'b', 'unrelated'] },
    );
    expect(factor).toBe(3);
  });

  it('keeps the highest matching channel when a thread and its parent both have entries', () => {
    const factor = resolveXpMultiplier(
      multipliers(
        [],
        [
          { id: 'thread', multiplier: 0.5 },
          { id: 'parent', multiplier: 2 },
        ],
      ),
      { channelId: 'thread', parentChannelId: 'parent' },
    );
    expect(factor).toBe(2);
  });

  it('falls back to the parent channel when the thread itself has no multiplier', () => {
    const factor = resolveXpMultiplier(multipliers([], [{ id: 'parent', multiplier: 2 }]), {
      channelId: 'thread',
      parentChannelId: 'parent',
    });
    expect(factor).toBe(2);
  });

  it('uses the thread multiplier when the parent channel has none', () => {
    const factor = resolveXpMultiplier(multipliers([], [{ id: 'thread', multiplier: 0.5 }]), {
      channelId: 'thread',
      parentChannelId: 'parent',
    });
    expect(factor).toBe(0.5);
  });

  it('combines the role factor and the channel factor by taking the max, not the product', () => {
    const boosted = resolveXpMultiplier(
      multipliers([{ id: 'role', multiplier: 2 }], [{ id: 'channel', multiplier: 4 }]),
      { roleIds: ['role'], channelId: 'channel' },
    );
    expect(boosted).toBe(4);

    const roleWins = resolveXpMultiplier(
      multipliers([{ id: 'role', multiplier: 3 }], [{ id: 'channel', multiplier: 2 }]),
      { roleIds: ['role'], channelId: 'channel' },
    );
    expect(roleWins).toBe(3);

    // A stored 1 still counts, so it outweighs a lower role multiplier. Omit the channel to keep the reduction.
    const explicitOne = resolveXpMultiplier(
      multipliers([{ id: 'role', multiplier: 0.25 }], [{ id: 'channel', multiplier: 1 }]),
      { roleIds: ['role'], channelId: 'channel' },
    );
    expect(explicitOne).toBe(1);
  });

  it('still applies a role reduction when no channel multiplier matches', () => {
    const factor = resolveXpMultiplier(multipliers([{ id: 'muted-xp', multiplier: 0.25 }]), {
      roleIds: ['muted-xp'],
      channelId: 'general',
    });
    expect(factor).toBe(0.25);
  });

  it('is 1 when nothing matches', () => {
    const factor = resolveXpMultiplier(
      multipliers([{ id: 'other', multiplier: 5 }], [{ id: 'elsewhere', multiplier: 5 }]),
      {
        roleIds: ['member'],
        channelId: 'general',
        parentChannelId: null,
      } satisfies XpSubject,
    );
    expect(factor).toBe(1);
  });

  it('clamps an out-of-range entry at resolution time', () => {
    const factor = resolveXpMultiplier(multipliers([{ id: 'role', multiplier: 99 }]), { roleIds: ['role'] });
    expect(factor).toBe(5);
  });
});

describe('message XP multiplier', () => {
  it('multiplies the 15–25 roll, then floors, before the hourly cap sees it', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const guildId = `g-xp-mult-roll-${DATE}`;
    const userId = `u-xp-mult-roll-${DATE}`;
    // rng 0.1 rolls 16 inside [15, 25]. 16 * 2.5 = 40. Scaling the bounds and rolling again would be 39.
    const result = await tryAwardMessageXp(
      redis,
      guildId,
      userId,
      { xpPerMessageMin: 15, xpPerMessageMax: 25, xpCooldownSeconds: 0, maxXpPerHour: 1000, multiplier: 2.5 },
      () => 0.1,
    );
    expect(result).toEqual({ awarded: true, xpGained: 40 });
  });

  it('clamps the multiplied grant to the remaining hourly cap and counts that XP against the cap', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const guildId = `g-xp-mult-hour-${DATE}`;
    const userId = `u-xp-mult-hour-${DATE}`;
    const config = {
      xpPerMessageMin: 15,
      xpPerMessageMax: 15,
      xpCooldownSeconds: 0,
      maxXpPerHour: 40,
      multiplier: 2,
    };

    const first = await tryAwardMessageXp(redis, guildId, userId, config, () => 0);
    expect(first).toEqual({ awarded: true, xpGained: 30 });

    const second = await tryAwardMessageXp(redis, guildId, userId, config, () => 0);
    expect(second).toEqual({ awarded: true, xpGained: 10 });

    const third = await tryAwardMessageXp(redis, guildId, userId, config, () => 0);
    expect(third).toEqual({ awarded: false, xpGained: 0, reason: 'hourly_cap' });

    expect(await redis.get(redisKey('engagement', 'xphour', guildId, userId))).toBe('40');
  });
});

describe('voice XP multiplier', () => {
  it('multiplies minutes × rate and floors the result', () => {
    expect(voiceXpForMinutes(10, 5, 2)).toBe(100);
    expect(voiceXpForMinutes(10, 5, 0.25)).toBe(12);
    expect(voiceXpForMinutes(2.9, 5, 2)).toBe(20);
    expect(voiceXpForMinutes(10, 5)).toBe(50);
  });
});

function realT(key: string, vars?: Record<string, string | number>): string {
  const parts = key.split('.');
  let node: unknown = en;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  if (typeof node !== 'string') return key;
  let out = node;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value));
  }
  return out;
}

interface MessageSpec {
  guildId: string;
  channelId: string;
  userId: string;
  parentChannelId?: string | null;
  roleIds?: string[];
}

function buildMessage(spec: MessageSpec): OmitPartialGroupDMChannel<Message> {
  const channel =
    spec.parentChannelId !== undefined
      ? { id: spec.channelId, isThread: () => true, parentId: spec.parentChannelId }
      : undefined;
  return {
    guild: { id: spec.guildId },
    guildId: spec.guildId,
    channelId: spec.channelId,
    channel,
    author: { id: spec.userId, bot: false },
    member: spec.roleIds ? { roles: { cache: new Map(spec.roleIds.map((id) => [id, { id }])) } } : null,
    system: false,
    webhookId: null,
  } as unknown as OmitPartialGroupDMChannel<Message>;
}

describe('message XP applies the resolved multiplier', () => {
  it('awards a role multiplier on an ordinary message', async () => {
    const guildId = `g-xp-mult-role-msg-${DATE}`;
    const userId = `u-xp-mult-role-msg-${DATE}`;
    const cfg = configSchema.parse({
      leveling: { roleMultipliers: [{ id: 'booster', multiplier: 2 }], xpCooldownSeconds: 0 },
    });
    const { ctx, prismaCalls } = createTestContext({
      config: cfg,
      prismaOverrides: {
        levelProfile: {
          upsert: async () => ({ id: 'p-role', guildId, userId, xp: 20, level: 0 }),
        },
      },
    });

    await messageCreateHandler.handler(
      ctx,
      buildMessage({ guildId, channelId: `chan-role-msg-${DATE}`, userId, roleIds: ['booster'] }),
    );

    const upsert = prismaCalls.find((call) => call.model === 'levelProfile' && call.method === 'upsert');
    const xp = (upsert?.args[0] as { create?: { xp?: number } } | undefined)?.create?.xp;
    expect(xp).toBeGreaterThanOrEqual(30);
    expect(xp).toBeLessThanOrEqual(50);
  });

  it('falls back to the parent channel multiplier for a thread', async () => {
    const guildId = `g-xp-mult-thread-msg-${DATE}`;
    const userId = `u-xp-mult-thread-msg-${DATE}`;
    const parentId = `parent-mult-${DATE}`;
    const cfg = configSchema.parse({
      leveling: { channelMultipliers: [{ id: parentId, multiplier: 2 }], xpCooldownSeconds: 0 },
    });
    const { ctx, prismaCalls } = createTestContext({
      config: cfg,
      prismaOverrides: {
        levelProfile: {
          upsert: async () => ({ id: 'p-thread', guildId, userId, xp: 20, level: 0 }),
        },
      },
    });

    await messageCreateHandler.handler(
      ctx,
      buildMessage({
        guildId,
        channelId: `thread-mult-${DATE}`,
        userId,
        parentChannelId: parentId,
      }),
    );

    const upsert = prismaCalls.find((call) => call.model === 'levelProfile' && call.method === 'upsert');
    const xp = (upsert?.args[0] as { create?: { xp?: number } } | undefined)?.create?.xp;
    expect(xp).toBeGreaterThanOrEqual(30);
    expect(xp).toBeLessThanOrEqual(50);
  });
});

interface MemberFake {
  id: string;
  user: { id: string; bot: boolean };
  roles: { cache: Map<string, { id: string }> };
  voice: { selfMute: boolean; selfDeaf: boolean; serverMute: boolean; serverDeaf: boolean };
}

interface ChannelFake {
  id: string;
  isVoiceBased: () => boolean;
  members: Map<string, MemberFake>;
}

function buildMember(id: string, roleIds: string[] = []): MemberFake {
  return {
    id,
    user: { id, bot: false },
    roles: { cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])) },
    voice: { selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false },
  };
}

function buildChannel(id: string, members: MemberFake[]): ChannelFake {
  return { id, isVoiceBased: () => true, members: new Map(members.map((member) => [member.id, member])) };
}

function voiceState(
  guild: { id: string; channels: { cache: Map<string, ChannelFake> }; members: { me: null } },
  member: MemberFake,
  channelId: string | null,
): VoiceState {
  return {
    id: member.id,
    channelId,
    guild,
    member,
    channel: channelId ? (guild.channels.cache.get(channelId) ?? null) : null,
  } as unknown as VoiceState;
}

describe('voice XP applies the resolved multiplier', () => {
  it('pays a channel multiplier when the member leaves', async () => {
    const guildId = `g-xp-mult-voice-chan-${DATE}`;
    const channelId = `voice-mult-chan-${DATE}`;
    const memberA = buildMember(`u-xp-mult-voice-a-${DATE}`);
    const memberB = buildMember(`u-xp-mult-voice-b-${DATE}`);
    const channel = buildChannel(channelId, [memberA, memberB]);
    const guild = {
      id: guildId,
      channels: { cache: new Map([[channelId, channel]]) },
      members: { me: null },
    };
    const cfg = configSchema.parse({
      leveling: { channelMultipliers: [{ id: channelId, multiplier: 2 }], voiceXpPerMinute: 5 },
    });
    const { ctx, prismaCalls, redis } = createTestContext({
      config: cfg,
      prismaOverrides: {
        levelProfile: {
          upsert: async (args: unknown) => {
            const create = (args as { create?: { userId?: string; xp?: number; voiceMinutes?: number } })
              .create;
            return {
              id: 'p-voice-chan',
              guildId,
              userId: create?.userId,
              xp: create?.xp ?? 0,
              level: 0,
              voiceMinutes: create?.voiceMinutes ?? 0,
            };
          },
        },
      },
    });

    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, null),
      voiceState(guild, memberA, channelId),
    );
    await redis.set(
      redisKey('engagement', 'voicesession', guildId, memberA.id),
      String(Date.now() - 4 * 60_000),
      'EX',
      12 * 60 * 60,
    );
    channel.members.delete(memberA.id);
    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, channelId),
      voiceState(guild, memberA, null),
    );

    const upsert = prismaCalls.find((call) => call.model === 'levelProfile' && call.method === 'upsert');
    expect(upsert?.args[0]).toMatchObject({
      create: { guildId, userId: memberA.id, xp: 40, voiceMinutes: 4 },
    });
  });

  it('pays a role multiplier when the member leaves', async () => {
    const guildId = `g-xp-mult-voice-role-${DATE}`;
    const channelId = `voice-mult-role-${DATE}`;
    const memberA = buildMember(`u-xp-mult-voice-role-a-${DATE}`, ['booster']);
    const memberB = buildMember(`u-xp-mult-voice-role-b-${DATE}`);
    const channel = buildChannel(channelId, [memberA, memberB]);
    const guild = {
      id: guildId,
      channels: { cache: new Map([[channelId, channel]]) },
      members: { me: null },
    };
    const cfg = configSchema.parse({
      leveling: { roleMultipliers: [{ id: 'booster', multiplier: 3 }], voiceXpPerMinute: 5 },
    });
    const { ctx, prismaCalls, redis } = createTestContext({
      config: cfg,
      prismaOverrides: {
        levelProfile: {
          upsert: async (args: unknown) => {
            const create = (args as { create?: { userId?: string; xp?: number; voiceMinutes?: number } })
              .create;
            return {
              id: 'p-voice-role',
              guildId,
              userId: create?.userId,
              xp: create?.xp ?? 0,
              level: 0,
              voiceMinutes: create?.voiceMinutes ?? 0,
            };
          },
        },
      },
    });

    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, null),
      voiceState(guild, memberA, channelId),
    );
    await redis.set(
      redisKey('engagement', 'voicesession', guildId, memberA.id),
      String(Date.now() - 4 * 60_000),
      'EX',
      12 * 60 * 60,
    );
    channel.members.delete(memberA.id);
    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, channelId),
      voiceState(guild, memberA, null),
    );

    const upsert = prismaCalls.find((call) => call.model === 'levelProfile' && call.method === 'upsert');
    expect(upsert?.args[0]).toMatchObject({
      create: { guildId, userId: memberA.id, xp: 60, voiceMinutes: 4 },
    });
  });
});

describe('/level config and /level multiplier', () => {
  function firstReplyText(replies: { embeds?: EmbedBuilder[] }[]): string {
    return replies[0]?.embeds?.[0]?.data.description ?? '';
  }

  it('shows role and channel multipliers', async () => {
    const replies: { embeds?: EmbedBuilder[]; ephemeral?: boolean }[] = [];
    const cfg = configSchema.parse({
      leveling: {
        roleMultipliers: [{ id: '123456789012345678', multiplier: 2 }],
        channelMultipliers: [{ id: '223456789012345678', multiplier: 0.5 }],
      },
    });
    const interaction = {
      user: { id: 'mod-1' },
      guild: { id: 'guild-config' },
      options: {
        getSubcommand: () => 'config',
        getSubcommandGroup: () => null,
        getString: () => null,
        getChannel: () => null,
        getUser: () => null,
        getInteger: () => null,
        getRole: () => null,
        getNumber: () => null,
      },
      reply: vi.fn(async (payload: { embeds?: EmbedBuilder[]; ephemeral?: boolean }) => {
        replies.push(payload);
      }),
    };
    const { ctx } = createTestContext({ config: cfg });
    const c: CommandContext = {
      interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
      ctx,
      guildId: 'guild-config',
      staffLevel: 'moderator',
      locale: 'en-US' as never,
      t: realT,
      config: async <T>() => cfg as T,
    };

    await levelCommand.execute(c);
    const text = firstReplyText(replies);
    expect(text).toContain('<@&123456789012345678> ×2');
    expect(text).toContain('<#223456789012345678> ×0.5');
    expect(text.toLowerCase()).toContain('not multiplied');
  });

  it('sets one role multiplier and replaces an entry for the same role', async () => {
    const replies: { embeds?: EmbedBuilder[] }[] = [];
    const setConfigCalls: unknown[] = [];
    const cfg = configSchema.parse({
      leveling: { roleMultipliers: [{ id: '123456789012345678', multiplier: 2 }] },
    });
    const interaction = {
      user: { id: 'admin-1' },
      guild: { id: 'guild-set' },
      options: {
        getSubcommand: () => 'set',
        getSubcommandGroup: () => 'multiplier',
        getString: () => null,
        getChannel: () => null,
        getUser: () => null,
        getInteger: () => null,
        getRole: (name: string) => (name === 'role' ? { id: '123456789012345678' } : null),
        getNumber: (name: string) => (name === 'multiplier' ? 3 : null),
      },
      reply: vi.fn(async (payload: { embeds?: EmbedBuilder[] }) => {
        replies.push(payload);
      }),
    };
    const { ctx } = createTestContext({
      config: cfg,
      overrides: {
        setConfig: async <T>(_guildId: string, patch: Partial<T>) => {
          setConfigCalls.push(patch);
          return { ...cfg, ...patch } as T;
        },
      },
    });
    const c: CommandContext = {
      interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
      ctx,
      guildId: 'guild-set',
      staffLevel: 'admin',
      locale: 'en-US' as never,
      t: realT,
      config: async <T>() => cfg as T,
    };

    await levelCommand.execute(c);
    expect(setConfigCalls).toEqual([
      {
        leveling: expect.objectContaining({
          roleMultipliers: [{ id: '123456789012345678', multiplier: 3 }],
        }),
      },
    ]);
    expect(firstReplyText(replies)).toContain('<@&123456789012345678>');
  });
});
