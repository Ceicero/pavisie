/** Main entry point for prefix-command handling. */
import type { Message } from 'discord.js';
import type { Logger } from 'pino';
import { errorEmbed } from '@entrophy/plugins';
import type { LoadedHost } from '../loader';
import { routeInteraction } from '../router';
import { parsePrefixMessage, isBarePrefix } from './parse';
import { resolvePrefixOptions } from './options';
import { createMessageCommandInteraction } from './message-command-interaction';

/**
 * Bounded startup sampling. The prefix router is deliberately silent on input it does not own, which makes a
 * non-working `+` indistinguishable from a message the bot never received. Logging the first few messages the
 * listener actually sees — with their content length — separates those two cases: no lines at all means
 * messageCreate never fires, while `contentLength: 0` means the gateway is delivering messages with the content
 * stripped (the MessageContent intent is not really in effect).
 */
let sampledMessages = 0;
const SAMPLE_LIMIT = 5;

// Rate limiter for bare prefix (DEFECT 6: once per 60 seconds per channel)
const barePrefix60sRateLimits = new Map<string, number>();

/** Prunes rate limit entries older than 60s to prevent unbounded growth */
function pruneBarePrefix60sRateLimits(): void {
  const now = Date.now();
  const toDelete: string[] = [];
  for (const [channelId, timestamp] of barePrefix60sRateLimits.entries()) {
    if (now - timestamp > 60_000) {
      toDelete.push(channelId);
    }
  }
  toDelete.forEach((channelId) => barePrefix60sRateLimits.delete(channelId));
}

/** Checks if bare prefix is rate-limited in this channel */
function isBarePrefix60sRateLimited(channelId: string): boolean {
  const lastFired = barePrefix60sRateLimits.get(channelId);
  if (!lastFired) return false;
  return Date.now() - lastFired < 60_000;
}

/** Records that bare prefix fired in this channel */
function recordBarePrefix60sFiring(channelId: string): void {
  barePrefix60sRateLimits.set(channelId, Date.now());
  // Prune if map is getting too large
  if (barePrefix60sRateLimits.size > 1000) {
    pruneBarePrefix60sRateLimits();
  }
}

/**
 * Handles a message-based prefix command (e.g. `+mod ban @user spam`).
 *
 * This is the entry point called by the `messageCreate` listener in `apps/bot/src/index.ts`.
 * It parses the message, resolves options, builds a fake interaction, and routes it through
 * the standard pipeline (routeInteraction) so that all existing permission checks, rate limiting,
 * cooldowns, and handlers apply uniformly to both slash and prefix commands.
 *
 * Special cases:
 * - Bare prefix (e.g. just `+`) triggers the help command (DEFECT 6).
 *   Rate-limited to once per 60 seconds per channel to avoid chat spam.
 *
 * Fails silently (returns without replying) for:
 * - Messages from bots, webhooks, or system messages
 * - DMs (not in a guild)
 * - Messages that don't parse as a prefix command
 * - Unknown command names (so we don't pollute channels used by other bots)
 * - Context-menu-only commands (can't be invoked via prefix)
 * - Channels where the bot has no SendMessages permission
 * - Bare prefix when rate-limited
 *
 * Replies with an error embed for:
 * - Bad arguments (missing required option, validation failure)
 */
