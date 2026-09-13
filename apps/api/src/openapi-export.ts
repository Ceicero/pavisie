import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { createPrismaStub } from '@pavisie/plugins/sdk/testing';
import type { QueueRegistryLike } from './lib/queues';
import { buildApp } from './app';

/** Fake queue registry — the openapi export only needs the app to build and boot, never to actually enqueue anything. */
const fakeQueues: QueueRegistryLike = {
  get: () => ({ add: async () => undefined }),
  botActions: () => ({ add: async () => undefined }),
  integrationsInbound: () => ({ add: async () => undefined }),
  dataRequests: () => ({ add: async () => undefined }),
};

async function main(): Promise<void> {
  const { prisma } = createPrismaStub();
  const redis = new RedisMock() as unknown as Redis;
  // Second, dedicated ioredis-mock for the OBS-overlay routes' pub/sub subscriber. Without it, buildApp()
  // tries to connect to a real Redis at app.ts line ~117 and blocks forever if one is unavailable
  // (ARCHITECTURE.md §10, app.ts `overlaySubscriber` dependency comment). Must be disconnected explicitly here
  // because app.close() skips it for caller-owned (test-injected) instances (app.ts line 351).
  const overlaySubscriber = new RedisMock() as unknown as Redis;

  const app = await buildApp({ prisma, redis, queues: fakeQueues, overlaySubscriber });
  await app.ready();

  const spec = app.swagger();

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
