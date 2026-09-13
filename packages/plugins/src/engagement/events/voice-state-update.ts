import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type PermissionsBitField,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import { fetchMemberSafe, type PluginContext, type PluginEventHandler } from '../../sdk';
import type { EngagementConfig, EngagementTempVoiceConfig } from '../manifest';
import { applyLevelUp } from '../level-actions';
import {
  channelQualifiesForVoiceXp,
  hasVoiceSession,
  isEligibleVoiceMember,
  isOrphanTempVoiceChannel,
  levelFromXp,
  renderTempVoiceName,
  startVoiceSession,
  stopVoiceSession,
  voiceXpForMinutes,
  type VoiceMemberLike,
} from '../service';

function toVoiceMemberLike(member: GuildMember): VoiceMemberLike {
  return {
    id: member.id,
    isBot: member.user.bot,
    selfMute: member.voice.selfMute ?? false,
    selfDeaf: member.voice.selfDeaf ?? false,
    serverMute: member.voice.serverMute ?? false,
    serverDeaf: member.voice.serverDeaf ?? false,
  };
}

/** Stops `userId`'s voice-XP session (if any), persists the earned XP/minutes, and handles a level-up. */
async function settleVoiceSession(
  ctx: PluginContext,
  guild: Guild,
  guildId: string,
  userId: string,
  xpPerMinute: number,
): Promise<void> {
  const minutes = await stopVoiceSession(ctx.redis, guildId, userId);
  if (minutes <= 0) return;

  const xpGained = voiceXpForMinutes(minutes, xpPerMinute);
  const profile = await ctx.prisma.levelProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, xp: xpGained, voiceMinutes: minutes },
    update: { xp: { increment: xpGained }, voiceMinutes: { increment: minutes } },
  });

  if (xpGained <= 0) return;
  const newLevel = levelFromXp(profile.xp);
  if (newLevel <= profile.level) return;

  await ctx.prisma.levelProfile.update({ where: { id: profile.id }, data: { level: newLevel } });
  const member = await fetchMemberSafe(guild, userId);
  const config = await ctx.getConfig<EngagementConfig>(guildId);
  await applyLevelUp({ ctx, guild, member, guildId, userId, newLevel, config: config.leveling });
}

/** Starts/stops voice-XP sessions for every member of `channel` so its tracked state matches "does this channel currently qualify, and is each member eligible". */
async function reconcileChannelVoiceXp(
  ctx: PluginContext,
  guild: Guild,
  guildId: string,
  channel: VoiceBasedChannel,
  xpPerMinute: number,
): Promise<void> {
  const members = [...channel.members.values()];
  const qualifies = channelQualifiesForVoiceXp(members.map(toVoiceMemberLike));

  for (const member of members) {
    const eligible = isEligibleVoiceMember(toVoiceMemberLike(member));
    const tracking = await hasVoiceSession(ctx.redis, guildId, member.id);

    if (qualifies && eligible && !tracking) {
      await startVoiceSession(ctx.redis, guildId, member.id);
    } else if ((!qualifies || !eligible) && tracking) {
      await settleVoiceSession(ctx, guild, guildId, member.id, xpPerMinute);
    }
  }
}

// The permissions (beyond Connect) that make the owner feel like they control their own channel. Discord
// rejects a permission overwrite that grants a bit the bot does not itself hold in the guild (50013 Missing
// Permissions) — that used to be requested unconditionally here, so on any guild where the bot was missing one
// of these, the whole `channels.create` call was rejected and temp voice silently did nothing.
const OWNER_OWNERSHIP_PERMISSIONS = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
] as const;

/**
 * Builds the owner's permission overwrite `allow` list from the permissions the bot actually holds in `guild`
 * (`botPermissions`, read from `guild.members.me`) — always `Connect`, plus whichever ownership permissions the
 * bot holds; the rest are silently dropped instead of being requested and rejected. When the bot's own
 * permissions aren't known (not cached), falls back to requesting every ownership permission, matching prior
 * behavior for that edge case.
 */
function buildOwnerAllowList(botPermissions: Readonly<PermissionsBitField> | null): bigint[] {
  const allow: bigint[] = [
    // Connect is explicit because `/tempvoice lock` denies it to @everyone, and only Administrator
    // bypasses a channel Connect denial — ManageChannels does not, so without this the owner locks
    // themselves out of their own channel.
    PermissionFlagsBits.Connect,
  ];
  for (const permission of OWNER_OWNERSHIP_PERMISSIONS) {
    if (!botPermissions || botPermissions.has(permission)) allow.push(permission);
  }
  return allow;
}

