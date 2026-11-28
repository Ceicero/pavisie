import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { prisma as sharedPrisma } from '@pavisie/database';
import { buildApp } from '../src/app';
import { buildTestApp, createFakeQueues } from './helpers/build-test-app';

describe('buildApp onClose hooks', () => {
  it('does not disconnect or quit injected prisma/redis clients', async () => {
    const { app, prisma, redis } = await buildTestApp();
    const disconnect = vi.fn();
    (prisma as unknown as { $disconnect: () => void }).$disconnect = disconnect;
    const quit = vi.spyOn(redis, 'quit');
    await app.close();
    expect(disconnect).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('disconnects the shared Prisma client when the app created it (not injected)', async () => {
    const disconnect = vi.spyOn(sharedPrisma, '$disconnect').mockResolvedValue(undefined);
    try {
      const app = await buildApp({
        redis: new RedisMock() as unknown as Redis,
        overlaySubscriber: new RedisMock() as unknown as Redis,
        queues: createFakeQueues(),
        logger: pino({ enabled: false }),
      });
      await app.close();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      disconnect.mockRestore();
    }
  });
});
