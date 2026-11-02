import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import type { PluginHealth } from '@pavisie/plugins';
import type { GatewayMonitor } from './gateway-monitor';
import type { LoadedHost } from './loader';

/**
 * How long the gateway may be not ready (at startup, or after a disconnect) before `/health` starts answering 503.
 * Generous on purpose: logging in plus plugin startup can take a while, and discord.js usually reconnects by itself.
 */
export const HEALTH_GRACE_MS = 120_000;
const DEFAULT_HEALTH_PORT = 3002;

export interface HealthServerDeps {
  port: number;
  client: Client;
  host: LoadedHost;
  logger: Logger;
  monitor: GatewayMonitor;
  /** Defaults to `HEALTH_GRACE_MS`. */
  graceMs?: number;
}

export interface HealthServerHandle {
  /** Resolves with the port actually bound (useful when `port` is 0). */
  listening: Promise<number>;
  close(): Promise<void>;
}

/** Port precedence: explicit `BOT_HEALTH_PORT`, else the platform's `PORT` (Railway), else 3002. */
export function resolveHealthPort(vars: {
  BOT_HEALTH_PORT?: number | undefined;
  PORT?: number | undefined;
}): number {
  return vars.BOT_HEALTH_PORT ?? vars.PORT ?? DEFAULT_HEALTH_PORT;
}

/**
 * 200 while the gateway is ready or has not been down for longer than the grace period (so a deploy that is still
 * logging in is not failed early), 503 once it has been down longer than that.
 */
export function healthStatusCode(notReadyForMs: number, graceMs: number = HEALTH_GRACE_MS): 200 | 503 {
  return notReadyForMs > graceMs ? 503 : 200;
}

interface HealthBody {
  status: 'ok' | 'starting';
  uptime: number;
  guilds: number;
  ws: number;
  plugins: Record<string, PluginHealth | { status: 'disabled' }>;
}

async function buildHealthBody(deps: HealthServerDeps): Promise<HealthBody> {
  const { client, host } = deps;
  const plugins: HealthBody['plugins'] = {};

  for (const manifest of host.registry.listManifests()) {
    const plugin = host.registry.get(manifest.id);
    const ctx = host.contexts.get(manifest.id);
    let health: PluginHealth | undefined;
    try {
      health = plugin?.health && ctx ? await plugin.health(ctx) : undefined;
    } catch (err) {
      health = { status: 'unavailable', details: err instanceof Error ? err.message : String(err) };
    }
    plugins[manifest.id] = health ?? { status: 'disabled' };
  }

  return {
    status: client.isReady() ? 'ok' : 'starting',
    uptime: Math.round(process.uptime()),
    guilds: client.isReady() ? client.guilds.cache.size : 0,
    ws: client.isReady() ? client.ws.ping : -1,
    plugins,
  };
}

/**
 * Tiny `GET /health` HTTP server (ARCHITECTURE.md §9) — used by Docker/Railway healthchecks and manual checks. No auth
 * (no sensitive data returned). Answers 503 once the gateway has been down past the grace period; note that a
 * healthcheck only gates a deploy going live, it does not restart a running service (the watchdog does that).
 */
export function startHealthServer(deps: HealthServerDeps): HealthServerHandle {
  const server: Server = createServer((req, res) => {
    if (req.method !== 'GET' || !req.url || new URL(req.url, 'http://localhost').pathname !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    buildHealthBody(deps)
      .then((body) => {
        res.writeHead(healthStatusCode(deps.monitor.notReadyForMs(), deps.graceMs), {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify(body));
      })
      .catch((err: unknown) => {
        deps.logger.error({ err }, 'health endpoint failed to build response');
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      });
  });

  const listening = new Promise<number>((resolve) => {
    server.listen(deps.port, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : deps.port;
      deps.logger.info({ port }, 'health server listening');
      resolve(port);
    });
  });

  server.on('error', (err) => {
    deps.logger.error({ err }, 'health server error');
  });

  return {
    listening,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
