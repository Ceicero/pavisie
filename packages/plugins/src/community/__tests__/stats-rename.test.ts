import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { DiscordAPIError, RateLimitError } from 'discord.js';
import { createTestContext } from '../../sdk/testing';
import { CHANNEL_RENAME_INTERVAL_MS } from '../stats-channels';
import { renameStatsChannel, statsChannelRenameKey, type RenameableChannel } from '../stats-rename';

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
