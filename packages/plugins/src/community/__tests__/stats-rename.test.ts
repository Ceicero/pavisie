import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitError, REST, Routes } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import RedisMock from 'ioredis-mock';
import { createTestContext } from '../../sdk/testing';
import type { CommandContext } from '../../sdk';
import { configSchema } from '../manifest';
import { command as statsChannelCommand } from '../commands/statschannel';
import {
  rejectStatsRenameRateLimit,
  renameStatsChannel,
  statsChannelRenameKey,
  statsRenameRest,
  type StatsRenameChannel,
} from '../stats-rename';

const GUILD_ID = 'guild-1';

function rateLimitError(): RateLimitError {
  return new RateLimitError({
    timeToReset: 600_000,
    limit: 2,
    method: 'PATCH',
    hash: 'hash',
    url: 'https://discord.com/api/v10/channels/123',
    route: '/channels/:id',
    majorParameter: '123',
    global: false,
    retryAfter: 600_000,
    sublimitTimeout: 600_000,
    scope: 'user',
  });
}

function channel(partial: Partial<StatsRenameChannel> & Pick<StatsRenameChannel, 'id' | 'name'>): StatsRenameChannel {
  return {
    setName: vi.fn(async (next: string) => {
      partial.name = next;
    }),
    ...partial,
  };
}

describe('renameStatsChannel', () => {
  beforeEach(async () => {
    await new RedisMock().flushall();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a REST client that rejects rate limits instead of queueing them', () => {
    const rest = statsRenameRest('token-filter');
    expect(rest.options.rejectOnRateLimit).toBe(rejectStatsRenameRateLimit);
    expect(rejectStatsRenameRateLimit()).toBe(true);
  });

  it('skips an unchanged name without calling Discord or taking the budget', async () => {
    const { redis } = createTestContext();
    const ch = channel({ id: 'c1', name: 'Members: 1' });
    const result = await renameStatsChannel(redis, GUILD_ID, ch, 'Members: 1');
    expect(result.status).toBe('unchanged');
    expect(ch.setName).not.toHaveBeenCalled();
    expect(await redis.get(statsChannelRenameKey(GUILD_ID, 'c1'))).toBeNull();
  });

  it('patches through the rejecting REST client and does not call setName when a token is present', async () => {
    const patch = vi.spyOn(REST.prototype, 'patch').mockResolvedValue({});
    const { redis } = createTestContext();
    const setName = vi.fn(() => new Promise(() => undefined));
    const ch = channel({ id: '123', name: 'old', setName, client: { token: 'bot-token-success' } });

    const result = await renameStatsChannel(redis, GUILD_ID, ch, 'Members: 1');

    expect(result.status).toBe('renamed');
    expect(setName).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(Routes.channel('123'), {
      body: { name: 'Members: 1' },
      reason: 'Server stats',
    });
  });

  it('returns rate_limited after one attempt and does not wait for another', async () => {
    const patch = vi.spyOn(REST.prototype, 'patch').mockRejectedValue(rateLimitError());
    const { redis } = createTestContext();
    const setName = vi.fn(() => new Promise(() => undefined));
    const ch = channel({ id: '123', name: 'old', setName, client: { token: 'bot-token-limited' } });

    const first = await renameStatsChannel(redis, GUILD_ID, ch, 'Members: 2');
    const second = await renameStatsChannel(redis, GUILD_ID, ch, 'Members: 3');

    expect(first.status).toBe('rate_limited');
    expect(second.status).toBe('throttled');
    expect(patch).toHaveBeenCalledTimes(1);
    expect(setName).not.toHaveBeenCalled();
  });

  it('reports missing permissions without a second attempt', async () => {
    const patch = vi.spyOn(REST.prototype, 'patch').mockRejectedValue(
      Object.assign(new Error('Missing Permissions'), { code: 50013 }),
    );
    const { redis } = createTestContext();
    const ch = channel({ id: '123', name: 'old', client: { token: 'bot-token-perms' } });

    const result = await renameStatsChannel(redis, GUILD_ID, ch, 'Members: 4');
    expect(result.status).toBe('missing_permission');
    expect(patch).toHaveBeenCalledTimes(1);
  });
});

describe('/statschannel refresh', () => {
  beforeEach(async () => {
    await new RedisMock().flushall();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finishes when Discord rate-limits the rename instead of waiting on setName', async () => {
    const patch = vi.spyOn(REST.prototype, 'patch').mockRejectedValue(rateLimitError());
    const setName = vi.fn(() => new Promise(() => undefined));
    const statsChannel = {
      id: 'c1',
      name: 'Members: 0',
      setName,
      client: { token: 'bot-token-command' },
    };
    const guild = {
      id: GUILD_ID,
      available: true,
      memberCount: 10,
      members: { cache: { filter: () => ({ size: 0 }) } },
      premiumSubscriptionCount: 0,
      roles: { cache: { size: 1 } },
      channels: { cache: { size: 1, get: (id: string) => (id === 'c1' ? statsChannel : undefined) } },
    };
    const cfg = configSchema.parse({
      statsChannels: [{ channelId: 'c1', template: 'Members: {members}' }],
    });
    const { ctx } = createTestContext({ config: cfg });
    const edits: unknown[] = [];
    const interaction = {
      user: { id: 'admin-1' },
      guild,
      options: { getSubcommand: () => 'refresh' },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async (payload: unknown) => {
        edits.push(payload);
      }),
      reply: vi.fn(async () => undefined),
    };
    const c: CommandContext = {
      interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
      ctx,
      guildId: GUILD_ID,
      staffLevel: 'admin',
      locale: 'en-US' as never,
      t: (key) => key,
      config: async <T>() => cfg as T,
    };

    await statsChannelCommand.execute(c);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(edits).toHaveLength(1);
    expect(setName).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(1);
  });
});
