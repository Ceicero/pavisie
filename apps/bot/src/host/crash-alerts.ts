import type { Client } from 'discord.js';
import type { Logger } from 'pino';

/** One alert per kind per minute: a rejection fired in a loop must not turn into a Discord message loop. */
const ALERT_COOLDOWN_MS = 60_000;
/** Keeps the alert well under Discord's 2000-character message limit. */
const ALERT_DETAIL_MAX = 1500;

export type CrashKind = 'unhandledRejection' | 'uncaughtException';

export interface CrashAlerterOptions {
  client: Client;
  logger: Logger;
  /** `ALERT_CHANNEL_ID`; alerts are skipped entirely when unset. */
  channelId: string | undefined;
  now?: () => number;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    // Circular or BigInt-bearing rejection reasons can't be stringified as JSON.
    return String(err);
  }
}

/**
 * Posts a short alert to the private `ALERT_CHANNEL_ID` channel when the process hits a crash-level error. Never
 * throws and never logs above warn about itself, so a broken alert channel can't cause the very errors it reports.
 */
export function createCrashAlerter(
  options: CrashAlerterOptions,
): (kind: CrashKind, err: unknown) => Promise<void> {
  const { client, logger, channelId } = options;
  const now = options.now ?? Date.now;
  const lastSentAt = new Map<CrashKind, number>();
  const suppressed = new Map<CrashKind, number>();

  return async (kind, err) => {
    if (!channelId || !client.isReady()) return;

    const sentAt = lastSentAt.get(kind);
    if (sentAt !== undefined && now() - sentAt < ALERT_COOLDOWN_MS) {
      suppressed.set(kind, (suppressed.get(kind) ?? 0) + 1);
      return;
    }
    lastSentAt.set(kind, now());
    const skipped = suppressed.get(kind) ?? 0;
    suppressed.set(kind, 0);

    const detail = describeError(err).slice(0, ALERT_DETAIL_MAX);
    const lines = [
      `**Bot ${kind}** (${client.user.tag})`,
      ...(skipped > 0 ? [`(${skipped} more in the last minute were not posted)`] : []),
      '```',
      detail,
      '```',
    ];
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isSendable()) {
        logger.warn({ channelId }, 'crash alert: ALERT_CHANNEL_ID is not a channel the bot can send to');
        return;
      }
      await channel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
    } catch (sendErr) {
      logger.warn({ channelId, err: sendErr }, 'crash alert: failed to post to ALERT_CHANNEL_ID');
    }
  };
}

/**
 * Logs process-level crashes and Discord client errors, and posts crash alerts. Installed right after the
 * client is built (before login) so a failure anywhere during startup is still caught.
 * `unhandledRejection` stays at error and does not exit. `uncaughtException` logs at fatal (so Railway shows
 * the level name) and exits after the alert attempt, so the platform restarts the bot.
 */
export function installCrashHandlers(options: CrashAlerterOptions): void {
  const { client, logger } = options;
  const alert = createCrashAlerter(options);

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection');
    void alert('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err, origin) => {
    logger.fatal({ err, origin }, 'uncaughtException');
    void alert('uncaughtException', err).finally(() => {
      process.exit(1);
    });
  });

  // Without an 'error' listener an emitted client error is thrown as an uncaught exception.
  client.on('error', (err) => {
    logger.error({ err }, 'discord client error');
  });
  client.on('shardError', (err, shardId) => {
    logger.error({ err, shardId }, 'discord shard error (websocket connection)');
  });
}
