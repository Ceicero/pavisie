import type { Message } from 'discord.js';
import type { PluginEventHandler } from '../../sdk';
import type { EngagementConfig } from '../manifest';
import { applyLevelUp } from '../level-actions';
import { isXpIgnored, levelFromXp, tryAwardMessageXp } from '../service';

/** Parent channel of a thread or forum post; null for an ordinary channel or an orphaned thread. */
function threadParentChannelId(message: Message): string | null {
  const channel = message.channel;
  if (channel?.isThread()) return channel.parentId;
  return null;
}

/**
 * Awards message XP (no message content ever read — only that an eligible, non-bot, non-ignored
 * message was sent) subject to the per-user cooldown and rolling-hour cap, then handles a level-up
 * if the resulting total XP crosses into a new level (SPEC.md §G "anti-farming controls").
 */
export const messageCreateHandler: PluginEventHandler<'messageCreate'> = {
  event: 'messageCreate',
  guildIdOf: (message) => message.guild?.id ?? null,
  async handler(ctx, message: Message) {
    // A system message (join/boost/pin notice) carries the real member as `author` with `bot: false`, so
    // without these filters simply joining or boosting the server earns XP. Matches the guards in
    // community/events/{tag-triggers,sticky}.ts.
    if (!message.guild || message.author.bot || message.webhookId || message.system) return;

    const config = await ctx.getConfig<EngagementConfig>(message.guild.id);
    if (!config.leveling.enabled) return;

    const member = message.member;
    // A thread or forum post has its own channel id, so the parent's no-XP entry has to be checked too.
    // A missing member cache skips the role list, matching the previous guard (uncached authors still earn).
    if (
      isXpIgnored(config.leveling, {
        channelId: message.channelId,
        parentChannelId: threadParentChannelId(message),
        roleIds: member ? [...member.roles.cache.keys()] : [],
      })
    ) {
      return;
    }

    const result = await tryAwardMessageXp(ctx.redis, message.guild.id, message.author.id, config.leveling);
    if (!result.awarded) return;

    const guildId = message.guild.id;
    const userId = message.author.id;

    const profile = await ctx.prisma.levelProfile.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId, xp: result.xpGained, messages: 1, lastXpAt: new Date() },
      update: { xp: { increment: result.xpGained }, messages: { increment: 1 }, lastXpAt: new Date() },
    });

    const newLevel = levelFromXp(profile.xp);
    if (newLevel <= profile.level) return;

    await ctx.prisma.levelProfile.update({ where: { id: profile.id }, data: { level: newLevel } });
    await applyLevelUp({
      ctx,
      guild: message.guild,
      member,
      guildId,
      userId,
      newLevel,
      config: config.leveling,
      sourceChannelId: message.channelId,
    });
  },
};
