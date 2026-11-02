import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { RateLimitError, type Client } from 'discord.js';
import { createTestContext } from '../../sdk/testing';
import type { CommunityConfig } from '../manifest';
import { configSchema } from '../manifest';
import { refreshGuildStats, statsBlockedKey, statsLastKey, statsRefreshJob } from '../jobs/stats-refresh';
import { rateLimitRetryAfterMs, statsChannelRenameKey } from '../stats-rename';

const GUILD_ID = 'guild-1';

interface FakeChannel {
  id: string;
  name: string;
  /** The bot's permission bitfield on this channel, as `permissionsFor(me)` reports it. */
  perms: bigint;
  setName: ReturnType<typeof vi.fn>;
  permissionsFor: () => { bitfield: bigint };
}

function fakeChannel(id: string, name: string, setNameImpl?: () => Promise<unknown>): FakeChannel {
  const ch: FakeChannel = {
    id,
    name,
    perms: 1024n,
    permissionsFor: () => ({ bitfield: ch.perms }),
    setName: vi.fn(async (next: string) => {
      if (setNameImpl) await setNameImpl();
      ch.name = next;
      return ch;
    }),
  };
  return ch;
}

function fakeGuild(channels: FakeChannel[], opts: { available?: boolean } = {}) {
  const channelMap = new Map(channels.map((c) => [c.id, c]));
  return {
    id: GUILD_ID,
    name: 'Test Guild',
    available: opts.available ?? true,
    memberCount: 42,
    members: { cache: { filter: () => ({ size: 2 }), size: 42 }, me: { id: 'bot-1' } },
    premiumSubscriptionCount: 1,
    roles: { cache: { size: 4 } },
    channels: { cache: { size: channels.length, get: (id: string) => channelMap.get(id) } },
  };
}

function buildCtx(guild: ReturnType<typeof fakeGuild>, cfgPatch: Partial<CommunityConfig>) {
  const cfg = configSchema.parse(cfgPatch);
  const setConfigCalls: unknown[] = [];
  const client = {
    user: { id: 'bot-1' },
    guilds: { cache: new Map([[GUILD_ID, guild]]) },
  } as unknown as Client<true>;
  const test = createTestContext({
    config: cfg,
    overrides: {
      client,
      setConfig: async <T>(_guildId: string, patch: Partial<T>) => {
        setConfigCalls.push(patch);
        return { ...cfg, ...patch } as T;
      },
    },
  });
  return { ...test, cfg, setConfigCalls };
}

