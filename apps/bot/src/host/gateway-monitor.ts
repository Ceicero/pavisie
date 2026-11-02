import type { Client } from 'discord.js';
import type { Logger } from 'pino';

/** How often the gateway state is sampled. Only needs to be fine compared with the minutes-long thresholds. */
const SAMPLE_INTERVAL_MS = 10_000;

export interface GatewayMonitorOptions {
  client: Client;
  logger: Logger;
  now?: () => number;
  sampleMs?: number;
  /**
   * When set, `onTrip` is called once the gateway has been continuously not ready for `afterMs`. discord.js
   * reconnects on its own, so this is the last resort for a connection that never comes back.
   */
  watchdog?: { afterMs: number; onTrip: (notReadyForMs: number) => void };
}

export interface GatewayMonitor {
  /** How long the gateway has been continuously not ready, 0 while it is ready. Counted from monitor creation until the first ready. */
  notReadyForMs(): number;
  stop(): void;
}

/**
 * Tracks how long the Discord gateway connection has been down, for `/health` and the watchdog. `client.isReady()`
 * is a point-in-time check, so a timer samples it to know *since when* it has been false; without that, a health
 * request arriving after a long quiet spell couldn't tell a fresh disconnect from an old one.
 */
export function createGatewayMonitor(options: GatewayMonitorOptions): GatewayMonitor {
  const { client, logger, watchdog } = options;
  const now = options.now ?? Date.now;
  let notReadySince: number | undefined = now();
  let tripped = false;

  function notReadyForMs(): number {
    if (client.isReady()) {
      notReadySince = undefined;
      return 0;
    }
    notReadySince ??= now();
    return now() - notReadySince;
  }

  const timer = setInterval(() => {
    const down = notReadyForMs();
    if (watchdog && !tripped && down >= watchdog.afterMs) {
      tripped = true;
      try {
        watchdog.onTrip(down);
      } catch (err) {
        logger.error({ err }, 'gateway watchdog handler failed');
      }
    }
  }, options.sampleMs ?? SAMPLE_INTERVAL_MS);
  // Never the reason the process stays alive; the client and workers do that.
  timer.unref();

  return {
    notReadyForMs,
    stop: () => clearInterval(timer),
  };
}