/** Creates a fresh temp-voice channel and moves `member` into it when they join a configured hub channel. */
async function createTempVoiceChannel(
  ctx: PluginContext,
  guild: Guild,
  guildId: string,
  hub: VoiceBasedChannel,
  member: GuildMember,
  config: EngagementTempVoiceConfig,
): Promise<void> {
  try {
    // Manage Channels is required to create a channel at all (independent of the owner's overwrite below) — if
    // the bot's own guild permissions are known and it lacks this, every create attempt will fail identically,
    // so say so plainly instead of letting each one fail opaquely into the catch below.
    const botPermissions = guild.members?.me?.permissions ?? null;
    if (botPermissions && !botPermissions.has(PermissionFlagsBits.ManageChannels)) {
      ctx.logger.warn(
        { guildId, hubChannelId: hub.id },
        'engagement: cannot create temp voice channel — the bot is missing the "Manage Channels" permission in this guild. Grant it (Server Settings → Roles, or re-invite the bot) to enable temp voice.',
      );
      return;
    }

    const name = renderTempVoiceName(config.nameTemplate, {
      user: member.displayName || member.user.username,
    });
    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: config.categoryId ?? hub.parentId ?? null,
      ...(config.userLimit > 0 ? { userLimit: config.userLimit } : {}),
      permissionOverwrites: [
        {
          id: member.id,
          allow: buildOwnerAllowList(botPermissions),
        },
      ],
    });

    await ctx.prisma.tempVoiceChannel.create({
      data: { guildId, channelId: created.id, ownerId: member.id, hubChannelId: hub.id },
    });
    await ctx.audit({
      guildId,
      actorId: member.id,
      actorType: 'user',
      action: 'engagement.tempvoice.create',
      targetType: 'channel',
      targetId: created.id,
      source: 'bot',
    });

    await member.voice.setChannel(created.id).catch((err: unknown) => {
      ctx.logger.warn(
        { guildId, channelId: created.id, err: err instanceof Error ? err.message : String(err) },
        'engagement: created temp voice channel but could not move member into it',
      );
    });
  } catch (err) {
    ctx.logger.warn(
      { guildId, hubChannelId: hub.id, err: err instanceof Error ? err.message : String(err) },
      'engagement: failed to create temp voice channel',
    );
  }
}

/** Tears down a temp-voice channel (and its DB row) the moment it becomes empty. The `engagement:tempvoice-sweep` job is the backstop for anything this misses (e.g. a bot restart). */
async function cleanupIfOrphaned(ctx: PluginContext, guild: Guild, channelId: string): Promise<void> {
  const row = await ctx.prisma.tempVoiceChannel.findUnique({ where: { channelId } });
  if (!row) return;

  const channel = guild.channels.cache.get(channelId);
  const memberCount = channel && channel.isVoiceBased() ? channel.members.size : 0;
  if (!isOrphanTempVoiceChannel(memberCount)) return;

  if (channel)
    await channel.delete('Pavisie engagement: temp voice channel is empty').catch(() => undefined);
  await ctx.prisma.tempVoiceChannel.delete({ where: { id: row.id } }).catch(() => undefined);
}

async function handleTempVoice(
  ctx: PluginContext,
  guild: Guild,
  guildId: string,
  oldState: VoiceState,
  newState: VoiceState,
  config: EngagementTempVoiceConfig,
): Promise<void> {
  if (
    newState.channelId &&
    newState.channelId !== oldState.channelId &&
    config.hubChannelIds.includes(newState.channelId)
  ) {
    const hub = newState.channel;
    const member = newState.member;
    if (hub && hub.isVoiceBased() && member) {
      await createTempVoiceChannel(ctx, guild, guildId, hub, member, config);
    }
  }

  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    await cleanupIfOrphaned(ctx, guild, oldState.channelId);
  }
}

/** Leveling voice XP + temp voice channel lifecycle, both driven off the same gateway event (ARCHITECTURE task spec §G). */
export const voiceStateUpdateHandler: PluginEventHandler<'voiceStateUpdate'> = {
  event: 'voiceStateUpdate',
  guildIdOf: (oldState, newState) => newState.guild?.id ?? oldState.guild?.id ?? null,
  async handler(ctx, oldState: VoiceState, newState: VoiceState) {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;
    const guildId = guild.id;
    const userId = newState.id;

    const config = await ctx.getConfig<EngagementConfig>(guildId);

    // A member who left their voice channel entirely won't appear in any channel's live member list below —
    // settle their session directly first so it isn't silently dropped.
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      if (await hasVoiceSession(ctx.redis, guildId, userId)) {
        await settleVoiceSession(ctx, guild, guildId, userId, config.leveling.voiceXpPerMinute);
      }
    }

    await handleTempVoice(ctx, guild, guildId, oldState, newState, config.tempVoice);

    if (config.leveling.enabled && config.leveling.voiceXpPerMinute > 0) {
      const affectedChannelIds = new Set<string>();
      if (oldState.channelId) affectedChannelIds.add(oldState.channelId);
      if (newState.channelId) affectedChannelIds.add(newState.channelId);

      for (const channelId of affectedChannelIds) {
        const channel = guild.channels.cache.get(channelId);
        if (channel && channel.isVoiceBased()) {
          await reconcileChannelVoiceXp(ctx, guild, guildId, channel, config.leveling.voiceXpPerMinute);
        }
      }
    }
  },
};
