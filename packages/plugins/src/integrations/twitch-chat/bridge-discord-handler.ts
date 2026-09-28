// Discord <-> Twitch chat bridge — the Discord -> Twitch direction's `messageCreate` handler. `guildIdOf` below
// makes the bot host's loader (`apps/bot/src/host/loader.ts`) automatically gate this handler on the
// `integrations` plugin being available+enabled for the guild before ever invoking it; this file does not
// duplicate that check.
import type { PluginEventHandler } from '../../sdk';
import { formatDiscordToTwitch, startsWithAny } from './bridge-format';
import { recordBridgeDrop } from './bridge-metrics';
import { sendChatMessage } from './helix';

/** How long to wait before relaying a Discord message, so automod's independent `messageCreate` handler (which
 * may delete the message) gets a chance to run first. See the long comment below for why this delay-then-recheck
 * fallback is used instead of a synchronous "automod is about to act" signal. */
export const AUTOMOD_GATE_DELAY_MS = 2000;

export const twitchBridgeMessageCreateHandler: PluginEventHandler<'messageCreate'> = {
  event: 'messageCreate',
  guildIdOf: (message) => message.guildId,
  async handler(ctx, message) {
    if (!message.guildId) return;

    // Echo-loop safety (rule 1): must also catch messages sent by our OWN bridge webhook (which carries
    // `webhookId`), as well as any other bot/webhook posting in the channel — never relay a bot/webhook message.
    if (message.author?.bot || message.author?.system || message.webhookId) return;

    const content = message.content ?? '';
    if (content === '' && message.attachments.size === 0 && message.stickers.size === 0) return;

    // Command-skip (rule 3): resolve the bot's own message-prefix the same way the rest of the bot does, and
    // skip anything that looks like a command — including a slash-command-shaped message — even if it doesn't
    // match a real registered command.
    const prefix = (ctx.env.COMMAND_PREFIX as string | undefined) || '+';
    if (startsWithAny(content, [prefix, '/'])) return;

    const bridgeChannel = await ctx.prisma.twitchChatChannel.findFirst({
      where: {
        guildId: message.guildId,
        bridgeDiscordChannelId: message.channelId,
        bridgeDiscordToTwitch: true,
        enabled: true,
      },
    });
    if (!bridgeChannel) return;

    // Automod gating (rule 5): `apps/bot/src/host/loader.ts` dispatches every plugin's `messageCreate` handler
    // as its own independent, unawaited `void (async () => {...})()` task per plugin (verified by reading that
    // file) — there is no ordering guarantee between the `automod` plugin's handler and this one, and no
    // synchronous or even reliably-orderable async signal that "automod is about to act on this message".
    // `automod`'s `handleMessage` (packages/plugins/src/automod/service.ts) interleaves evaluation and side
    // effects per rule with no exported "evaluate only" entry point, and re-running its evaluators here would
    // double-count window-backed rules like message-frequency/duplicate-message tracking — a real correctness
    // bug, not just style. So: wait a fixed delay, then re-check the message still exists, and only relay if it
    // does. This specifically catches automod's `delete` action but NOT `warn`/`timeout`/`quarantine`-only
    // rules that leave the message in place — a known, accepted limitation of this fallback approach (this is
    // the exact fallback the feature's own spec names as acceptable when a synchronous evaluator hook isn't
    // cleanly available).
    await new Promise((resolve) => setTimeout(resolve, AUTOMOD_GATE_DELAY_MS));
    const stillThere = await message.channel.messages
      .fetch(message.id)
      .then(() => true)
      .catch(() => false);
    if (!stillThere) return;

    const displayName = message.member?.displayName ?? message.author.username;
    const userMentions = message.mentions.users.map((u) => ({ id: u.id, name: u.username }));
    const roleMentions = message.mentions.roles.map((r) => ({ id: r.id, name: r.name }));
    const channelMentions = message.mentions.channels.map((c) => ({
      id: c.id,
      name: 'name' in c && c.name ? c.name : 'channel',
    }));
    const hasAttachment = message.attachments.size > 0 || message.stickers.size > 0;

    const formatted = formatDiscordToTwitch({
      displayName,
      content,
      hasAttachment,
      userMentions,
      roleMentions,
      channelMentions,
    });

    const result = await sendChatMessage(ctx, bridgeChannel.broadcasterUserId, formatted);
    if (!result.ok && result.error === 'throttled') {
      recordBridgeDrop(bridgeChannel.id);
    }
    // Any other failure returns silently — matches `sendChatMessage`'s own graceful-degradation contract (it
    // already logs at warn/debug internally).
  },
};
