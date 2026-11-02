import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { DiscordAPIError, REST, RateLimitError, Routes } from 'discord.js';
import { createTestContext } from '../../sdk/testing';
import { CHANNEL_RENAME_INTERVAL_MS } from '../stats-channels';
import {
  renameStatsChannel,
  statsChannelRenameKey,
  statsRenameRateLimitFilter,
  type RenameableChannel,
} from '../stats-rename';

const GUILD_ID = 'guild-1';
/** A snowflake-shaped id: @discordjs/rest only treats 17-19 digit numbers as major parameters. */
const CHANNEL_ID = '123456789012345678';

function channelWith(setName: (name: string) => Promise<unknown>, name = 'Members: 0') {
  const ch = {
    id: CHANNEL_ID,
    name,
    setName: vi.fn(async (next: string) => {
      await setName(next);
      ch.name = next;
    }),
  };
  return ch satisfies RenameableChannel;
}

function rateLimitError(overrides: Partial<ConstructorParameters<typeof RateLimitError>[0]> = {}) {
  return new RateLimitError({
    global: false,
    hash: 'hash',
    limit: 2,
    majorParameter: CHANNEL_ID,
    method: 'PATCH',
    retryAfter: 540_050,
    route: '/channels/:id',
    scope: 'shared',
    sublimitTimeout: 540_050,
    timeToReset: 540_050,
    url: `https://discord.com/api/v10/channels/${CHANNEL_ID}`,
    ...overrides,
  });
}

// ioredis-mock instances share one in-memory store per process; start every test with no throttle keys.
beforeEach(async () => {
  await new RedisMock().flushall();
});

describe('renameStatsChannel', () => {
  it('makes no API call and spends no rename budget when the name already matches', async () => {
    const { ctx, redis } = createTestContext();
    const ch = channelWith(async () => undefined, 'Members: 42');

    await expect(renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 42')).resolves.toEqual({
      status: 'unchanged',
    });
    expect(ch.setName).not.toHaveBeenCalled();
    expect(await redis.get(statsChannelRenameKey(GUILD_ID, CHANNEL_ID))).toBeNull();
  });

  it('renames once, then throttles the channel for 10 minutes without calling Discord', async () => {
    const { ctx, redis } = createTestContext();
    const ch = channelWith(async () => undefined);
    const now = new Date('2026-11-02T10:00:00Z');

    await expect(renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 42', now)).resolves.toEqual({
      status: 'renamed',
    });
    expect(ch.setName).toHaveBeenCalledWith('Members: 42', 'Server stats');
    const key = statsChannelRenameKey(GUILD_ID, CHANNEL_ID);
    expect(await redis.get(key)).toBe(now.toISOString());
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(CHANNEL_RENAME_INTERVAL_MS / 1000 - 5);
    expect(ttl).toBeLessThanOrEqual(CHANNEL_RENAME_INTERVAL_MS / 1000);

    // Same channel, new count, any caller (job or manual): skipped.
    await expect(renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 43', now)).resolves.toEqual({
      status: 'throttled',
    });
    expect(ch.setName).toHaveBeenCalledTimes(1);

    // Once the Redis key expires the next rename goes through.
    await redis.del(key);
    await expect(renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 43', now)).resolves.toEqual({
      status: 'renamed',
    });
    expect(ch.setName).toHaveBeenCalledTimes(2);
  });

  it('skips a RateLimitError (retryAfter in ms) and keeps the channel throttled until retry_after', async () => {
    const { ctx, redis } = createTestContext();
    const warn = vi.spyOn(ctx.logger, 'warn');
    const ch = channelWith(async () => {
      throw rateLimitError({ retryAfter: 1_500_000, sublimitTimeout: 1_500_000 });
    });

    const outcome = await renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 42');
    expect(outcome).toEqual({ status: 'rate-limited', retryAfterMs: 1_500_000 });
    const key = statsChannelRenameKey(GUILD_ID, CHANNEL_ID);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(1_400);
    expect(ttl).toBeLessThanOrEqual(1_500);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: GUILD_ID, channelId: CHANNEL_ID, retryAfterMs: 1_500_000 }),
      expect.stringContaining('rate limited'),
    );

    // No early retry, however many callers come by.
    await renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 43');
    await renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 44');
    expect(ch.setName).toHaveBeenCalledTimes(1);
  });

  it('skips a 429 DiscordAPIError (retry_after in seconds) the same way', async () => {
    const { ctx, redis } = createTestContext();
    // Discord's 429 body carries `retry_after` (seconds), which the library's error-body types don't declare.
    const body = { message: 'You are being rate limited.', retry_after: 1500.2, code: 0 };
    const err = new DiscordAPIError(
      body as unknown as ConstructorParameters<typeof DiscordAPIError>[0],
      0,
      429,
      'PATCH',
      `https://discord.com/api/v10/channels/${CHANNEL_ID}`,
      {},
    );
    const ch = channelWith(async () => {
      throw err;
    });

    const outcome = await renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 42');
    expect(outcome).toEqual({ status: 'rate-limited', retryAfterMs: 1_500_200 });
    const ttl = await redis.ttl(statsChannelRenameKey(GUILD_ID, CHANNEL_ID));
    expect(ttl).toBeGreaterThan(1_400);
    expect(ttl).toBeLessThanOrEqual(1_501);
    await renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 43');
    expect(ch.setName).toHaveBeenCalledTimes(1);
  });

  it('never keeps a channel throttled for less than the 10 minute interval, even for a short retry_after', async () => {
    const { ctx, redis } = createTestContext();
    const ch = channelWith(async () => {
      throw rateLimitError({ retryAfter: 2_000, sublimitTimeout: 0 });
    });

    await renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 42');
    expect(await redis.ttl(statsChannelRenameKey(GUILD_ID, CHANNEL_ID))).toBeGreaterThan(9 * 60);
  });

  it.each([
    [50001, 'Missing Access'],
    [50013, 'Missing Permissions'],
  ])(
    'reports %i as no-permission (so the caller pauses the guild) without logging',
    async (code, message) => {
      const { ctx } = createTestContext();
      const warn = vi.spyOn(ctx.logger, 'warn');
      const ch = channelWith(async () => {
        throw Object.assign(new Error(message), { code });
      });

      await expect(renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 42')).resolves.toEqual({
        status: 'no-permission',
        code,
        message,
      });
      // Warning once per guild is the caller's job (it knows whether the guild was already paused).
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('warns with the Discord code, message and the error object (for its stack) on other failures', async () => {
    const { ctx } = createTestContext();
    const warn = vi.spyOn(ctx.logger, 'warn');
    const err = Object.assign(new Error('Invalid Form Body'), { code: 50035 });
    const ch = channelWith(async () => {
      throw err;
    });

    await expect(renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 42')).resolves.toEqual({
      status: 'failed',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: GUILD_ID, channelId: CHANNEL_ID, code: 50035, err }),
      expect.stringContaining('Invalid Form Body'),
    );
  });
});

