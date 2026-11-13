import { describe, expect, it } from 'vitest';
import type { VoiceState } from 'discord.js';
import { redisKey } from '@pavisie/core';
import { createTestContext } from '../../sdk/testing';
import { voiceStateUpdateHandler } from '../events/voice-state-update';
import { configSchema } from '../manifest';
import { hasVoiceSession } from '../service';

// ioredis-mock shares its keyspace across instances. Every case here uses its own guild id (and a
// distinct 2026-11-13 suffix) and never flushall, so a voice session key cannot collide with or wipe
// another test. Session clocks are rewound by a different whole-minute offset per case.

const VOICE_XP_PER_MINUTE = 5;

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

interface GuildFake {
  id: string;
  channels: { cache: Map<string, ChannelFake> };
  members: { me: null };
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
  return {
    id,
    isVoiceBased: () => true,
    members: new Map(members.map((member) => [member.id, member])),
  };
}

function buildGuild(id: string, channels: ChannelFake[]): GuildFake {
  return {
    id,
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
    members: { me: null },
  };
}

function voiceState(guild: GuildFake, member: MemberFake, channelId: string | null): VoiceState {
  const channel = channelId ? (guild.channels.cache.get(channelId) ?? null) : null;
  return {
    id: member.id,
    channelId,
    guild,
    member,
    channel,
  } as unknown as VoiceState;
}

function buildContext(
  guildId: string,
  leveling: { ignoredChannelIds?: string[]; ignoredRoleIds?: string[] },
) {
  const cfg = configSchema.parse({
    leveling: { ...leveling, voiceXpPerMinute: VOICE_XP_PER_MINUTE },
  });
  return createTestContext({
    config: cfg,
    prismaOverrides: {
      levelProfile: {
        upsert: async (args: unknown) => {
          const create = (args as { create?: { userId?: string; xp?: number; voiceMinutes?: number } })
            .create;
          return {
            id: `profile-${create?.userId ?? 'unknown'}`,
            guildId,
            userId: create?.userId ?? 'unknown',
            xp: create?.xp ?? 0,
            level: 0,
            voiceMinutes: create?.voiceMinutes ?? 0,
          };
        },
      },
    },
  });
}

async function rewindSession(
  redis: { set: (key: string, value: string, ex: 'EX', seconds: number) => Promise<unknown> },
  guildId: string,
  userId: string,
  minutesAgo: number,
) {
  await redis.set(
    redisKey('engagement', 'voicesession', guildId, userId),
    String(Date.now() - minutesAgo * 60_000),
    'EX',
    12 * 60 * 60,
  );
}

function levelUpserts(prismaCalls: { model: string; method: string; args: unknown[] }[]) {
  return prismaCalls.filter((call) => call.model === 'levelProfile' && call.method === 'upsert');
}

