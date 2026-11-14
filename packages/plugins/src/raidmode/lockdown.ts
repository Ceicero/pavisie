// Lockdown and exact restore.
//
// A lockdown denies a few "post something" permissions to @everyone, channel by channel. Before each change it
// saves that overwrite's previous state for exactly those flags (allowed / denied / not set), plus whether the
// overwrite existed at all. Restore puts each flag back to that saved state, and deletes the overwrite again if
// the lockdown created it and nothing else was added since. It never touches a flag the lockdown did not change.
//
// If an admin changed one of those flags on a channel during the raid, restore leaves that channel alone and
// reports it, so it never undoes a human's decision. Same for the verification level and paused invites.
import {
  ChannelType,
  GuildVerificationLevel,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type PermissionOverwrites,
  type TextChannel,
} from 'discord.js';
import type { Prisma, RaidModeLockdownChange } from '@pavisie/database';
import type { PluginContext } from '../sdk';
import type { RaidModeConfig } from './manifest';

/** The flags a lockdown denies to @everyone. Nothing else is ever changed. */
export const LOCK_FLAGS = [
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'AddReactions',
] as const;
export type LockFlag = (typeof LOCK_FLAGS)[number];
/** true = explicitly allowed, false = explicitly denied, null = not set (inherits). */
export type FlagStates = Record<LockFlag, boolean | null>;

/** At most this many channels per lockdown, to stay well inside Discord's rate limits. */
export const MAX_LOCKDOWN_CHANNELS = 100;

/** What the bot needs on a channel to change its overwrites. */
const OVERWRITE_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageRoles] as const;

export function flagStatesOf(
  overwrite: Pick<PermissionOverwrites, 'allow' | 'deny'> | undefined,
): FlagStates {
  const states = {} as FlagStates;
  for (const flag of LOCK_FLAGS) {
    const bit = PermissionFlagsBits[flag];
    states[flag] = overwrite?.allow.has(bit) ? true : overwrite?.deny.has(bit) ? false : null;
  }
  return states;
}

/** True when every lock flag is already denied: locking would change nothing, so the channel is left out. */
export function alreadyLocked(states: FlagStates): boolean {
  return LOCK_FLAGS.every((flag) => states[flag] === false);
}

/** True when the channel still shows exactly what the lockdown set; false means someone changed it since. */
export function stillAsLocked(states: FlagStates): boolean {
  return alreadyLocked(states);
}

/** Parses a stored `previousFlags` value; anything malformed reads as "not set", the safest restore. */
export function parseFlagStates(value: Prisma.JsonValue | null): FlagStates {
  const states = {} as FlagStates;
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const flag of LOCK_FLAGS) {
    const v = (record as Record<string, unknown>)[flag];
    states[flag] = v === true ? true : v === false ? false : null;
  }
  return states;
}

type OverwriteChannel = TextChannel;

function lockableChannel(
  guild: Guild,
  channel: GuildBasedChannel | null | undefined,
): OverwriteChannel | null {
  if (!channel || channel.isThread() || !channel.isTextBased()) return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return null;
  const me = guild.members.me;
  if (!me || !channel.permissionsFor(me)?.has(OVERWRITE_PERMISSIONS)) return null;
  return channel as OverwriteChannel;
}

/** The channels a lockdown would close: the configured list, or every text channel the bot can manage. */
export function lockdownTargets(guild: Guild, config: RaidModeConfig): OverwriteChannel[] {
  const ids =
    config.lockdownChannelIds.length > 0
      ? config.lockdownChannelIds
      : [...guild.channels.cache.values()].map((c) => c.id);
  const targets: OverwriteChannel[] = [];
  for (const id of ids) {
    if (id === config.alertChannelId) continue; // staff keep their alert channel
    const channel = lockableChannel(guild, guild.channels.cache.get(id));
    if (channel) targets.push(channel);
    if (targets.length >= MAX_LOCKDOWN_CHANNELS) break;
  }
  return targets;
}

export interface LockdownResult {
  actions: string[];
  channelsLocked: number;
  channelsAlreadyClosed: number;
  failures: number;
  verificationRaised: boolean;
  invitesPaused: boolean;
}

/**
 * Applies the lockdown. Each change is saved *before* it is made, so a crash between the two leaves a row restore
 * can act on (restore checks the channel's actual state first, so a row for a change that never landed is
 * harmless). A change Discord refuses is removed again.
 */
