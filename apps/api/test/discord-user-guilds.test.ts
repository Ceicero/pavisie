import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError, redisKey } from '@pavisie/core';
import { getCachedUserGuilds } from '../src/lib/discord';

// ioredis-mock shares its store across instances in one process (see apps/api/test/discord-resources.test.ts),
// so each test uses its own userId to keep caches — and in-flight de-dup map entries — apart.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('getCachedUserGuilds', () => {
  it('dedupes concurrent cold-cache calls for the same user into a single Discord fetch', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const setSpy = vi.spyOn(redis, 'set');
    const USER_ID = 'user-concurrent-same';
    const guilds = [{ id: '1', name: 'Guild One', icon: null, owner: true, permissions: '8' }];
    const fetchMock = vi.fn(async () => jsonResponse(guilds));
    vi.stubGlobal('fetch', fetchMock);

    const [r1, r2, r3] = await Promise.all([
      getCachedUserGuilds(redis, USER_ID, 'token'),
      getCachedUserGuilds(redis, USER_ID, 'token'),
      getCachedUserGuilds(redis, USER_ID, 'token'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(guilds);
    expect(r2).toEqual(guilds);
    expect(r3).toEqual(guilds);
    expect(setSpy).toHaveBeenCalledTimes(1);

    const cached = await redis.get(redisKey('userguilds', USER_ID));
    expect(JSON.parse(cached!)).toEqual(guilds);
  });

  it('does not dedupe concurrent calls across different users', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([
      getCachedUserGuilds(redis, 'user-concurrent-a', 'token'),
      getCachedUserGuilds(redis, 'user-concurrent-b', 'token'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects all concurrent callers when the fetch fails, and fetches again on the next call', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const USER_ID = 'user-fetch-fails';
    const guilds = [{ id: '2', name: 'Guild Two', icon: null, owner: false, permissions: '0' }];
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response('server error', { status: 500 });
      return jsonResponse(guilds);
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.allSettled([
      getCachedUserGuilds(redis, USER_ID, 'token'),
      getCachedUserGuilds(redis, USER_ID, 'token'),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The in-flight map entry was cleared on failure, so this call issues a fresh fetch rather than
    // reusing (and re-rejecting from) the previous failed promise.
    const result = await getCachedUserGuilds(redis, USER_ID, 'token');
    expect(result).toEqual(guilds);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits out a 429 retry_after and resolves using the retry response', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const USER_ID = 'user-429-then-200';
    const guilds = [{ id: '3', name: 'Guild Three', icon: null, owner: true, permissions: '8' }];
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(
          { message: 'You are being rate limited.', retry_after: 0.01, global: false },
          { status: 429, headers: { 'Retry-After': '1' } },
        );
      }
      return jsonResponse(guilds);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getCachedUserGuilds(redis, USER_ID, 'token');
    expect(result).toEqual(guilds);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws ExternalServiceError("(429)") when the retry also 429s', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const USER_ID = 'user-429-twice';
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: 'You are being rate limited.', retry_after: 0.01, global: false }, { status: 429 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCachedUserGuilds(redis, USER_ID, 'token')).rejects.toBeInstanceOf(ExternalServiceError);
    await expect(getCachedUserGuilds(redis, USER_ID, 'token')).rejects.toThrow('(429)');
    expect(fetchMock).toHaveBeenCalledTimes(4); // two calls above, each retrying once
  });

  it('serves a warm cache without calling Discord at all', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const USER_ID = 'user-warm-cache';
    const guilds = [{ id: '9', name: 'Warm Guild', icon: null, owner: true, permissions: '8' }];
    await redis.set(redisKey('userguilds', USER_ID), JSON.stringify(guilds), 'EX', 60);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await getCachedUserGuilds(redis, USER_ID, 'token');
    expect(result).toEqual(guilds);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
