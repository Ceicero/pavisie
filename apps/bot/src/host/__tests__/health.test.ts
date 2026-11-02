import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Client } from 'discord.js';
import {
  HEALTH_GRACE_MS,
  healthStatusCode,
  resolveHealthPort,
  startHealthServer,
  type HealthServerHandle,
} from '../health';
import type { GatewayMonitor } from '../gateway-monitor';
import type { LoadedHost } from '../loader';

const logger = pino({ enabled: false });

describe('healthStatusCode', () => {
  it('is 200 while the gateway is ready or has only just dropped', () => {
    expect(healthStatusCode(0)).toBe(200);
    expect(healthStatusCode(30_000)).toBe(200);
  });

  it('is still 200 right at the end of the grace period and 503 once it is exceeded', () => {
    expect(healthStatusCode(HEALTH_GRACE_MS)).toBe(200);
    expect(healthStatusCode(HEALTH_GRACE_MS + 1)).toBe(503);
  });

  it('honours a custom grace period', () => {
    expect(healthStatusCode(5_000, 4_000)).toBe(503);
    expect(healthStatusCode(5_000, 6_000)).toBe(200);
  });
});

describe('resolveHealthPort', () => {
  it('prefers BOT_HEALTH_PORT, then PORT, then 3002', () => {
    expect(resolveHealthPort({ BOT_HEALTH_PORT: 4000, PORT: 5000 })).toBe(4000);
    expect(resolveHealthPort({ PORT: 5000 })).toBe(5000);
    expect(resolveHealthPort({})).toBe(3002);
  });
});

describe('GET /health', () => {
  let handle: HealthServerHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function get(opts: { ready: boolean; notReadyForMs: number; path?: string }) {
    const client = { isReady: () => opts.ready, guilds: { cache: { size: 2 } }, ws: { ping: 42 } };
    const host = { registry: { listManifests: () => [] }, contexts: new Map() };
    const monitor: GatewayMonitor = { notReadyForMs: () => opts.notReadyForMs, stop: () => undefined };
    handle = startHealthServer({
      port: 0,
      client: client as unknown as Client,
      host: host as unknown as LoadedHost,
      logger,
      monitor,
    });
    const port = await handle.listening;
    const res = await fetch(`http://127.0.0.1:${port}${opts.path ?? '/health'}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('returns 200 and status ok when the gateway is ready', async () => {
    const { status, body } = await get({ ready: true, notReadyForMs: 0 });
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.guilds).toBe(2);
  });

  it('returns 200 while still starting inside the grace period', async () => {
    const { status, body } = await get({ ready: false, notReadyForMs: 60_000 });
    expect(status).toBe(200);
    expect(body.status).toBe('starting');
  });

  it('returns 503 with the same JSON body once the gateway has been down past the grace period', async () => {
    const { status, body } = await get({ ready: false, notReadyForMs: HEALTH_GRACE_MS + 1_000 });
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: 'starting', guilds: 0, ws: -1, plugins: {} });
  });

  it('still 404s other paths', async () => {
    const { status } = await get({ ready: true, notReadyForMs: 0, path: '/nope' });
    expect(status).toBe(404);
  });
});
