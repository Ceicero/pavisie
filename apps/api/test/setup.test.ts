import { describe, expect, it } from 'vitest';
import type { StreamerStarterReportDto } from '@pavisie/types';
import { streamerStarterResultKey } from '@pavisie/plugins/admin/starter-pack';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '666666666666666666';
const OTHER_GUILD_ID = '888888888888888888';
const USER_ID = '777777777777777777';
const CHANNEL_ID = '999999999999999999';

async function authedContext(guilds = [{ id: GUILD_ID, owner: true, permissions: '8' }]) {
  const { app, redis, queues } = await buildTestApp({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake, args shape mirrors Prisma
    guild: { findUnique: async (args: any) => ({ id: args.where.id, botPresent: true }) },
  });
  const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, guilds);
  const mutHeaders = {
    cookie: cookieHeader,
    origin: 'http://localhost:3000',
    'x-csrf-token': session.csrfToken,
  };
  return { app, redis, queues, cookieHeader, mutHeaders };
}

describe('POST /guilds/:guildId/setup/streamer-starter', () => {
  it('queues an admin.streamerStarter bot action for the signed-in user and answers 202 with a request id', async () => {
    const { app, queues, mutHeaders } = await authedContext();

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/setup/streamer-starter`,
      headers: mutHeaders,
      payload: { twitchLogin: ' @Shroud ', alertChannelId: CHANNEL_ID },
    });

    expect(res.statusCode).toBe(202);
    const { requestId } = res.json() as { requestId: string };
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const job = queues.calls.find((c) => c.queue === 'bot-actions');
    expect(job?.data).toEqual({
      type: 'admin.streamerStarter',
      guildId: GUILD_ID,
      payload: { requestId, twitchLogin: '@Shroud', alertChannelId: CHANNEL_ID },
      requestedBy: USER_ID,
    });
    await app.close();
  });

  it('works with no Twitch login at all (the bot enables the plugin and explains how to add one later)', async () => {
    const { app, queues, mutHeaders } = await authedContext();

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/setup/streamer-starter`,
      headers: mutHeaders,
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    expect(queues.calls[0]?.data).toMatchObject({
      type: 'admin.streamerStarter',
      payload: { twitchLogin: null, alertChannelId: null },
    });
    await app.close();
  });

  it('drops a stray alert channel when there is no login, so it cannot be mistaken for a request to add one', async () => {
    const { app, queues, mutHeaders } = await authedContext();
    await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/setup/streamer-starter`,
      headers: mutHeaders,
      payload: { twitchLogin: '  ', alertChannelId: CHANNEL_ID },
    });
    expect(queues.calls[0]?.data).toMatchObject({ payload: { twitchLogin: null, alertChannelId: null } });
    await app.close();
  });

  it('rejects a login without a channel to post in', async () => {
    const { app, queues, mutHeaders } = await authedContext();
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/setup/streamer-starter`,
      headers: mutHeaders,
      payload: { twitchLogin: 'shroud' },
    });
    expect(res.statusCode).toBe(400);
    expect(queues.calls).toEqual([]);
    await app.close();
  });

  it('rejects a login that cannot be a Twitch username', async () => {
    const { app, queues, mutHeaders } = await authedContext();
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/setup/streamer-starter`,
      headers: mutHeaders,
      payload: { twitchLogin: 'not a login!', alertChannelId: CHANNEL_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(queues.calls).toEqual([]);
    await app.close();
  });

  it('401s without a session, 403s without the CSRF token, and 403s for a server the user cannot manage', async () => {
    const { app, cookieHeader, mutHeaders } = await authedContext();
    const url = `/guilds/${GUILD_ID}/setup/streamer-starter`;

    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url, headers: { cookie: cookieHeader }, payload: {} })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/guilds/${OTHER_GUILD_ID}/setup/streamer-starter`,
          headers: mutHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });
});

describe('GET /guilds/:guildId/setup/streamer-starter/:requestId', () => {
  const REPORT: StreamerStarterReportDto = {
    guildId: GUILD_ID,
    ranAt: '2026-01-01T00:00:00.000Z',
    steps: [{ id: 'leveling', status: 'enabled', title: 'Leveling', text: 'On', where: '/level config' }],
    notes: [],
  };

  it('is pending until the bot has stored a result, then returns it', async () => {
    const { app, redis, cookieHeader } = await authedContext();
    const url = `/guilds/${GUILD_ID}/setup/streamer-starter/req-1`;

    const before = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ status: 'pending' });

    await redis.set(
      streamerStarterResultKey(GUILD_ID, 'req-1'),
      JSON.stringify({ status: 'done', report: REPORT }),
    );
    const after = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
    expect(after.json()).toEqual({ status: 'done', report: REPORT });

    await redis.set(
      streamerStarterResultKey(GUILD_ID, 'req-2'),
      JSON.stringify({ status: 'failed', error: 'boom' }),
    );
    const failed = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/setup/streamer-starter/req-2`,
      headers: { cookie: cookieHeader },
    });
    expect(failed.json()).toEqual({ status: 'failed', error: 'boom' });
    await app.close();
  });

  it('never serves another server result, even to someone who manages both', async () => {
    const { app, redis, cookieHeader } = await authedContext([
      { id: GUILD_ID, owner: true, permissions: '8' },
      { id: OTHER_GUILD_ID, owner: true, permissions: '8' },
    ]);
    await redis.set(
      streamerStarterResultKey(OTHER_GUILD_ID, 'req-9'),
      JSON.stringify({ status: 'done', report: { ...REPORT, guildId: OTHER_GUILD_ID } }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/setup/streamer-starter/req-9`,
      headers: { cookie: cookieHeader },
    });
    expect(res.json()).toEqual({ status: 'pending' });
    await app.close();
  });

  it('rejects a request id that is not a plain token', async () => {
    const { app, cookieHeader } = await authedContext();
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/setup/streamer-starter/${encodeURIComponent('../x')}`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