describe('engagement voice XP no-XP guards', () => {
  it('awards voice XP for two eligible humans in a channel that is not ignored', async () => {
    const guildId = 'g-voice-open-20261113';
    const channelId = 'voice-open-20261113';
    const memberA = buildMember('user-voice-open-a-20261113');
    const memberB = buildMember('user-voice-open-b-20261113');
    const channel = buildChannel(channelId, [memberA, memberB]);
    const guild = buildGuild(guildId, [channel]);
    const { ctx, prismaCalls, redis } = buildContext(guildId, {});

    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, null),
      voiceState(guild, memberA, channelId),
    );
    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(true);
    expect(await hasVoiceSession(redis, guildId, memberB.id)).toBe(true);

    await rewindSession(redis, guildId, memberA.id, 3);
    channel.members.delete(memberA.id);
    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, channelId),
      voiceState(guild, memberA, null),
    );

    const upserts = levelUpserts(prismaCalls);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.args[0]).toMatchObject({
      create: { guildId, userId: memberA.id, xp: 3 * VOICE_XP_PER_MINUTE, voiceMinutes: 3 },
    });
    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(false);
  });

  it('earns no voice XP in an ignored voice channel', async () => {
    const guildId = 'g-voice-ignored-channel-20261113';
    const channelId = 'voice-ignored-channel-20261113';
    const memberA = buildMember('user-voice-ignored-chan-a-20261113');
    const memberB = buildMember('user-voice-ignored-chan-b-20261113');
    const channel = buildChannel(channelId, [memberA, memberB]);
    const guild = buildGuild(guildId, [channel]);
    const { ctx, prismaCalls, redis } = buildContext(guildId, { ignoredChannelIds: [channelId] });

    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, null),
      voiceState(guild, memberA, channelId),
    );

    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(false);
    expect(await hasVoiceSession(redis, guildId, memberB.id)).toBe(false);
    expect(levelUpserts(prismaCalls)).toHaveLength(0);

    channel.members.delete(memberA.id);
    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, channelId),
      voiceState(guild, memberA, null),
    );
    expect(levelUpserts(prismaCalls)).toHaveLength(0);
  });

  it('does not award voice XP to a member with an ignored role while the other eligible humans still earn it', async () => {
    const guildId = 'g-voice-ignored-role-20261113';
    const channelId = 'voice-ignored-role-20261113';
    const ignoredRoleId = 'role-ignored-20261113';
    const memberA = buildMember('user-voice-role-a-20261113');
    const memberB = buildMember('user-voice-role-b-20261113');
    const ignored = buildMember('user-voice-role-ignored-20261113', [ignoredRoleId]);
    const channel = buildChannel(channelId, [memberA, memberB, ignored]);
    const guild = buildGuild(guildId, [channel]);
    const { ctx, prismaCalls, redis } = buildContext(guildId, { ignoredRoleIds: [ignoredRoleId] });

    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, null),
      voiceState(guild, memberA, channelId),
    );

    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(true);
    expect(await hasVoiceSession(redis, guildId, memberB.id)).toBe(true);
    expect(await hasVoiceSession(redis, guildId, ignored.id)).toBe(false);

    channel.members.delete(ignored.id);
    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, ignored, channelId),
      voiceState(guild, ignored, null),
    );

    expect(levelUpserts(prismaCalls)).toHaveLength(0);
    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(true);
    expect(await hasVoiceSession(redis, guildId, memberB.id)).toBe(true);
  });

  // An ignored-role member is excluded from the two-human minimum. One earning member plus one
  // no-XP member is not a qualifying channel, so the earning member does not get a session either.
  it('does not count an ignored-role member toward the two-human voice minimum', async () => {
    const guildId = 'g-voice-quorum-role-20261113';
    const channelId = 'voice-quorum-role-20261113';
    const ignoredRoleId = 'role-quorum-ignored-20261113';
    const memberA = buildMember('user-voice-quorum-a-20261113');
    const ignored = buildMember('user-voice-quorum-ignored-20261113', [ignoredRoleId]);
    const channel = buildChannel(channelId, [memberA, ignored]);
    const guild = buildGuild(guildId, [channel]);
    const { ctx, redis } = buildContext(guildId, { ignoredRoleIds: [ignoredRoleId] });

    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, null),
      voiceState(guild, memberA, channelId),
    );

    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(false);
    expect(await hasVoiceSession(redis, guildId, ignored.id)).toBe(false);
  });

  it('settles accrued voice XP when a member gains an ignored role and does not keep tracking them', async () => {
    const guildId = 'g-voice-role-mid-20261113';
    const channelId = 'voice-role-mid-20261113';
    const ignoredRoleId = 'role-mid-ignored-20261113';
    const memberA = buildMember('user-voice-mid-a-20261113');
    const memberB = buildMember('user-voice-mid-b-20261113');
    const memberC = buildMember('user-voice-mid-c-20261113');
    const channel = buildChannel(channelId, [memberA, memberB, memberC]);
    const guild = buildGuild(guildId, [channel]);
    const { ctx, prismaCalls, redis } = buildContext(guildId, { ignoredRoleIds: [ignoredRoleId] });

    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, null),
      voiceState(guild, memberA, channelId),
    );
    expect(await hasVoiceSession(redis, guildId, memberC.id)).toBe(true);

    await rewindSession(redis, guildId, memberC.id, 4);
    memberC.roles.cache.set(ignoredRoleId, { id: ignoredRoleId });
    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberB, channelId),
      voiceState(guild, memberB, channelId),
    );

    expect(levelUpserts(prismaCalls)).toHaveLength(1);
    expect(levelUpserts(prismaCalls)[0]?.args[0]).toMatchObject({
      create: { guildId, userId: memberC.id, xp: 4 * VOICE_XP_PER_MINUTE, voiceMinutes: 4 },
    });
    expect(await hasVoiceSession(redis, guildId, memberC.id)).toBe(false);
    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(true);
    expect(await hasVoiceSession(redis, guildId, memberB.id)).toBe(true);
  });

  it('pays time from the previous channel and starts no session after a move into an ignored channel', async () => {
    const guildId = 'g-voice-move-ignored-20261113';
    const openId = 'voice-move-open-20261113';
    const ignoredId = 'voice-move-ignored-20261113';
    const memberA = buildMember('user-voice-move-a-20261113');
    const memberB = buildMember('user-voice-move-b-20261113');
    const memberD = buildMember('user-voice-move-d-20261113');
    const openChannel = buildChannel(openId, [memberA, memberB]);
    const ignoredChannel = buildChannel(ignoredId, [memberD]);
    const guild = buildGuild(guildId, [openChannel, ignoredChannel]);
    const { ctx, prismaCalls, redis } = buildContext(guildId, { ignoredChannelIds: [ignoredId] });

    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, null),
      voiceState(guild, memberA, openId),
    );
    await rewindSession(redis, guildId, memberA.id, 2);

    openChannel.members.delete(memberA.id);
    ignoredChannel.members.set(memberA.id, memberA);
    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, openId),
      voiceState(guild, memberA, ignoredId),
    );

    expect(levelUpserts(prismaCalls)).toHaveLength(1);
    expect(levelUpserts(prismaCalls)[0]?.args[0]).toMatchObject({
      create: { guildId, userId: memberA.id, xp: 2 * VOICE_XP_PER_MINUTE, voiceMinutes: 2 },
    });
    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(false);
    expect(await hasVoiceSession(redis, guildId, memberD.id)).toBe(false);
  });

  it('starts a session again after a member loses an ignored role in a channel that still qualifies', async () => {
    const guildId = 'g-voice-role-restored-20261113';
    const channelId = 'voice-role-restored-20261113';
    const ignoredRoleId = 'role-restored-20261113';
    const memberA = buildMember('user-voice-restored-a-20261113');
    const memberB = buildMember('user-voice-restored-b-20261113');
    const memberC = buildMember('user-voice-restored-c-20261113', [ignoredRoleId]);
    const channel = buildChannel(channelId, [memberA, memberB, memberC]);
    const guild = buildGuild(guildId, [channel]);
    const { ctx, redis } = buildContext(guildId, { ignoredRoleIds: [ignoredRoleId] });

    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, null),
      voiceState(guild, memberA, channelId),
    );
    expect(await hasVoiceSession(redis, guildId, memberC.id)).toBe(false);

    memberC.roles.cache.delete(ignoredRoleId);
    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberB, channelId),
      voiceState(guild, memberB, channelId),
    );

    expect(await hasVoiceSession(redis, guildId, memberC.id)).toBe(true);
    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(true);
    expect(await hasVoiceSession(redis, guildId, memberB.id)).toBe(true);
  });

  it('starts a session after moving from an ignored channel into a qualifying one', async () => {
    const guildId = 'g-voice-leave-ignored-20261113';
    const ignoredId = 'voice-leave-ignored-20261113';
    const openId = 'voice-leave-open-20261113';
    const memberA = buildMember('user-voice-leave-a-20261113');
    const memberB = buildMember('user-voice-leave-b-20261113');
    const memberD = buildMember('user-voice-leave-d-20261113');
    const ignoredChannel = buildChannel(ignoredId, [memberA, memberD]);
    const openChannel = buildChannel(openId, [memberB]);
    const guild = buildGuild(guildId, [ignoredChannel, openChannel]);
    const { ctx, prismaCalls, redis } = buildContext(guildId, { ignoredChannelIds: [ignoredId] });

    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, null),
      voiceState(guild, memberA, ignoredId),
    );
    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(false);

    ignoredChannel.members.delete(memberA.id);
    openChannel.members.set(memberA.id, memberA);
    await voiceStateUpdateHandler.handler(
      ctx,
      voiceState(guild, memberA, ignoredId),
      voiceState(guild, memberA, openId),
    );

    expect(levelUpserts(prismaCalls)).toHaveLength(0);
    expect(await hasVoiceSession(redis, guildId, memberA.id)).toBe(true);
    expect(await hasVoiceSession(redis, guildId, memberB.id)).toBe(true);
    expect(await hasVoiceSession(redis, guildId, memberD.id)).toBe(false);
  });
});
