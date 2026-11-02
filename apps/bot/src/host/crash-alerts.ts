import type { Client } from 'discord.js';
import type { Logger } from 'pino';

/** One alert per kind per minute: a rejection fired in a loop must not turn into a Discord message loop. */
const ALERT_COOLDOWN_MS = 60_000;
/** Keeps the alert well under Discord's 2000-character message limit. */
const ALERT_DETAIL_MAX = 1500;
/** The most a crashing process waits for its alert (and the log flush) before exiting regardless. */
export const CRASH_EXIT_TIMEOUT_MS = 3_000;

/** Discord's webhook endpoints live on these hosts; anything else is refused so the secret URL can't be pointed elsewhere. */
const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com']);
const WEBHOOK_PATH = /^\/api\/(?:v\d+\/)?webhooks\//;

export type CrashKind = 'unhandledRejection' | 'uncaughtException' | 'startupFailure' | 'watchdog';

export type CrashAlert = (kind: CrashKind, err: unknown) => Promise<void>;

export interface CrashAlerterOptions {
  /** Absent on the fatal-startup path, where no client exists yet; only the webhook can be used then. */
  client?: Client;
  logger: Logger;
  /** `ALERT_CHANNEL_ID`; needs a logged-in client, so it is skipped while the gateway is not ready. */
  channelId?: string | undefined;
  /** `ALERT_WEBHOOK_URL`; works without a gateway connection. A secret: never logged. */
  webhookUrl?: string | undefined;
  now?: () => number;
  fetch?: typeof fetch;
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
 * Returns the webhook URL when it is an https Discord webhook, else undefined. Warns (once per call, so once per
 * process) when a value was set but rejected, and never includes the URL in that warning: it contains the
 * webhook's token.
 */
export function parseAlertWebhookUrl(raw: string | undefined, logger: Logger): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    logger.warn('ALERT_WEBHOOK_URL is not a valid URL; webhook alerts are disabled');
    return undefined;
  }
  if (url.protocol !== 'https:' || !WEBHOOK_HOSTS.has(url.hostname) || !WEBHOOK_PATH.test(url.pathname)) {
    logger.warn(
      'ALERT_WEBHOOK_URL must be an https://discord.com/api/webhooks/... URL; webhook alerts are disabled',
    );
    return undefined;
  }
  return url.toString();
}

/**
 * Posts a short alert to the private `ALERT_CHANNEL_ID` channel and/or the `ALERT_WEBHOOK_URL` webhook when the
 * process hits a crash-level error. Never throws and never logs above warn about itself, so a broken alert target
 * can't cause the very errors it reports. With both targets configured, both receive the alert.
 */
export function createCrashAlerter(options: CrashAlerterOptions): CrashAlert {
  const { client, logger, channelId } = options;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? fetch;
  const webhookUrl = parseAlertWebhookUrl(options.webhookUrl, logger);
  const lastSentAt = new Map<CrashKind, number>();
  const suppressed = new Map<CrashKind, number>();

  async function postToChannel(readyClient: Client<true>, id: string, content: string): Promise<void> {
    try {
      const channel = await readyClient.channels.fetch(id);
      if (!channel || !channel.isSendable()) {
        logger.warn({ channelId: id }, 'crash alert: ALERT_CHANNEL_ID is not a channel the bot can send to');
        return;
      }
      await channel.send({ content, allowedMentions: { parse: [] } });
    } catch (sendErr) {
      logger.warn({ channelId: id, err: sendErr }, 'crash alert: failed to post to ALERT_CHANNEL_ID');
    }
  }

  async function postToWebhook(url: string, content: string): Promise<void> {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(CRASH_EXIT_TIMEOUT_MS),
      });
      if (!res.ok) logger.warn({ status: res.status }, 'crash alert: ALERT_WEBHOOK_URL rejected the alert');
    } catch (postErr) {
      // Only the message: a thrown fetch error's cause can carry request details, and the URL is a secret.
      logger.warn(
        { reason: postErr instanceof Error ? postErr.message : String(postErr) },
        'crash alert: failed to post to ALERT_WEBHOOK_URL',
      );
    }
  }

  return async (kind, err) => {
    const readyClient = client?.isReady() ? client : undefined;
    const viaChannel = channelId && readyClient ? { client: readyClient, id: channelId } : undefined;
    if (!viaChannel && !webhookUrl) return;

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
      `**Bot ${kind}**${readyClient ? ` (${readyClient.user.tag})` : ''}`,
      ...(skipped > 0 ? [`(${skipped} more in the last minute were not posted)`] : []),
      '```',
      detail,
      '```',
    ];
    const content = lines.join('\n');
    await Promise.all([
      viaChannel ? postToChannel(viaChannel.client, viaChannel.id, content) : undefined,
      webhookUrl ? postToWebhook(webhookUrl, content) : undefined,
    ]);
  };
}

/** Flushes pino's buffer (a no-op for the default synchronous stdout); resolves even if the flush fails. */
function flushLogger(logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    try {
      logger.flush(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** Resolves when `work` does or after `ms`, whichever is first, and doesn't leave the timer running. */
async function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CrashTerminatorOptions {
  alert: CrashAlert;
  logger: Logger;
  /** Injectable so tests don't kill the test runner. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Cap on how long the alert and log flush may delay the exit. Defaults to `CRASH_EXIT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Returns a function that alerts, flushes logs and exits with code 1, so the platform (Railway's "On Failure"
 * restart policy) brings a fresh process up instead of leaving a half-broken one running. The wait is capped, and
 * a second crash while the first is still being reported exits immediately.
 */
export function createCrashTerminator(options: CrashTerminatorOptions): CrashAlert {
  const { alert, logger } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? CRASH_EXIT_TIMEOUT_MS;
  let terminating = false;

  return async (kind, err) => {
    if (terminating) {
      exit(1);
      return;
    }
    terminating = true;
    await waitAtMost(
      alert(kind, err).then(() => flushLogger(logger)),
      timeoutMs,
    );
    exit(1);
  };
}

export interface InstallCrashHandlersOptions extends CrashAlerterOptions {
  client: Client;
  exit?: (code: number) => void;
  exitTimeoutMs?: number;
}

/**
 * Logs process-level crashes and Discord client errors at error level, posts crash alerts, and exits with code 1
 * after an unhandledRejection or uncaughtException (see `createCrashTerminator`). Installed right after the client
 * is built (before login) so a failure anywhere during startup is still caught. Returns the terminator so other
 * fatal paths (the gateway watchdog) share the alert-then-exit behavior and its re-entry guard.
 */
export function installCrashHandlers(options: InstallCrashHandlersOptions): CrashAlert {
  const { client, logger } = options;
  const terminate = createCrashTerminator({
    alert: createCrashAlerter(options),
    logger,
    ...(options.exit ? { exit: options.exit } : {}),
    ...(options.exitTimeoutMs !== undefined ? { timeoutMs: options.exitTimeoutMs } : {}),
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection');
    void terminate('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err, origin) => {
    logger.error({ err, origin }, 'uncaughtException');
    void terminate('uncaughtException', err);
  });

  // Without an 'error' listener an emitted client error is thrown as an uncaught exception.
  client.on('error', (err) => {
    logger.error({ err }, 'discord client error');
  });
  client.on('shardError', (err, shardId) => {
    logger.error({ err, shardId }, 'discord shard error (websocket connection)');
  });

  return terminate;
}
