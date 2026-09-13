import type { GuildTextBasedChannel, Message } from 'discord.js';
import { RateLimitError, redisKey, truncate } from '@pavisie/core';
import type { PluginContext, PluginEventHandler } from '../../sdk';
import { enforceBudget, enforceCooldown } from '../service';
import { AI_DISCLOSURE, type AiConfig } from '../manifest';
import {
  buildMentionChatPrompt,
  buildMentionChatSystemPrompt,
  type MentionChatHistoryMessage,
} from '../prompt';
import { redact } from '../redact';

/** How many recent messages to pull from the channel before filtering down to `chat.historyMessages` qualifying ones. */
const HISTORY_FETCH_LIMIT = 15;
/** Per-history-message character cap (mirrors `summarize.ts`'s `MAX_CHARS_PER_MESSAGE`). */
const HISTORY_MESSAGE_MAX_CHARS = 500;
/** The live @mention message itself is capped a bit more generously than history lines, but still bounded. */
const LIVE_MESSAGE_MAX_CHARS = 2000;
/** Throttles the "AI is unavailable" fallback reply (not the underlying log) to once per channel per hour. */
const FAILURE_REPLY_TTL_SECONDS = 60 * 60;

function mentionChatFailureWarnedKey(guildId: string, channelId: string): string {
  return redisKey('ai', 'mention-chat', 'failure-warned', guildId, channelId);
}

/** Strips every `<@id>`/`<@!id>` mention of `botId` from `content`, collapsing any whitespace left behind. */
function stripBotMention(content: string, botId: string): string {
  const pattern = new RegExp(`<@!?${botId}>`, 'g');
  return content.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
}

function hasExplicitBotMention(content: string, botId: string): boolean {
  return new RegExp(`<@!?${botId}>`).test(content);
}

function isFetchableChannel(channel: unknown): channel is GuildTextBasedChannel {
  return channel != null && typeof channel === 'object' && 'messages' in channel && 'sendTyping' in channel;
}

/**
 * Short-term context for the reply: the last `limit` messages in the same channel that were sent by either the
 * mentioning user or the bot itself (ARCHITECTURE.md-style scoping — never other members' messages), oldest
 * first, each truncated and redacted the same way `/summarize` treats transcript lines. Best-effort: a fetch
 * failure just means the reply goes out without history rather than failing the whole interaction.
 */
async function fetchMentionChatHistory(
  ctx: PluginContext,
  message: Message<true>,
  botId: string,
  limit: number,
): Promise<MentionChatHistoryMessage[]> {
  if (limit <= 0) return [];
  const channel = message.channel;
  if (!isFetchableChannel(channel)) return [];

  try {
    const fetched = await channel.messages.fetch({ limit: HISTORY_FETCH_LIMIT, before: message.id });
    return [...fetched.values()]
      .filter(
        (m) =>
          !m.system &&
          !m.webhookId &&
          (m.author.id === message.author.id || m.author.id === botId) &&
          m.content.trim().length > 0,
      )
      .slice(0, limit) // fetch() is newest-first, so this keeps the `limit` most recent qualifying messages
      .reverse() // oldest -> newest, for a transcript that reads naturally
      .map((m) => ({
        role: m.author.id === botId ? ('assistant' as const) : ('user' as const),
        content: redact(truncate(m.content, HISTORY_MESSAGE_MAX_CHARS)),
      }));
  } catch (err) {
    ctx.logger.warn(
      {
        guildId: message.guildId,
        channelId: message.channelId,
        err: err instanceof Error ? err.message : String(err),
      },
      'ai: mention-chat failed to fetch recent-message context, continuing without it',
    );
    return [];
  }
}

/**
 * No `reportOnce`-style helper exists yet in `src/ai/**` (unlike `community/events/channel-automations.ts`'s
 * `reportOnce` or `community/sticky.ts`'s `reportStickySendFailure`), so this adapts the same idea locally: log
 * every failure (cheap, server-side only), but only send the in-channel "unavailable" notice once per channel
 * per hour so a broken provider/key doesn't turn an active mention-chat channel into a spam machine.
 */
async function reportMentionChatFailure(
  ctx: PluginContext,
  message: Message<true>,
  err: unknown,
): Promise<void> {
  ctx.logger.warn(
    {
      guildId: message.guildId,
      channelId: message.channelId,
      err: err instanceof Error ? err.message : String(err),
    },
    'ai: mention-chat reply failed',
  );

  const firstThisHour = await ctx.redis.set(
    mentionChatFailureWarnedKey(message.guildId, message.channelId),
    '1',
    'EX',
    FAILURE_REPLY_TTL_SECONDS,
    'NX',
  );
  if (firstThisHour !== 'OK') return;

  try {
    await message.reply({
      content: ctx.t('mentionChat.unavailable'),
      allowedMentions: { repliedUser: true, parse: [] },
    });
  } catch {
    // Best-effort notice — never let the failure-reporting path itself throw.
  }
}

