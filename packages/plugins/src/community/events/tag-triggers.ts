// Tag auto-responders (spec CG-02): reply with a tag when an incoming message matches its trigger phrase.
// Runs only with the Message Content privileged intent *and* the guild's `tags.triggersEnabled` opt-in; the
// message text is compared in memory against the guild's (Redis-cached) trigger list and never stored.
import type { Message } from 'discord.js';
import type { PluginEventHandler } from '../../sdk';
import type { CommunityConfig } from '../manifest';
import { loadTriggerTags } from '../tag-cache';
import { matchesTrigger, renderTag, tagTemplateVars, tagTriggerCooldownKey } from '../tags';

export const tagTriggersHandler: PluginEventHandler<'messageCreate'> = {
  event: 'messageCreate',
  guildIdOf: (message: Message) => message.guildId,
  async handler(ctx, message) {
    if (!message.inGuild()) return;
    if (message.author.bot || message.webhookId || message.system) return;
    if (!ctx.intentsEnabled.messageContent) return;

    const config = await ctx.getConfig<CommunityConfig>(message.guildId);
    if (!config.tags.enabled || !config.tags.triggersEnabled) return;

    // Fast path: cached trigger list; an empty list returns without touching the database.
    const triggers = await loadTriggerTags(ctx, message.guildId);
    if (triggers.length === 0) return;

    const match = triggers.find(
      (tag) =>
        (tag.triggerChannelIds.length === 0 || tag.triggerChannelIds.includes(message.channelId)) &&
        matchesTrigger(message.content, tag),
    );
    if (!match) return;

    try {
      // One reply per (guild, tag) per cooldown window.
      const acquired = await ctx.redis.set(
        tagTriggerCooldownKey(message.guildId, match.id),
        '1',
        'EX',
        config.tags.triggerCooldownSeconds,
        'NX',
      );
      if (acquired !== 'OK') return;

      const tag = await ctx.prisma.tag.findUnique({ where: { id: match.id } });
      if (!tag) return;
      // Defense-in-depth: staff-only tags must never auto-respond publicly, even if a stale/bad cache entry
      // slipped past the loader's `staffOnly: false` filter (`../tag-cache.ts`).
      if (tag.staffOnly) return;

      const rendered = renderTag(tag, tagTemplateVars(message.author, message.guild), message.author.id);
      await message.reply(rendered);
      await ctx.prisma.tag.update({ where: { id: tag.id }, data: { uses: { increment: 1 } } });
    } catch (err) {
      // No message content in logs — only the tag id and the error.
      ctx.logger.warn({ guildId: message.guildId, tagId: match.id, err }, 'tag auto-responder failed');
    }
  },
};