describe('statsRefreshJob', () => {
  // ioredis-mock instances share one in-memory store per process; clear the gate keys between tests.
  beforeEach(async () => {
    await new RedisMock().flushall();
  });

  it('renames a channel whose name differs and leaves a matching one alone', async () => {
    const stale = fakeChannel('c1', 'Members: 0');
    const fresh = fakeChannel('c2', 'Bots: 2');
    const guild = fakeGuild([stale, fresh]);
    const { ctx } = buildCtx(guild, {
      statsChannels: [
        { channelId: 'c1', template: 'Members: {members}' },
        { channelId: 'c2', template: 'Bots: {bots}' },
      ],
    });

    await statsRefreshJob.processor(ctx, {} as never);

    expect(stale.setName).toHaveBeenCalledTimes(1);
    expect(stale.setName).toHaveBeenCalledWith('Members: 42', 'Server stats');
    expect(fresh.setName).not.toHaveBeenCalled();
  });

  it('per-guild gate blocks a second run inside the interval', async () => {
    const ch = fakeChannel('c1', 'Members: 0');
    const guild = fakeGuild([ch]);
    const { ctx, redis } = buildCtx(guild, {
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });

    await statsRefreshJob.processor(ctx, {} as never);
    expect(ch.setName).toHaveBeenCalledTimes(1);
    expect(await redis.get(statsLastKey(GUILD_ID))).toBeTruthy();

    // Simulate the count changing; the second tick must not rename because the interval hasn't elapsed.
    guild.memberCount = 43;
    await statsRefreshJob.processor(ctx, {} as never);
    expect(ch.setName).toHaveBeenCalledTimes(1);

    // Once the gate key expires, the next tick renames again. The per-CHANNEL rename budget (A7) is a separate
    // gate — clear it too, since this test is only about the per-guild interval (see the dedicated per-channel
    // throttle test below).
    await redis.del(statsLastKey(GUILD_ID));
    await redis.del(statsChannelRenameKey(GUILD_ID, 'c1'));
    await statsRefreshJob.processor(ctx, {} as never);
    expect(ch.setName).toHaveBeenCalledTimes(2);
    expect(ch.name).toBe('Members: 43');
  });

  it('skips an unavailable guild (regional outage) and leaves its stats-channel config untouched', async () => {
    const ch = fakeChannel('c1', 'Members: 0');
    const guild = fakeGuild([ch], { available: false });
    const { ctx, setConfigCalls } = buildCtx(guild, {
      statsChannels: [
        { channelId: 'c1', template: 'Members: {members}' },
        { channelId: 'gone', template: 'Boosts: {boosts}' },
      ],
    });

    await statsRefreshJob.processor(ctx, {} as never);

    expect(ch.setName).not.toHaveBeenCalled();
    // Without the availability check an unavailable guild's empty channel cache would make every configured
    // channel look deleted, wiping "gone" AND "c1" out of config.
    expect(setConfigCalls).toHaveLength(0);
  });

  it('throttles a channel’s renames per CHANNEL (Redis NX/EX), independent of the per-guild refresh gate', async () => {
    const ch = fakeChannel('c1', 'Members: 0');
    const guild = fakeGuild([ch]);
    const { ctx, cfg } = buildCtx(guild, {
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });

    // Two direct calls to refreshGuildStats (bypassing the per-guild `statsLastKey` gate entirely) simulate the
    // periodic job landing right next to a manual `/statschannel refresh` — the per-CHANNEL budget must still
    // hold even though each call's own guild-level gate would otherwise allow it.
    const first = await refreshGuildStats(ctx, guild as never, cfg);
    expect(first.renamed).toBe(1);
    expect(ch.setName).toHaveBeenCalledTimes(1);

    guild.memberCount = 99; // the rendered name would differ again
    const second = await refreshGuildStats(ctx, guild as never, cfg);
    expect(second.renamed).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(ch.setName).toHaveBeenCalledTimes(1); // blocked by the per-channel budget, not called again
  });

  it('drops a missing channel from config without crashing', async () => {
    const ch = fakeChannel('c1', 'Members: 42');
    const guild = fakeGuild([ch]);
    const { ctx, setConfigCalls } = buildCtx(guild, {
      statsChannels: [
        { channelId: 'c1', template: 'Members: {members}' },
        { channelId: 'gone', template: 'Boosts: {boosts}' },
      ],
    });

    await statsRefreshJob.processor(ctx, {} as never);

    expect(setConfigCalls).toHaveLength(1);
    expect(setConfigCalls[0]).toEqual({
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });
  });

  it('skips guilds where the plugin is disabled or no stats channels are configured', async () => {
    const ch = fakeChannel('c1', 'Members: 0');
    const guild = fakeGuild([ch]);
    const none = buildCtx(guild, { statsChannels: [] });
    await statsRefreshJob.processor(none.ctx, {} as never);
    expect(ch.setName).not.toHaveBeenCalled();

    const disabled = createTestContext({
      enabled: false,
      config: configSchema.parse({ statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }] }),
      overrides: {
        client: {
          user: { id: 'bot-1' },
          guilds: { cache: new Map([[GUILD_ID, guild]]) },
        } as unknown as Client<true>,
      },
    });
    await statsRefreshJob.processor(disabled.ctx, {} as never);
    expect(ch.setName).not.toHaveBeenCalled();
  });

  it('never throws when a rename fails (50013 → missingPermission flag, other errors → skipped)', async () => {
    const noPerm = fakeChannel('c1', 'Members: 0', async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    });
    const flaky = fakeChannel('c2', 'Bots: 0', async () => {
      throw new Error('boom');
    });
    const guild = fakeGuild([noPerm, flaky]);
    const { ctx, cfg } = buildCtx(guild, {
      statsChannels: [
        { channelId: 'c1', template: 'Members: {members}' },
        { channelId: 'c2', template: 'Bots: {bots}' },
      ],
    });

    const result = await refreshGuildStats(ctx, guild as never, cfg);
    expect(result.missingPermission).toBe(true);
    expect(result.renamed).toBe(0);
    expect(result.unchanged).toBe(0);
    await expect(statsRefreshJob.processor(ctx, {} as never)).resolves.toBeUndefined();
  });

  it('declares the 5-minute repeat and concurrency 1', () => {
    expect(statsRefreshJob.name).toBe('stats-refresh');
    expect(statsRefreshJob.repeat).toEqual({ pattern: '*/5 * * * *' });
    expect(statsRefreshJob.concurrency).toBe(1);
  });
});

