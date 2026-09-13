// Shared "a member just reached a new level" side effects: level-role rewards (stack/replace),
// the level-up announcement (channel/DM/none), and the `level.up` platform event. Used by the
// messageCreate and voiceStateUpdate XP handlers, and by `/level rewards sync`.
import { userMention, type Guild, type GuildMember } from 'discord.js';
import { resolveTextChannel, safeDm, type PluginContext } from '../sdk';
import type { EngagementLevelingConfig } from './manifest';
import { computeLevelRewardPlan } from './service';

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

function renderLevelUpMessage(template: string, userId: string, level: number): string {
  return template.replace(/\{user\}/g, userMention(userId)).replace(/\{level\}/g, String(level));
}

async function applyRoleRewards(
  ctx: PluginContext,
  guildId: string,
  member: GuildMember,
  newLevel: number,
  mode: EngagementLevelingConfig['rewardMode'],
): Promise<void> {
  const rewards = await ctx.prisma.levelReward.findMany({ where: { guildId } });
  if (rewards.length === 0) return;

  const currentRoleIds = [...member.roles.cache.keys()];
  const plan = computeLevelRewardPlan(currentRoleIds, rewards, newLevel, mode);
  if (plan.toAdd.length === 0 && plan.toRemove.length === 0) return;

  try {
    if (plan.toAdd.length > 0)
      await member.roles.add(plan.toAdd, `Pavisie engagement: reached level ${newLevel}`);
    if (plan.toRemove.length > 0)
      await member.roles.remove(plan.toRemove, `Pavisie engagement: level rewards (${mode})`);
  } catch (err) {
    ctx.logger.warn(
      { guildId, userId: member.id, err: err instanceof Error ? err.message : String(err) },
      'engagement: failed to apply level reward roles (likely missing Manage Roles or role hierarchy)',
    );
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

/** Applies every "just leveled up" side effect for one member: role rewards, announcement, and the `level.up` event. */
export async function applyLevelUp(opts: ApplyLevelUpOptions): Promise<void> {
  const { ctx, guildId, userId, newLevel, member, config } = opts;

  if (member) {
    await applyRoleRewards(ctx, guildId, member, newLevel, config.rewardMode);
  }

  await announceLevelUp(ctx, opts);

  ctx.events.emit('level.up', { guildId, userId, level: newLevel });
}