export async function applyLockdown(
  ctx: PluginContext,
  guild: Guild,
  config: RaidModeConfig,
  incidentId: string,
  reason: string,
): Promise<LockdownResult> {
  const result: LockdownResult = {
    actions: [],
    channelsLocked: 0,
    channelsAlreadyClosed: 0,
    failures: 0,
    verificationRaised: false,
    invitesPaused: false,
  };
  const everyone = guild.roles.everyone;

  for (const channel of lockdownTargets(guild, config)) {
    const existing = channel.permissionOverwrites.cache.get(everyone.id);
    const previous = flagStatesOf(existing);
    if (alreadyLocked(previous)) {
      result.channelsAlreadyClosed += 1;
      continue;
    }
    const row = await ctx.prisma.raidModeLockdownChange.create({
      data: {
        incidentId,
        guildId: guild.id,
        kind: 'CHANNEL_OVERWRITE',
        channelId: channel.id,
        targetId: everyone.id,
        previousFlags: previous,
        previousOverwriteExisted: Boolean(existing),
      },
    });
    try {
      const deny = Object.fromEntries(LOCK_FLAGS.map((flag) => [flag, false]));
      await channel.permissionOverwrites.edit(everyone, deny, { reason });
      result.channelsLocked += 1;
    } catch (err) {
      result.failures += 1;
      await ctx.prisma.raidModeLockdownChange.delete({ where: { id: row.id } }).catch(() => undefined);
      ctx.logger.warn(
        { guildId: guild.id, channelId: channel.id, err: err instanceof Error ? err.message : String(err) },
        'raidmode: could not lock a channel',
      );
    }
  }
  if (result.channelsLocked > 0) result.actions.push('channel-send-deny');

  const canManageGuild = guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (config.raiseVerification && canManageGuild && guild.verificationLevel < GuildVerificationLevel.High) {
    const row = await ctx.prisma.raidModeLockdownChange.create({
      data: {
        incidentId,
        guildId: guild.id,
        kind: 'VERIFICATION_LEVEL',
        previousVerificationLevel: guild.verificationLevel,
        appliedVerificationLevel: GuildVerificationLevel.High,
      },
    });
    try {
      await guild.setVerificationLevel(GuildVerificationLevel.High, reason);
      result.verificationRaised = true;
      result.actions.push('raise-verification');
    } catch (err) {
      result.failures += 1;
      await ctx.prisma.raidModeLockdownChange.delete({ where: { id: row.id } }).catch(() => undefined);
      ctx.logger.warn(
        { guildId: guild.id, err: err instanceof Error ? err.message : String(err) },
        'raidmode: could not raise the verification level',
      );
    }
  }
  if (config.pauseInvites && canManageGuild && !guild.features.includes('INVITES_DISABLED')) {
    const row = await ctx.prisma.raidModeLockdownChange.create({
      data: { incidentId, guildId: guild.id, kind: 'INVITES_PAUSED' },
    });
    try {
      await guild.disableInvites(true);
      result.invitesPaused = true;
      result.actions.push('pause-invites');
    } catch (err) {
      result.failures += 1;
      await ctx.prisma.raidModeLockdownChange.delete({ where: { id: row.id } }).catch(() => undefined);
      ctx.logger.warn(
        { guildId: guild.id, err: err instanceof Error ? err.message : String(err) },
        'raidmode: could not pause invites',
      );
    }
  }
  return result;
}

export type RestoreSkipReason = 'changed_by_admin' | 'channel_deleted';

export interface RestoreResult {
  /** Rows put back; the caller deletes them. */
  restoredIds: string[];
  /** Rows left alone on purpose; the caller keeps them with the reason. */
  skipped: { id: string; channelId: string | null; kind: string; reason: RestoreSkipReason }[];
  /** Rows Discord refused this time; left untouched so pressing Restore again retries them. */
  failedIds: string[];
}

/** Puts back exactly what the given changes recorded, skipping anything a human changed since. */
export async function restoreChanges(
  ctx: PluginContext,
  guild: Guild,
  changes: RaidModeLockdownChange[],
  reason: string,
): Promise<RestoreResult> {
  const result: RestoreResult = { restoredIds: [], skipped: [], failedIds: [] };
  const skip = (change: RaidModeLockdownChange, why: RestoreSkipReason) =>
    result.skipped.push({ id: change.id, channelId: change.channelId, kind: change.kind, reason: why });

  for (const change of changes) {
    try {
      if (change.kind === 'CHANNEL_OVERWRITE') {
        const channel = change.channelId
          ? await guild.channels.fetch(change.channelId).catch(() => null)
          : null;
        if (!channel || !('permissionOverwrites' in channel) || channel.isThread()) {
          skip(change, 'channel_deleted');
          continue;
        }
        const targetId = change.targetId ?? guild.roles.everyone.id;
        const current = channel.permissionOverwrites.cache.get(targetId);
        if (!stillAsLocked(flagStatesOf(current))) {
          skip(change, 'changed_by_admin');
          continue;
        }
        const previous = parseFlagStates(change.previousFlags);
        await channel.permissionOverwrites.edit(targetId, previous, { reason });
        // The lockdown created this overwrite and nothing else lives on it now: remove it, as it was before.
        if (change.previousOverwriteExisted === false) {
          const after = channel.permissionOverwrites.cache.get(targetId);
          if (after && after.allow.bitfield === 0n && after.deny.bitfield === 0n) {
            await channel.permissionOverwrites.delete(targetId, reason);
          }
        }
        result.restoredIds.push(change.id);
      } else if (change.kind === 'VERIFICATION_LEVEL') {
        if (
          change.previousVerificationLevel === null ||
          guild.verificationLevel !== change.appliedVerificationLevel
        ) {
          skip(change, 'changed_by_admin');
          continue;
        }
        await guild.setVerificationLevel(change.previousVerificationLevel, reason);
        result.restoredIds.push(change.id);
      } else {
        if (!guild.features.includes('INVITES_DISABLED')) {
          skip(change, 'changed_by_admin');
          continue;
        }
        await guild.disableInvites(false);
        result.restoredIds.push(change.id);
      }
    } catch (err) {
      result.failedIds.push(change.id);
      ctx.logger.warn(
        { guildId: guild.id, changeId: change.id, err: err instanceof Error ? err.message : String(err) },
        'raidmode: could not restore a lockdown change',
      );
    }
  }
  return result;
}
