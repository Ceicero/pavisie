import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError, env, redisKey } from '@pavisie/core';
import { getCachedGuildChannels, getCachedGuildRoles } from '../src/lib/discord';

// ioredis-mock shares its store across instances in one process (see apps/api/test/discord-resources.test.ts),
// so each test uses its own guild id to keep caches — and in-flight de-dup map entries — apart.

const originalToken = env.DISCORD_TOKEN;

beforeEach(() => {
  env.DISCORD_TOKEN = 'test-bot-token';
});

afterEach(() => {
  env.DISCORD_TOKEN = originalToken;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const RAW_CHANNELS = [
  { id: '30', name: 'voice', type: 2, position: 2, parent_id: null },
  { id: '10', name: 'general', type: 0, position: 0, parent_id: null },
  { id: '99', name: 'thread', type: 11, position: 0, parent_id: '10' }, // public thread → excluded
];
const CHANNELS = [
  { id: '10', name: 'general', type: 0 },
  { id: '30', name: 'voice', type: 2 },
];

function rawRoles(guildId: string) {
  return [
    { id: guildId, name: '@everyone', position: 0, managed: false },
    { id: '2', name: 'Member', position: 1, managed: false },
    { id: '3', name: 'Admin', position: 5, managed: false },
  ];
}
const ROLES = [
  { id: '3', name: 'Admin' },
  { id: '2', name: 'Member' },
];

describe('getCachedGuildChannels / getCachedGuildRoles (bot-token guild resources)', () => {
  it('dedupes concurrent cold-cache calls to getCachedGuildChannels for the same guild into a single fetch', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const setSpy = vi.spyOn(redis, 'set');
    const GUILD_ID = 'guild-bot-concurrent-same';
    const fetchMock = vi.fn(async () => jsonResponse(RAW_CHANNELS));
    vi.stubGlobal('fetch', fetchMock);

    const [r1, r2, r3] = await Promise.all([
      getCachedGuildChannels(redis, GUILD_ID),
      getCachedGuildChannels(redis, GUILD_ID),
      getCachedGuildChannels(redis, GUILD_ID),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(CHANNELS);
    expect(r2).toEqual(CHANNELS);
    expect(r3).toEqual(CHANNELS);
    expect(setSpy).toHaveBeenCalledTimes(1);

    const cached = await redis.get(redisKey('guildchannels', GUILD_ID));
    expect(JSON.parse(cached!)).toEqual(CHANNELS);
  });

  it('dedupes concurrent cold-cache calls to getCachedGuildRoles for the same guild into a single fetch', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const setSpy = vi.spyOn(redis, 'set');
    const GUILD_ID = 'guild-bot-concurrent-same-roles';
    const fetchMock = vi.fn(async () => jsonResponse(rawRoles(GUILD_ID)));
    vi.stubGlobal('fetch', fetchMock);

    const [r1, r2, r3] = await Promise.all([
      getCachedGuildRoles(redis, GUILD_ID),
      getCachedGuildRoles(redis, GUILD_ID),
      getCachedGuildRoles(redis, GUILD_ID),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(ROLES);
    expect(r2).toEqual(ROLES);
    expect(r3).toEqual(ROLES);
    expect(setSpy).toHaveBeenCalledTimes(1);

    const cached = await redis.get(redisKey('guildroles', GUILD_ID));
    expect(JSON.parse(cached!)).toEqual(ROLES);
  });

  it('does not dedupe concurrent calls across different guilds', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const redis = new RedisMock() as unknown as Redis;

    await Promise.all([
      getCachedGuildChannels(redis, 'guild-bot-different-a'),
      getCachedGuildChannels(redis, 'guild-bot-different-b'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe channels against roles for the same guild', async () => {
    const GUILD_ID = 'guild-bot-channels-vs-roles';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/channels')) return jsonResponse(RAW_CHANNELS);
      if (url.endsWith('/roles')) return jsonResponse(rawRoles(GUILD_ID));
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const redis = new RedisMock() as unknown as Redis;

    const [channels, roles] = await Promise.all([
      getCachedGuildChannels(redis, GUILD_ID),
      getCachedGuildRoles(redis, GUILD_ID),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(channels).toEqual(CHANNELS);
    expect(roles).toEqual(ROLES);
  });

  it('rejects all concurrent callers when the fetch fails, and fetches again on the next call', async () => {
    const GUILD_ID = 'guild-bot-fetch-fails';
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response('server error', { status: 500 });
      return jsonResponse(RAW_CHANNELS);
    });
    vi.stubGlobal('fetch', fetchMock);
    const redis = new RedisMock() as unknown as Redis;

    const results = await Promise.allSettled([
      getCachedGuildChannels(redis, GUILD_ID),
      getCachedGuildChannels(redis, GUILD_ID),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The in-flight map entry was cleared on failure, so this call issues a fresh fetch rather than
    // reusing (and re-rejecting from) the previous failed promise.
    const result = await getCachedGuildChannels(redis, GUILD_ID);
    expect(result).toEqual(CHANNELS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits out a 429 retry_after and resolves using the retry response', async () => {
    const GUILD_ID = 'guild-bot-429-then-200';
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(
          { message: 'You are being rate limited.', retry_after: 0.01, global: false },
          { status: 429, headers: { 'Retry-After': '1' } },
        );
      }
      return jsonResponse(RAW_CHANNELS);
    });
    vi.stubGlobal('fetch', fetchMock);
    const redis = new RedisMock() as unknown as Redis;

    const result = await getCachedGuildChannels(redis, GUILD_ID);
    expect(result).toEqual(CHANNELS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws ExternalServiceError("(429)") when the retry also 429s', async () => {
    const GUILD_ID = 'guild-bot-429-twice';
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { message: 'You are being rate limited.', retry_after: 0.01, global: false },
        { status: 429 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const redis = new RedisMock() as unknown as Redis;

    // Both assertions target the same in-flight promise (rather than issuing two separate calls), so the
    // fetch + single retry only happens once — matching a single caller seeing a single rejected call.
    const promise = getCachedGuildChannels(redis, GUILD_ID);
    await expect(promise).rejects.toBeInstanceOf(ExternalServiceError);
    await expect(promise).rejects.toThrow('(429)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves a warm cache without calling Discord at all', async () => {
    const GUILD_ID = 'guild-bot-warm-cache';
    const redis = new RedisMock() as unknown as Redis;
    await redis.set(redisKey('guildroles', GUILD_ID), JSON.stringify(ROLES), 'EX', 60);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await getCachedGuildRoles(redis, GUILD_ID);
    expect(result).toEqual(ROLES);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the bot token as an Authorization: Bot header on every request', async () => {
    const GUILD_ID = 'guild-bot-auth-header';
    const seenAuth: unknown[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      return jsonResponse(RAW_CHANNELS);
    });
    vi.stubGlobal('fetch', fetchMock);
    const redis = new RedisMock() as unknown as Redis;

    await getCachedGuildChannels(redis, GUILD_ID);

    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth.every((h) => h === 'Bot test-bot-token')).toBe(true);
  });
});
