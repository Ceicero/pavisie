import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import type { PluginHealth } from '@pavisie/plugins';
import type { LoadedHost } from './loader';

export interface HealthServerDeps {
  port: number;
  client: Client;
  host: LoadedHost;
  logger: Logger;
}

export interface HealthServerHandle {
  close(): Promise<void>;
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

/** Tiny `GET /health` HTTP server (ARCHITECTURE.md §9) — used by Docker healthchecks and manual checks. No auth (no sensitive data returned). */
export function startHealthServer(deps: HealthServerDeps): HealthServerHandle {
  const server: Server = createServer((req, res) => {
    if (req.method !== 'GET' || !req.url || new URL(req.url, 'http://localhost').pathname !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    buildHealthBody(deps)
      .then((body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      })
      .catch((err: unknown) => {
        deps.logger.error({ err }, 'health endpoint failed to build response');
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      });
  });

  server.listen(deps.port, () => {
    deps.logger.info({ port: deps.port }, 'health server listening');
  });

  server.on('error', (err) => {
    deps.logger.error({ err }, 'health server error');
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