describe('stats channel rename throttling', () => {
  beforeEach(async () => {
    await new RedisMock().flushall();
  });

  function discordError(code: number, message: string, extra: Record<string, unknown> = {}) {
    return Object.assign(new Error(message), { code, ...extra });
  }

  /** Lets the next periodic tick run: clears the per-guild gate and the per-channel rename budgets. */
  async function expireGates(redis: { del: (...keys: string[]) => Promise<number> }, channelIds: string[]) {
    await redis.del(statsLastKey(GUILD_ID), ...channelIds.map((id) => statsChannelRenameKey(GUILD_ID, id)));
  }

  it('allows at most one rename per channel per 10 minutes and records when it happened', async () => {
    const ch = fakeChannel('c1', 'Members: 0');
    const guild = fakeGuild([ch]);
    const { ctx, cfg, redis } = buildCtx(guild, {
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });
    const now = new Date('2026-11-02T10:00:00Z');

    await refreshGuildStats(ctx, guild as never, cfg, now);
    expect(ch.setName).toHaveBeenCalledTimes(1);
    const key = statsChannelRenameKey(GUILD_ID, 'c1');
    expect(await redis.get(key)).toBe(now.toISOString());
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(9 * 60);
    expect(ttl).toBeLessThanOrEqual(10 * 60);
  });

  it('shares one per-channel budget between the periodic job and a manual refresh, in either order', async () => {
    const jobFirst = fakeChannel('c1', 'Members: 0');
    const guildA = fakeGuild([jobFirst]);
    const a = buildCtx(guildA, { statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }] });

    await statsRefreshJob.processor(a.ctx, {} as never);
    expect(jobFirst.setName).toHaveBeenCalledTimes(1);
    // An admin runs `/statschannel refresh` (it calls refreshGuildStats) right after, with a new count.
    guildA.memberCount = 50;
    const manual = await refreshGuildStats(a.ctx, guildA as never, a.cfg);
    expect(manual.renamed).toBe(0);
    expect(jobFirst.setName).toHaveBeenCalledTimes(1);

    await new RedisMock().flushall();
    const manualFirst = fakeChannel('c1', 'Members: 0');
    const guildB = fakeGuild([manualFirst]);
    const b = buildCtx(guildB, { statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }] });

    await refreshGuildStats(b.ctx, guildB as never, b.cfg);
    expect(manualFirst.setName).toHaveBeenCalledTimes(1);
    // The refresh also reset the per-guild gate, and even with that expired the channel budget still holds.
    guildB.memberCount = 50;
    await b.redis.del(statsLastKey(GUILD_ID));
    await statsRefreshJob.processor(b.ctx, {} as never);
    expect(manualFirst.setName).toHaveBeenCalledTimes(1);
  });

  it('skips a RateLimitError from discord.js and leaves the other channels to carry on', async () => {
    const limited = fakeChannel('c1', 'Members: 0', async () => {
      throw new RateLimitError({
        global: false,
        hash: 'h',
        limit: 2,
        majorParameter: 'c1',
        method: 'PATCH',
        retryAfter: 540_050,
        route: '/channels/:id',
        scope: 'shared',
        sublimitTimeout: 540_050,
        timeToReset: 540_050,
        url: 'https://discord.com/api/v10/channels/c1',
      });
    });
    const other = fakeChannel('c2', 'Bots: 0');
    const guild = fakeGuild([limited, other]);
    const { ctx, cfg, redis } = buildCtx(guild, {
      statsChannels: [
        { channelId: 'c1', template: 'Members: {members}' },
        { channelId: 'c2', template: 'Bots: {bots}' },
      ],
    });

    const result = await refreshGuildStats(ctx, guild as never, cfg);
    expect(result).toMatchObject({ renamed: 1, missingPermission: false });
    expect(other.setName).toHaveBeenCalledTimes(1);
    // Two minutes short of retry_after: still no second attempt on the limited channel.
    expect(await redis.ttl(statsChannelRenameKey(GUILD_ID, 'c1'))).toBeGreaterThan(530);
    await refreshGuildStats(ctx, guild as never, cfg);
    expect(limited.setName).toHaveBeenCalledTimes(1);
    expect(await redis.get(statsBlockedKey(GUILD_ID))).toBeNull();
  });

  it('makes no API call when the rendered name already matches', async () => {
    const ch = fakeChannel('c1', 'Members: 42');
    const guild = fakeGuild([ch]);
    const { ctx, cfg, redis } = buildCtx(guild, {
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });

    const result = await refreshGuildStats(ctx, guild as never, cfg);
    expect(result.unchanged).toBe(1);
    expect(ch.setName).not.toHaveBeenCalled();
    // An unchanged name doesn't spend the channel's rename budget either.
    expect(await redis.get(statsChannelRenameKey(GUILD_ID, 'c1'))).toBeNull();
  });

  it.each([
    [50001, 'Missing Access'],
    [50013, 'Missing Permissions'],
  ])('pauses the whole guild after a %i and warns once, naming the guild', async (code, message) => {
    const denied = fakeChannel('c1', 'Members: 0', async () => {
      throw discordError(code, message);
    });
    const other = fakeChannel('c2', 'Bots: 0');
    const guild = fakeGuild([denied, other]);
    const { ctx, redis } = buildCtx(guild, {
      statsChannels: [
        { channelId: 'c1', template: 'Members: {members}' },
        { channelId: 'c2', template: 'Bots: {bots}' },
      ],
    });
    const warn = vi.spyOn(ctx.logger, 'warn');
    const info = vi.spyOn(ctx.logger, 'info');

    await statsRefreshJob.processor(ctx, {} as never);
    expect(denied.setName).toHaveBeenCalledTimes(1);
    expect(other.setName).not.toHaveBeenCalled(); // no further calls in that guild once access is denied
    expect(await redis.get(statsBlockedKey(GUILD_ID))).toBeTruthy();

    // Several later ticks, with every throttle expired: still no API calls and no more log lines.
    for (let i = 0; i < 3; i++) {
      await expireGates(redis, ['c1', 'c2']);
      await statsRefreshJob.processor(ctx, {} as never);
    }
    expect(denied.setName).toHaveBeenCalledTimes(1);
    expect(other.setName).not.toHaveBeenCalled();

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, text] = warn.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      guildId: GUILD_ID,
      guildName: 'Test Guild',
      channelId: 'c1',
      code,
      message,
    });
    expect(text).toContain('Test Guild');
    expect(info).not.toHaveBeenCalled();
  });

  it("retries a paused guild once the bot's permissions change", async () => {
    let denied = true;
    const ch = fakeChannel('c1', 'Members: 0', async () => {
      if (denied) throw discordError(50001, 'Missing Access');
    });
    const guild = fakeGuild([ch]);
    const { ctx, redis } = buildCtx(guild, {
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });

    await statsRefreshJob.processor(ctx, {} as never);
    await expireGates(redis, ['c1']);
    await statsRefreshJob.processor(ctx, {} as never);
    expect(ch.setName).toHaveBeenCalledTimes(1);

    // An admin grants View Channel: the bot's computed permissions on the channel change.
    denied = false;
    ch.perms = 1024n | 16n;
    await expireGates(redis, ['c1']);
    await statsRefreshJob.processor(ctx, {} as never);
    expect(ch.setName).toHaveBeenCalledTimes(2);
    expect(ch.name).toBe('Members: 42');
    expect(await redis.get(statsBlockedKey(GUILD_ID))).toBeNull();
  });

  it('retries a paused guild once its stats config changes', async () => {
    const ch = fakeChannel('c1', 'Members: 0', async () => {
      throw discordError(50013, 'Missing Permissions');
    });
    const guild = fakeGuild([ch]);
    const { ctx, cfg, redis } = buildCtx(guild, {
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });
    const warn = vi.spyOn(ctx.logger, 'warn');

    await statsRefreshJob.processor(ctx, {} as never);
    expect(ch.setName).toHaveBeenCalledTimes(1);

    cfg.statsChannels = [{ channelId: 'c1', template: 'People: {members}' }];
    await expireGates(redis, ['c1']);
    await statsRefreshJob.processor(ctx, {} as never);
    expect(ch.setName).toHaveBeenCalledTimes(2);
    // Still denied after the change → a second (new) warning, then quiet again.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a manual refresh still tries a paused guild, and a success lifts the pause', async () => {
    let denied = true;
    const ch = fakeChannel('c1', 'Members: 0', async () => {
      if (denied) throw discordError(50013, 'Missing Permissions');
    });
    const guild = fakeGuild([ch]);
    const { ctx, cfg, redis } = buildCtx(guild, {
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });

    const first = await refreshGuildStats(ctx, guild as never, cfg);
    expect(first.missingPermission).toBe(true);
    expect(await redis.get(statsBlockedKey(GUILD_ID))).toBeTruthy();

    denied = false;
    await redis.del(statsChannelRenameKey(GUILD_ID, 'c1'));
    const second = await refreshGuildStats(ctx, guild as never, cfg);
    expect(second.renamed).toBe(1);
    expect(await redis.get(statsBlockedKey(GUILD_ID))).toBeNull();
  });

  it("respects Discord's retry_after on a 429 and doesn't retry early", async () => {
    const ch = fakeChannel('c1', 'Members: 0', async () => {
      throw Object.assign(new Error('You are being rate limited.'), {
        status: 429,
        code: 0,
        rawError: { message: 'You are being rate limited.', retry_after: 1500, code: 0 },
      });
    });
    const guild = fakeGuild([ch]);
    const { ctx, cfg, redis } = buildCtx(guild, {
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });
    const warn = vi.spyOn(ctx.logger, 'warn');

    await refreshGuildStats(ctx, guild as never, cfg);
    const ttl = await redis.ttl(statsChannelRenameKey(GUILD_ID, 'c1'));
    expect(ttl).toBeGreaterThan(1400);
    expect(ttl).toBeLessThanOrEqual(1500);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'c1', retryAfterMs: 1_500_000 }),
      expect.stringContaining('rate limited'),
    );

    // Next periodic tick (guild gate expired, channel budget NOT): no second API call.
    await redis.del(statsLastKey(GUILD_ID));
    await statsRefreshJob.processor(ctx, {} as never);
    expect(ch.setName).toHaveBeenCalledTimes(1);
    // Rate limits are transient — the guild is not paused.
    expect(await redis.get(statsBlockedKey(GUILD_ID))).toBeNull();
  });

  it('logs other failures at warn with the Discord code and message, never at info', async () => {
    const err = discordError(50035, 'Invalid Form Body');
    const ch = fakeChannel('c1', 'Members: 0', async () => {
      throw err;
    });
    const guild = fakeGuild([ch]);
    const { ctx, cfg } = buildCtx(guild, {
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });
    const warn = vi.spyOn(ctx.logger, 'warn');
    const info = vi.spyOn(ctx.logger, 'info');

    await refreshGuildStats(ctx, guild as never, cfg);
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: GUILD_ID, channelId: 'c1', code: 50035, err }),
      expect.stringContaining('Invalid Form Body'),
    );
  });
});

describe('rateLimitRetryAfterMs', () => {
  it('reads retry_after (seconds) from a raw 429 and retryAfter (ms) from a RateLimitError', () => {
    expect(rateLimitRetryAfterMs({ status: 429, rawError: { retry_after: 2.5 } })).toBe(2500);
    expect(rateLimitRetryAfterMs({ name: 'RateLimitError', retryAfter: 4000, sublimitTimeout: 0 })).toBe(
      4000,
    );
    expect(rateLimitRetryAfterMs({ retryAfter: 1000, sublimitTimeout: 540_000 })).toBe(540_000);
  });

  it('falls back to the full channel interval for a 429 without retry_after, and null for non-429s', () => {
    expect(rateLimitRetryAfterMs({ status: 429 })).toBe(10 * 60_000);
    expect(rateLimitRetryAfterMs({ status: 403, code: 50013 })).toBeNull();
    expect(rateLimitRetryAfterMs(new Error('boom'))).toBeNull();
    expect(rateLimitRetryAfterMs(undefined)).toBeNull();
  });
});