/**
 * "Mention chat" (task spec): members talk to the bot by @mentioning it in one of `chat.channelIds`, with a
 * per-server persona. Hard rule from the owner: only ever responds to an *explicit* @mention — never passively,
 * and never just because a message replies to the bot (a reply can carry `mentions.users.has(botId)` from the
 * reply-ping alone, without the raw content containing `<@botId>`, which is why both are required below).
 */
export const mentionChatHandler: PluginEventHandler<'messageCreate'> = {
  event: 'messageCreate',
  guildIdOf: (message: Message) => message.guildId,
  async handler(ctx, message) {
    if (!message.inGuild()) return;
    if (message.author.bot || message.webhookId || message.system) return;
    // Without Message Content, `message.content` is blank for everyone but the bot itself — there is nothing to
    // read or reply to, so this no-ops entirely rather than replying with an empty prompt. See `health()` in
    // `../index.ts` for the corresponding degraded-health report.
    if (!ctx.intentsEnabled.messageContent) return;

    const config = await ctx.getConfig<AiConfig>(message.guildId);
    if (!config.chat.enabled) return;
    if (!config.chat.channelIds.includes(message.channelId)) return;

    const botId = ctx.client.user.id;
    // `mentions.users.has(botId)` alone is not enough: Discord also marks the replied-to author as "mentioned"
    // when a reply keeps the default ping, even with no `<@botId>` in the raw text. Requiring both means a
    // reply-to-bot with no literal @mention never triggers a response.
    if (!message.mentions.users.has(botId)) return;
    if (!hasExplicitBotMention(message.content, botId)) return;

    const prompt = redact(truncate(stripBotMention(message.content, botId), LIVE_MESSAGE_MAX_CHARS));
    if (prompt.length === 0) {
      await message
        .reply({
          content: ctx.t('mentionChat.emptyPrompt', { mention: `<@${botId}>` }),
          allowedMentions: { repliedUser: true, parse: [] },
        })
        .catch(() => {
          // Best-effort — a failed hint reply isn't worth escalating to the failure-reporting path.
        });
      return;
    }

    const aiService = ctx.services.get('ai');
    if (!aiService) return; // This plugin registers its own `ai` service in `onLoad`; defensive only.

    // Cooldown/budget limits are expected, frequent, and user-triggered (unlike a genuine provider failure) —
    // mention chat just stays quiet rather than replying with a rate-limit notice on every mention during a
    // burst. `/ask`/`/summarize` still surface these as visible errors since those are explicit commands.
    try {
      await enforceCooldown(ctx, message.guildId, message.author.id, config.userCooldownSeconds, ctx.t);
    } catch (err) {
      if (err instanceof RateLimitError) return;
      throw err;
    }
    try {
      await enforceBudget(ctx, message.guildId, message.author.id, config, ctx.t);
    } catch (err) {
      if (err instanceof RateLimitError) return;
      throw err;
    }

    const history = await fetchMentionChatHistory(ctx, message, botId, config.chat.historyMessages);

    let typingTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const channel = message.channel;
      if (isFetchableChannel(channel)) {
        await channel.sendTyping().catch(() => {});
        // Discord's typing indicator lasts ~10s; refresh it while the provider call is in flight.
        typingTimer = setInterval(() => {
          channel.sendTyping().catch(() => {});
        }, 8000);
      }

      const result = await aiService.complete({
        guildId: message.guildId,
        userId: message.author.id,
        command: 'mention-chat',
        prompt: buildMentionChatPrompt(history, prompt),
        system: buildMentionChatSystemPrompt(config.chat.persona),
      });

      // Plain content (not an embed, per the passive/conversational nature of this feature) with the same
      // disclosure every other AI response carries, rendered as Discord subtext so it reads as a footer.
      const disclosureSuffix = `\n-# ${AI_DISCLOSURE}`;
      const budget = Math.max(1, config.chat.maxReplyChars - disclosureSuffix.length);
      const content = `${truncate(result.text, budget)}${disclosureSuffix}`;

      await message.reply({ content, allowedMentions: { repliedUser: true, parse: [] } });
    } catch (err) {
      // Covers both a genuine provider/network failure and `AiUnavailableError` (not configured yet) — deliberately
      // collapsed into one generic notice rather than echoing the specific reason to arbitrary channel members.
      await reportMentionChatFailure(ctx, message, err);
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }
  },
};