export async function handleMessageCommand(
  message: Message,
  host: LoadedHost,
  logger: Logger,
  prefix: string,
): Promise<void> {
  // Skip bots, webhooks, system messages
  if (message.author.bot || message.webhookId || message.system) {
    return;
  }

  // Skip DMs
  if (!message.inGuild()) {
    return;
  }

  const looksLikeCommand = message.content.startsWith(prefix);

  if (sampledMessages < SAMPLE_LIMIT) {
    sampledMessages += 1;
    logger.info(
      {
        contentLength: message.content.length,
        looksLikeCommand,
        prefix,
        guildId: message.guildId,
        channelId: message.channelId,
      },
      'prefix: sampling an incoming message',
    );
  }

  /**
   * Records why a prefix-looking message was dropped. Only fires for messages that actually start with the
   * prefix, so ordinary chat never reaches the log. Users still see nothing — this changes logging only.
   */
  const bail = (reason: string, extra: Record<string, unknown> = {}): void => {
    if (!looksLikeCommand) return;
    logger.info(
      { reason, guildId: message.guildId, channelId: message.channelId, ...extra },
      'prefix: dropped a message that started with the prefix',
    );
  };

  // Check bot permissions early
  const botMember = message.guild.members.me;
  if (!botMember) {
    bail('bot member not cached');
    return;
  }

  // Bot must be able to view the channel and send messages
  const channel = message.channel;
  if (!channel || !('guild' in channel)) {
    bail('channel is not a guild channel');
    return;
  }

  const canView = botMember.permissionsIn(channel).has('ViewChannel');
  const canSend = botMember.permissionsIn(channel).has('SendMessages');
  if (!canView || !canSend) {
    // Genuinely cannot reply here, so the user still sees nothing — but say so in the log, because this is
    // the one failure mode that looks exactly like "the bot ignored me" while slash commands keep working
    // (an interaction reply goes back through Discord's webhook and does not need SendMessages).
    bail('missing channel permissions', { canView, canSend });
    return;
  }

  // DEFECT 6: Handle bare prefix (just `+`) to trigger help
  if (isBarePrefix(message.content, prefix)) {
    // Check rate limit
    if (isBarePrefix60sRateLimited(message.channelId)) {
      // Silent: just don't reply
      return;
    }

    // Look up help command
    const helpEntry = host.commands.get('help');
    if (!helpEntry) {
      // No help command registered, fail silently
      return;
    }

    const { command: helpCommand } = helpEntry;
    const helpCommandJson = helpCommand.data.toJSON();

    // Skip if help is a context menu (unlikely, but safe-check)
    if (helpCommandJson.type === 2 || helpCommandJson.type === 3) {
      return;
    }

    // Record this firing for rate limiting
    recordBarePrefix60sFiring(message.channelId);

    // Resolve options for help command (should have zero args usually)
    const optionsResult = await resolvePrefixOptions(helpCommandJson, [], message, 'help');
    if (!optionsResult.ok) {
      // Shouldn't happen for help with no args, but handle it gracefully
      try {
        await message.reply({
          embeds: [
            errorEmbed(`Unable to invoke help:\n${optionsResult.error}\nUsage: \`${optionsResult.usage}\``),
          ],
          allowedMentions: { repliedUser: false },
        });
      } catch (err) {
        logger.error({ err, guildId: message.guildId, channelId: message.channelId },
          'prefix: failed to send help error reply');
      }
      return;
    }

    // Build fake interaction and route it
    const fakeInteraction = createMessageCommandInteraction({
      message: message as Message<true>,
      commandName: 'help',
      resolved: optionsResult.resolved,
    });

    try {
      await routeInteraction(fakeInteraction, host, logger);
    } catch (err) {
      logger.error(
        { err, guildId: message.guildId, command: 'help' },
        'prefix: unhandled error while routing bare prefix help',
      );
    }
    return;
  }

  // Parse the message
  const parsed = parsePrefixMessage(message.content, prefix);
  if (!parsed) {
    bail('did not parse as a prefix command');
    return;
  }

  // Look up the command
  const entry = host.commands.get(parsed.name);
  if (!entry) {
    // Unknown command: don't reply (other bots may use this prefix too)
    bail('no such command', { name: parsed.name });
    return;
  }

  const { command } = entry;

  // Skip context-menu commands (they can't be invoked via prefix)
  const commandJson = command.data.toJSON();
  if (commandJson.type === 2 || commandJson.type === 3) {
    // type 2 = USER, type 3 = MESSAGE (context menus)
    return;
  }

  // Resolve options (DEFECT 5: pass command name and prefix)
  const optionsResult = await resolvePrefixOptions(commandJson, parsed.tokens, message, parsed.name);
  if (!optionsResult.ok) {
    // Bad arguments: reply with error and usage (DEFECT 5)
    try {
      await message.reply({
        embeds: [
          errorEmbed(
            `${optionsResult.error}\n\nUsage: \`${prefix}${optionsResult.usage}\``,
          ),
        ],
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      logger.error({ err, guildId: message.guildId, channelId: message.channelId },
        'prefix: failed to send error reply');
    }
    return;
  }

  // Build fake interaction and route it
  const fakeInteraction = createMessageCommandInteraction({
    message: message as Message<true>,
    commandName: parsed.name,
    resolved: optionsResult.resolved,
  });

  try {
    await routeInteraction(fakeInteraction, host, logger);
  } catch (err) {
    logger.error(
      { err, guildId: message.guildId, command: parsed.name },
      'prefix: unhandled error while routing interaction',
    );
  }
}
