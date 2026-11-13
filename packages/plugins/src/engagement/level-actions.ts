// Shared level side effects. Role rewards are recomputed for a member's current level whenever that
// level changes (up or down). The announcement and the `level.up` platform event stay level-up only.
// Used by the messageCreate and voiceStateUpdate XP handlers, `/level xp`, `/level reset`,
// `/level rewards sync`, and the reward-reconcile job.
import { userMention, type Guild, type GuildMember } from 'discord.js';
import { resolveTextChannel, safeDm, type PluginContext } from '../sdk';
import type { EngagementLevelingConfig } from './manifest';
import { computeLevelRewardPlan, type RewardDef } from './service';

/** Most members one reward-role pass will write roles for (`/level rewards sync`, `/level reset`, one job tick). */
export const REWARD_ROLE_SYNC_LIMIT = 500;

export interface ApplyLevelUpOptions {
  ctx: PluginContext;
  guild: Guild;
  /** `null` when the member isn't resolvable (left the guild, or not cached) — role rewards are skipped, but the announcement/event still fire. */
  member: GuildMember | null;
  guildId: string;
  userId: string;
  newLevel: number;
  config: EngagementLevelingConfig;
  /** The channel the triggering activity happened in, used when `config.levelUpChannel === 'current'`. */
  sourceChannelId?: string;
}

export interface SyncMemberRewardRolesOptions {
  ctx: PluginContext;
  guildId: string;
  member: GuildMember;
  /** The level the member should be rewarded for. `0` strips every reward role (a reset, or a deleted profile). */
  level: number;
  mode: EngagementLevelingConfig['rewardMode'];
  /** Preloaded guild rewards. When omitted, the rows are read for `guildId`. */
  rewards?: readonly RewardDef[];
  addReason?: string;
  removeReason?: string;
}

function renderLevelUpMessage(template: string, userId: string, level: number): string {
  return template.replace(/\{user\}/g, userMention(userId)).replace(/\{level\}/g, String(level));
}

/**
 * Reward roles the member currently holds but should not, at `level`.
 * `computeLevelRewardPlan` never removes in `'stack'` mode, and in `'replace'` mode it removes nothing
 * once the member is below every reward. A level drop still has to take those roles away: stack keeps
 * every reward at or below the new level, replace keeps only the highest one (or none).
 */
function rewardRolesToRemove(
  currentRoleIds: string[],
  rewards: readonly RewardDef[],
  level: number,
  mode: EngagementLevelingConfig['rewardMode'],
  planToRemove: readonly string[],
): string[] {
  const rewardRoleIds = new Set(rewards.map((reward) => reward.roleId));
  if (mode === 'replace' && rewards.some((reward) => reward.level <= level)) {
    return [...planToRemove];
  }
  if (mode === 'replace') {
    return [...new Set(currentRoleIds.filter((id) => rewardRoleIds.has(id)))];
  }
  const stillEarned = new Set(
    rewards.filter((reward) => reward.level <= level).map((reward) => reward.roleId),
  );
  return [...new Set(currentRoleIds.filter((id) => rewardRoleIds.has(id) && !stillEarned.has(id)))];
}

/**
 * Recomputes one member's level-reward roles for `level` and applies the diff.
 * Returns whether a role write was attempted. Failures are logged, not thrown — a missing Manage Roles
 * permission must not block the XP write, the announcement, or the rest of a sync.
 */
export async function syncMemberRewardRoles(opts: SyncMemberRewardRolesOptions): Promise<boolean> {
  const rewards =
    opts.rewards ?? (await opts.ctx.prisma.levelReward.findMany({ where: { guildId: opts.guildId } }));
  if (rewards.length === 0) return false;

  const currentRoleIds = [...opts.member.roles.cache.keys()];
  const plan = computeLevelRewardPlan(currentRoleIds, [...rewards], opts.level, opts.mode);
  const toAdd = plan.toAdd;
  const toRemove = rewardRolesToRemove(currentRoleIds, rewards, opts.level, opts.mode, plan.toRemove);
  if (toAdd.length === 0 && toRemove.length === 0) return false;

  const addReason = opts.addReason ?? `Pavisie engagement: reached level ${opts.level}`;
  const removeReason = opts.removeReason ?? `Pavisie engagement: level rewards (${opts.mode})`;

  try {
    if (toAdd.length > 0) await opts.member.roles.add(toAdd, addReason);
    if (toRemove.length > 0) await opts.member.roles.remove(toRemove, removeReason);
    return true;
  } catch (err) {
    opts.ctx.logger.warn(
      {
        guildId: opts.guildId,
        userId: opts.member.id,
        err: err instanceof Error ? err.message : String(err),
      },
      'engagement: failed to apply level reward roles (likely missing Manage Roles or role hierarchy)',
    );
    return false;
  }
}

async function announceLevelUp(ctx: PluginContext, opts: ApplyLevelUpOptions): Promise<void> {
  const { guild, member, config, userId, newLevel, sourceChannelId } = opts;
  if (config.levelUpChannel === 'none') return;

  const text = renderLevelUpMessage(config.levelUpMessage, userId, newLevel);

  if (config.levelUpChannel === 'dm') {
    if (member) await safeDm(member.user, text);
    return;
  }

  const channelId = config.levelUpChannel === 'current' ? sourceChannelId : config.levelUpChannel;
  if (!channelId) return;

  const channel = await resolveTextChannel(guild, channelId);
  if (!channel) return;
  await channel.send({ content: text }).catch(() => undefined);
}

/** Level-up only: reward roles for the new level, then the announcement and the `level.up` event. */
export async function applyLevelUp(opts: ApplyLevelUpOptions): Promise<void> {
  const { ctx, guildId, userId, newLevel, member, config } = opts;

  if (member) {
    await syncMemberRewardRoles({
      ctx,
      guildId,
      member,
      level: newLevel,
      mode: config.rewardMode,
    });
  }

  await announceLevelUp(ctx, opts);

  ctx.events.emit('level.up', { guildId, userId, level: newLevel });
}