describe('statsRenameRateLimitFilter', () => {
  const patchChannel = { global: false, method: 'PATCH', route: '/channels/:id', majorParameter: CHANNEL_ID };

  it('is false for everything while no stats rename is in flight', () => {
    expect(statsRenameRateLimitFilter(patchChannel)).toBe(false);
  });

  it('is true only for the in-flight channel’s PATCH /channels/:id', async () => {
    const { ctx } = createTestContext();
    let during: Record<string, boolean> = {};
    const ch = channelWith(async () => {
      during = {
        rename: statsRenameRateLimitFilter(patchChannel),
        lowercaseMethod: statsRenameRateLimitFilter({ ...patchChannel, method: 'patch' }),
        otherChannel: statsRenameRateLimitFilter({ ...patchChannel, majorParameter: '999999999999999999' }),
        otherMethod: statsRenameRateLimitFilter({ ...patchChannel, method: 'DELETE' }),
        messagesRoute: statsRenameRateLimitFilter({ ...patchChannel, route: '/channels/:id/messages' }),
        global: statsRenameRateLimitFilter({ ...patchChannel, global: true }),
      };
    });

    await renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 42');
    expect(during).toEqual({
      rename: true,
      lowercaseMethod: true,
      otherChannel: false,
      otherMethod: false,
      messagesRoute: false,
      global: false,
    });
    // ...and the channel is released as soon as the call settles.
    expect(statsRenameRateLimitFilter(patchChannel)).toBe(false);
  });

  it('releases the channel when the rename throws', async () => {
    const { ctx } = createTestContext();
    let during = false;
    const ch = channelWith(async () => {
      during = statsRenameRateLimitFilter(patchChannel);
      throw new Error('boom');
    });

    await renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 42');
    expect(during).toBe(true);
    expect(statsRenameRateLimitFilter(patchChannel)).toBe(false);
  });

  // The behaviour the filter exists for, against the real REST layer: Discord answers the rename with a 429 that
  // carries a ~9 minute sublimit. Without the filter discord.js would sleep that long inside `setName`.
  describe('with discord.js’s REST layer', () => {
    function restThatAlwaysRateLimits() {
      const makeRequest = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ message: 'You are being rate limited.', retry_after: 540, global: false }),
            {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': '540',
                'X-RateLimit-Scope': 'shared',
              },
            },
          ),
      );
      const rest = new REST({
        makeRequest,
        rejectOnRateLimit: statsRenameRateLimitFilter,
        hashSweepInterval: 0,
        handlerSweepInterval: 0,
      }).setToken('test-token');
      return { rest, makeRequest };
    }

    it('turns the channel-name sublimit into a skip right away, and leaves the channel throttled', async () => {
      const { ctx, redis } = createTestContext();
      const { rest, makeRequest } = restThatAlwaysRateLimits();
      const ch = channelWith(async (name) => {
        await rest.patch(Routes.channel(CHANNEL_ID), { body: { name } });
      });

      const outcome = await renameStatsChannel(ctx, GUILD_ID, ch, 'Members: 42');

      expect(outcome.status).toBe('rate-limited');
      // 540 s from Retry-After plus discord.js's 50 ms offset.
      expect(outcome).toMatchObject({ retryAfterMs: expect.any(Number) });
      expect((outcome as { retryAfterMs: number }).retryAfterMs).toBeGreaterThanOrEqual(540_000);
      expect(makeRequest).toHaveBeenCalledTimes(1); // not retried
      expect(await redis.ttl(statsChannelRenameKey(GUILD_ID, CHANNEL_ID))).toBeGreaterThan(539);
    });

    it('does not reject a request for a channel with no stats rename in flight', async () => {
      const { rest } = restThatAlwaysRateLimits();
      // Same 429, but nothing registered the channel: the filter says "keep queueing", so the request stays
      // pending instead of throwing. Race it against a short timer to prove that without waiting 9 minutes.
      const pending = rest.patch(Routes.channel(CHANNEL_ID), { body: { name: 'x' } }).then(
        () => 'resolved',
        () => 'rejected',
      );
      const outcome = await Promise.race([
        pending,
        new Promise((r) => setTimeout(() => r('still queued'), 200)),
      ]);
      expect(outcome).toBe('still queued');
    });
  });
});
