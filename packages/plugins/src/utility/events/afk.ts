// `messageCreate` handler for `/utility afk`: clears the sender's own AFK status, and replies (at most once per
// mentioned user per 60s, via a Redis dedupe key) when a message mentions someone who is currently AFK.
import { type Message } from 'discord.js';
import { redisKey } from '@pavisie/core';
import { infoEmbed, type PluginContext, type PluginEventHandler } from '../../sdk';
import type { UtilityConfig } from '../manifest';

const MENTION_NOTICE_COOLDOWN_SECONDS = 60;

async function clearOwnAfk(ctx: PluginContext, guildId: string, userId: string): Promise<void> {
  const existing = await ctx.prisma.afkStatus.findUnique({ where: { guildId_userId: { guildId, userId } } });
  if (!existing) return;

  await ctx.prisma.afkStatus.delete({ where: { guildId_userId: { guildId, userId } } });
}

async function notifyAboutAfkMentions(ctx: PluginContext, message: Message<true>): Promise<void> {
  const mentioned = message.mentions.users.filter((user) => !user.bot && user.id !== message.author.id);
  if (mentioned.size === 0) return;

  const lines: string[] = [];
  for (const user of mentioned.values()) {
    const status = await ctx.prisma.afkStatus.findUnique({
      where: { guildId_userId: { guildId: message.guildId, userId: user.id } },
    });
    if (!status) continue;

    const dedupeKey = redisKey('utility', 'afk-notified', message.guildId, user.id);
    const acquired = await ctx.redis.set(dedupeKey, '1', 'EX', MENTION_NOTICE_COOLDOWN_SECONDS, 'NX');
    if (acquired !== 'OK') continue;

    lines.push(
      `<@${user.id}> is AFK${status.message ? `: ${status.message}` : ''} (since <t:${Math.floor(status.since.getTime() / 1000)}:R>)`,
    );
  }

  if (lines.length === 0) return;

  try {
    await message.reply({
      embeds: [infoEmbed('AFK', lines.join('\n'))],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err), guildId: message.guildId },
      'utility: failed to send an AFK mention notice',
    );
  }
}

export const afkMessageHandler: PluginEventHandler<'messageCreate'> = {
  event: 'messageCreate',
  guildIdOf: (message) => message.guildId,
  async handler(ctx, message) {
    if (!message.inGuild() || message.author.bot || message.webhookId) return;

    const config = await ctx.getConfig<UtilityConfig>(message.guildId);
    if (!config.afkEnabled) return;

    await clearOwnAfk(ctx, message.guildId, message.author.id);
    await notifyAboutAfkMentions(ctx, message);
  },
};
