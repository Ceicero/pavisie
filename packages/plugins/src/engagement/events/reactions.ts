import { EMBED_LIMITS, truncate } from '@pavisie/core';
import type { Message, MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { brandEmbed, resolveTextChannel, type PluginContext, type PluginEventHandler } from '../../sdk';
import type { EngagementConfig, EngagementStarboardConfig } from '../manifest';
import { CUSTOM_EMOJI_PATTERN, countEligibleReactors, decideStarboardAction } from '../service';

/** True if the reaction's emoji matches the configured starboard emoji (unicode, or `<a?:name:id>` for a custom emoji). */
function emojiMatches(
  configuredEmoji: string,
  reactionEmoji: { name: string | null; id: string | null },
): boolean {
  const customMatch = CUSTOM_EMOJI_PATTERN.exec(configuredEmoji);
  if (customMatch) {
    return reactionEmoji.id === customMatch[2];
  }
  return reactionEmoji.name === configuredEmoji;
}

function buildStarboardEmbed(
  message: Message,
  count: number,
  starboard: EngagementStarboardConfig,
  messageContentEnabled: boolean,
) {
  const embed = brandEmbed()
    .setAuthor({
      name: message.author.tag ?? message.author.username,
      iconURL: message.author.displayAvatarURL(),
    })
    .addFields({
      name: `${starboard.emoji} ${count}`,
      value: `[Jump to message](${message.url}) in <#${message.channelId}>`,
    });

  if (messageContentEnabled && message.content) {
    embed.setDescription(truncate(message.content, EMBED_LIMITS.description));
  }

  const firstImage = message.attachments.find((a) => (a.contentType ?? '').startsWith('image/'));
  if (firstImage) {
    embed.setImage(firstImage.url);
  } else if (message.attachments.size > 0) {
    embed.addFields({ name: 'Attachments', value: String(message.attachments.size), inline: true });
  }

  return embed;
}

async function resolveFullReaction(
  reaction: MessageReaction | PartialMessageReaction,
): Promise<MessageReaction | null> {
  if (!reaction.partial) return reaction;
  try {
    return await reaction.fetch();
  } catch {
    return null;
  }
}

async function resolveFullMessage(reaction: MessageReaction): Promise<Message | null> {
  if (!reaction.message.partial) return reaction.message as Message;
  try {
    return await reaction.message.fetch();
  } catch {
    return null;
  }
}

async function handleReactionChange(
  ctx: PluginContext,
  guildId: string,
  rawReaction: MessageReaction | PartialMessageReaction,
): Promise<void> {
  const config = await ctx.getConfig<EngagementConfig>(guildId);
  const starboard = config.starboard;
  if (!starboard.channelId) return;

  const reaction = await resolveFullReaction(rawReaction);
  if (!reaction) return;
  if (!emojiMatches(starboard.emoji, reaction.emoji)) return;

  const message = await resolveFullMessage(reaction);
  if (!message || !message.guild || message.author.bot) return;
  if (message.channelId === starboard.channelId) return; // never star the starboard channel itself

  const channel = message.channel;
  if ('nsfw' in channel && channel.nsfw && !starboard.allowNsfw) return;

  let reactorIds: string[];
  try {
    const users = await reaction.users.fetch();
    reactorIds = [...users.values()].filter((u) => !u.bot).map((u) => u.id);
  } catch {
    return;
  }

  const authorId = message.author.id;
  const eligibleCount = countEligibleReactors(reactorIds, authorId, starboard.ignoreSelfStar);

  const existing = await ctx.prisma.starboardEntry.findUnique({ where: { sourceMessageId: message.id } });
  const action = decideStarboardAction(
    Boolean(existing?.starboardMessageId),
    existing?.starCount ?? 0,
    eligibleCount,
    starboard.threshold,
  );

  if (action === 'none') {
    if (existing && existing.starCount !== eligibleCount) {
      await ctx.prisma.starboardEntry.update({
        where: { id: existing.id },
        data: { starCount: eligibleCount },
      });
    }
    return;
  }

  const starChannel = await resolveTextChannel(message.guild, starboard.channelId);

  if (action === 'remove') {
    if (starChannel && existing?.starboardMessageId) {
      await starChannel.messages.delete(existing.starboardMessageId).catch(() => undefined);
    }
    if (existing) {
      await ctx.prisma.starboardEntry.update({
        where: { id: existing.id },
        data: { starCount: eligibleCount, starboardMessageId: null },
      });
    } else {
      await ctx.prisma.starboardEntry.create({
        data: {
          guildId,
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          authorId,
          starCount: eligibleCount,
        },
      });
    }
    return;
  }

  if (!starChannel) return;
  const embed = buildStarboardEmbed(message, eligibleCount, starboard, ctx.intentsEnabled.messageContent);

  if (action === 'post') {
    const posted = await starChannel.send({ embeds: [embed] }).catch(() => null);
    if (!posted) return;
    if (existing) {
      await ctx.prisma.starboardEntry.update({
        where: { id: existing.id },
        data: { starCount: eligibleCount, starboardMessageId: posted.id },
      });
    } else {
      await ctx.prisma.starboardEntry.create({
        data: {
          guildId,
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          authorId,
          starCount: eligibleCount,
          starboardMessageId: posted.id,
        },
      });
    }
    return;
  }

  // action === 'update'
  if (existing?.starboardMessageId) {
    await starChannel.messages.edit(existing.starboardMessageId, { embeds: [embed] }).catch(() => undefined);
    await ctx.prisma.starboardEntry.update({
      where: { id: existing.id },
      data: { starCount: eligibleCount },
    });
  }
}

function guildIdOfReaction(reaction: MessageReaction | PartialMessageReaction): string | null {
  return reaction.message.guildId ?? reaction.message.guild?.id ?? null;
}

export const messageReactionAddHandler: PluginEventHandler<'messageReactionAdd'> = {
  event: 'messageReactionAdd',
  guildIdOf: (reaction) => guildIdOfReaction(reaction),
  async handler(ctx, reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    if (user.bot) return;
    const guildId = guildIdOfReaction(reaction);
    if (!guildId) return;
    await handleReactionChange(ctx, guildId, reaction);
  },
};

export const messageReactionRemoveHandler: PluginEventHandler<'messageReactionRemove'> = {
  event: 'messageReactionRemove',
  guildIdOf: (reaction) => guildIdOfReaction(reaction),
  async handler(ctx, reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    if (user.bot) return;
    const guildId = guildIdOfReaction(reaction);
    if (!guildId) return;
    await handleReactionChange(ctx, guildId, reaction);
  },
};
