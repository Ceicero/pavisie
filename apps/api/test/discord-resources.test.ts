import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, redisKey } from '@pavisie/core';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const USER_ID = '888888888888888888';

const originalToken = env.DISCORD_TOKEN;

afterEach(() => {
  env.DISCORD_TOKEN = originalToken;
  vi.unstubAllGlobals();
});

// ioredis-mock shares its store across instances in one process, so each test uses its own guild id to keep caches apart.
async function authedApp(GUILD_ID: string) {
  const { app, redis } = await buildTestApp({
    guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
  });
  const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  return { app, redis, headers: { cookie: cookieHeader } };
}

describe('discord channel/role pickers', () => {
  it('returns 503 bot_token_missing when the API has no DISCORD_TOKEN', async () => {
    const GUILD_ID = '777777777777777771';
    env.DISCORD_TOKEN = undefined;
    const { app, headers } = await authedApp(GUILD_ID);

    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/discord/channels`, headers });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'bot_token_missing' } });

    await app.close();
  });

  it('serves the cached channel list without calling Discord', async () => {
    const GUILD_ID = '777777777777777772';
    env.DISCORD_TOKEN = undefined; // any Discord call would 503, proving the cache was used
    const { app, redis, headers } = await authedApp(GUILD_ID);
    await redis.set(
      redisKey('guildchannels', GUILD_ID),
      JSON.stringify([{ id: '1', name: 'general', type: 0 }]),
      'EX',
      60,
    );

    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/discord/channels`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: '1', name: 'general', type: 0 }]);

    await app.close();
  });

  it('fetches channels and roles with the bot token, filters unpickable types and @everyone, and caches the result', async () => {
    const GUILD_ID = '777777777777777773';
    env.DISCORD_TOKEN = 'test-bot-token';
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seenAuth.push(String((init?.headers as Record<string, string> | undefined)?.Authorization));
      if (url.endsWith(`/guilds/${GUILD_ID}/channels`)) {
        return new Response(
          JSON.stringify([
            { id: '30', name: 'voice', type: 2, position: 2, parent_id: null },
            { id: '10', name: 'general', type: 0, position: 0, parent_id: null },
            { id: '99', name: 'thread', type: 11, position: 0, parent_id: '10' }, // public thread → excluded
            { id: '20', name: 'news', type: 5, position: 1, parent_id: null },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith(`/guilds/${GUILD_ID}/roles`)) {
        return new Response(
          JSON.stringify([
            { id: GUILD_ID, name: '@everyone', position: 0, managed: false },
            { id: '2', name: 'Member', position: 1, managed: false },
            { id: '3', name: 'Admin', position: 5, managed: false },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { app, headers } = await authedApp(GUILD_ID);

    const channels = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/discord/channels`,
      headers,
    });
    expect(channels.statusCode).toBe(200);
    expect(channels.json()).toEqual([
      { id: '10', name: 'general', type: 0 },
      { id: '20', name: 'news', type: 5 },
      { id: '30', name: 'voice', type: 2 },
    ]);

    const roles = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/discord/roles`, headers });
    expect(roles.statusCode).toBe(200);
    expect(roles.json()).toEqual([
      { id: '3', name: 'Admin' },
      { id: '2', name: 'Member' },
    ]);

    // Second read hits the 60s cache — no extra Discord call.
    const again = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/discord/roles`, headers });
    expect(again.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seenAuth.every((h) => h === 'Bot test-bot-token')).toBe(true);

    await app.close();
  });

  it('returns 502 when Discord rejects the bot-token request', async () => {
    const GUILD_ID = '777777777777777774';
    env.DISCORD_TOKEN = 'test-bot-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    const { app, headers } = await authedApp(GUILD_ID);

    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/discord/roles`, headers });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'external_service_error' } });

    await app.close();
  });
});
