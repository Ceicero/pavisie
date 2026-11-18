import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type { QueueRegistryLike } from './lib/queues';

/**
 * The committed spec must not depend on whoever runs the export. `@pavisie/core`'s env loader reads the repo-root
 * `.env` at import time without overriding variables that are already set, so pin the values that change the spec
 * *before* the app is imported (hence the dynamic imports in `main`):
 * - NODE_ENV: production skips registering swagger entirely; test matches CI.
 * - E2E_TEST_MODE: would add the Playwright-only `POST /auth/test-login`.
 * `servers` (from API_BASE_URL) is overwritten after generation instead, because an unset value can't be pinned.
 */
process.env.NODE_ENV = 'test';
process.env.E2E_TEST_MODE = 'false';
const SPEC_SERVERS = [{ url: 'http://localhost:3001' }];

/** Fake queue registry — the openapi export only needs the app to build and boot, never to actually enqueue anything. */
const fakeQueues: QueueRegistryLike = {
  get: () => ({ add: async () => undefined }),
  botActions: () => ({ add: async () => undefined }),
  integrationsInbound: () => ({ add: async () => undefined }),
  dataRequests: () => ({ add: async () => undefined }),
};

async function main(): Promise<void> {
  const { createPrismaStub } = await import('@pavisie/plugins/sdk/testing');
  const { buildApp } = await import('./app');
  const { prisma } = createPrismaStub();
  const redis = new RedisMock() as unknown as Redis;
  // Second, dedicated ioredis-mock for the OBS-overlay routes' pub/sub subscriber. Without it, buildApp()
  // tries to connect to a real Redis at app.ts line ~117 and blocks forever if one is unavailable
  // (ARCHITECTURE.md §10, app.ts `overlaySubscriber` dependency comment). Must be disconnected explicitly here
  // because app.close() skips it for caller-owned (test-injected) instances (app.ts line 351).
  const overlaySubscriber = new RedisMock() as unknown as Redis;

  const app = await buildApp({ prisma, redis, queues: fakeQueues, overlaySubscriber });
  await app.ready();

  const spec = { ...app.swagger(), servers: SPEC_SERVERS };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const docsDir = path.resolve(here, '../../../docs');
  await mkdir(docsDir, { recursive: true });
  const outPath = path.join(docsDir, 'openapi.json');
  await writeFile(outPath, JSON.stringify(spec, null, 2), 'utf8');

  // eslint-disable-next-line no-console -- CLI script output
  console.log(`Wrote ${outPath}`);
  await app.close();
  // Explicit disconnect of the caller-owned overlaySubscriber, bypassing the app.close() skip (line 351).
  overlaySubscriber.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
