import { describe, expect, it, vi } from 'vitest';
import { buildTestApp } from './helpers/build-test-app';

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
  // The "not injected" path (shared prisma + createRedis) needs a real DATABASE_URL/Redis, so it is not covered here.
});
