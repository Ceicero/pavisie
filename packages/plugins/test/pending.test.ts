import RedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';
import { PendingStore } from '../src/sdk';

describe('PendingStore', () => {
  it('put/take round-trips a payload and deletes it after one read', async () => {
    const store = new PendingStore(new RedisMock());
    const id = await store.put({ hello: 'world' });

    expect(await store.take(id)).toEqual({ hello: 'world' });
    expect(await store.take(id)).toBeNull(); // single-use
  });

  it('peek reads without deleting', async () => {
    const store = new PendingStore(new RedisMock());
    const id = await store.put({ n: 1 });

    expect(await store.peek(id)).toEqual({ n: 1 });
    expect(await store.peek(id)).toEqual({ n: 1 }); // still there
    expect(await store.take(id)).toEqual({ n: 1 }); // now consumed
    expect(await store.peek(id)).toBeNull();
  });

  it('take returns null for an id that was never stored', async () => {
    const store = new PendingStore(new RedisMock());
    expect(await store.take('nonexistent')).toBeNull();
  });

  it('respects a custom ttlSec', async () => {
    const redis = new RedisMock();
    const store = new PendingStore(redis);
    const id = await store.put({ x: true }, 30);
    const ttl = await redis.ttl(`pavisie:pending:${id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });
});
