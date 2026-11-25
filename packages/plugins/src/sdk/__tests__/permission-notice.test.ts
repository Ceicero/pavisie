import type { Client, Guild } from 'discord.js';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuildConfigStore } from '../config-store';
import {
  PERMISSION_NOTICE_WINDOW_MS,
  isMissingPermissions as exportedIsMissingPermissions,
  notifyMissingPermissions as exportedNotify,
} from '../index';
import {
  PERMISSION_NOTICE_WINDOW_MS as WINDOW_MS,
  isMissingPermissions,
  notifyMissingPermissions,
} from '../permission-notice';

const GUILD_POST = '100000000000000001';
const CHANNEL_POST = '200000000000000001';
const GUILD_LIMIT = '100000000000000002';
const CHANNEL_LIMIT = '200000000000000002';
const GUILD_SPLIT = '100000000000000011';
const CHANNEL_SPLIT = '200000000000000011';
const GUILD_OTHER = '100000000000000003';
const CHANNEL_OTHER = '200000000000000003';
const GUILD_WINDOW = '100000000000000004';
const CHANNEL_WINDOW = '200000000000000004';
const GUILD_CUSTOM = '100000000000000005';
const CHANNEL_CUSTOM = '200000000000000005';
const GUILD_NOLOG = '100000000000000006';
const CHANNEL_NOLOG = '200000000000000006';
const GUILD_DENIED = '100000000000000007';
const CHANNEL_DENIED = '200000000000000007';
const GUILD_DIRTY = '100000000000000008';
const CHANNEL_DIRTY = '200000000000000008';
const GUILD_FETCH = '100000000000000009';
const CHANNEL_FETCH = '200000000000000009';
const GUILD_CONFIG = '100000000000000010';

function notice(action: string): string {
  return `Pavisie is missing a Discord permission it needs for ${action}. Check the bot role's permissions and channel overrides.`;
}

function harness(opts: {
  guildId: string;
  channelId?: string | null;
  send?: (content: string) => Promise<unknown>;
  fetchImpl?: (channelId: string) => Promise<unknown>;
  getGuildConfig?: (guildId: string) => Promise<{ modLogChannelId: string | null }>;
}) {
  const send = vi.fn(opts.send ?? (async () => ({ id: 'message' })));
  const fetch = vi.fn(
    opts.fetchImpl ??
      (async (channelId: string) => {
        const configured = opts.channelId === undefined ? CHANNEL_POST : opts.channelId;
        if (!configured || channelId !== configured) return null;
        return {
          id: channelId,
          guildId: opts.guildId,
          isTextBased: () => true,
          isDMBased: () => false,
          send,
        };
      }),
  );
  const guild = { id: opts.guildId, channels: { fetch } } as unknown as Guild;
  const getGuildConfig = vi.fn(
    opts.getGuildConfig ??
      (async () => ({
        modLogChannelId: opts.channelId === undefined ? CHANNEL_POST : opts.channelId,
      })),
  );
  const configStore = { getGuildConfig } as unknown as Pick<GuildConfigStore, 'getGuildConfig'>;
  const debug = vi.fn();
  const logger = { debug } as unknown as Pick<Logger, 'debug'>;
  return { guild, send, fetch, configStore, logger, debug, getGuildConfig };
}

function loggedText(debug: ReturnType<typeof vi.fn>): string {
  return JSON.stringify(debug.mock.calls);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('notifyMissingPermissions', () => {
  it('posts one notice to the configured mod-log channel', async () => {
    const { guild, send, configStore, logger } = harness({
      guildId: GUILD_POST,
      channelId: CHANNEL_POST,
    });
    const client = {
      guilds: { cache: { get: (id: string) => (id === GUILD_POST ? guild : undefined) }, fetch: vi.fn() },
    } as unknown as Client;

    await notifyMissingPermissions({
      client,
      guildId: GUILD_POST,
      action: 'banning a member',
      configStore,
      logger,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(notice('banning a member'));
  });

  it('suppresses a second notice for the same guild and action within the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const { guild, send, configStore, logger } = harness({
      guildId: GUILD_LIMIT,
      channelId: CHANNEL_LIMIT,
    });

    await notifyMissingPermissions({
      guild,
      guildId: GUILD_LIMIT,
      action: 'banning a member',
      configStore,
      logger,
    });
    vi.setSystemTime(Date.UTC(2026, 0, 1) + WINDOW_MS - 1);
    await notifyMissingPermissions({
      guild,
      guildId: GUILD_LIMIT,
      action: 'banning a member',
      configStore,
      logger,
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('posts for a different action or a different guild within the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 0, 2));
    const first = harness({ guildId: GUILD_SPLIT, channelId: CHANNEL_SPLIT });
    const other = harness({ guildId: GUILD_OTHER, channelId: CHANNEL_OTHER });

    await notifyMissingPermissions({
      guild: first.guild,
      guildId: GUILD_SPLIT,
      action: 'banning a member',
      configStore: first.configStore,
      logger: first.logger,
    });
    await notifyMissingPermissions({
      guild: first.guild,
      guildId: GUILD_SPLIT,
      action: 'kicking a member',
      configStore: first.configStore,
      logger: first.logger,
    });
    await notifyMissingPermissions({
      guild: other.guild,
      guildId: GUILD_OTHER,
      action: 'banning a member',
      configStore: other.configStore,
      logger: other.logger,
    });

    expect(first.send).toHaveBeenCalledTimes(2);
    expect(first.send).toHaveBeenNthCalledWith(2, notice('kicking a member'));
    expect(other.send).toHaveBeenCalledTimes(1);
    expect(other.send).toHaveBeenCalledWith(notice('banning a member'));
  });

  it('posts again once the default window has elapsed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2026, 0, 3);
    vi.setSystemTime(start);
    const { guild, send, configStore, logger } = harness({
      guildId: GUILD_WINDOW,
      channelId: CHANNEL_WINDOW,
    });
    const input = {
      guild,
      guildId: GUILD_WINDOW,
      action: 'timing out a member',
      configStore,
      logger,
    };

    await notifyMissingPermissions(input);
    vi.setSystemTime(start + WINDOW_MS);
    await notifyMissingPermissions(input);

    expect(WINDOW_MS).toBe(60 * 60 * 1000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('honors a shorter windowMs than the default hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2026, 0, 4);
    vi.setSystemTime(start);
    const { guild, send, configStore, logger } = harness({
      guildId: GUILD_CUSTOM,
      channelId: CHANNEL_CUSTOM,
    });
    const input = {
      guild,
      guildId: GUILD_CUSTOM,
      action: 'locking a channel',
      configStore,
      logger,
      windowMs: 1_000,
    };

    await notifyMissingPermissions(input);
    vi.setSystemTime(start + 999);
    await notifyMissingPermissions(input);
    expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 1_000);
    await notifyMissingPermissions(input);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no mod-log channel is configured', async () => {
    const { guild, send, fetch, configStore, logger, debug } = harness({
      guildId: GUILD_NOLOG,
      channelId: null,
    });

    await expect(
      notifyMissingPermissions({
        guild,
        guildId: GUILD_NOLOG,
        action: 'banning a member',
        configStore,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
    expect(loggedText(debug)).not.toContain(GUILD_NOLOG);
    expect(loggedText(debug)).not.toContain(CHANNEL_NOLOG);
  });

  it('does not throw when the mod-log send rejects with code 50013', async () => {
    const discordError = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const { guild, send, configStore, logger, debug } = harness({
      guildId: GUILD_DENIED,
      channelId: CHANNEL_DENIED,
      send: async () => {
        throw discordError;
      },
    });

    await expect(
      notifyMissingPermissions({
        guild,
        guildId: GUILD_DENIED,
        action: 'deleting a message',
        configStore,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(isMissingPermissions(discordError)).toBe(true);
    const logged = loggedText(debug);
    expect(logged).not.toContain(GUILD_DENIED);
    expect(logged).not.toContain(CHANNEL_DENIED);
    expect(logged).not.toContain('Missing Permissions');
    expect(logged).not.toContain('50013');
  });

  it('keeps guild ids, channel ids, and raw errors out of the notice', async () => {
    const { guild, send, configStore, logger, debug } = harness({
      guildId: GUILD_DIRTY,
      channelId: CHANNEL_DIRTY,
    });

    await notifyMissingPermissions({
      guild,
      guildId: GUILD_DIRTY,
      action: `banning a member ${GUILD_DIRTY} ${CHANNEL_DIRTY}\nError: Missing Permissions\n    at Object.<anonymous> (mod.ts:1:1)`,
      configStore,
      logger,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const content = send.mock.calls[0]?.[0];
    expect(typeof content).toBe('string');
    expect(content).toBe(notice('banning a member'));
    expect(content).not.toContain(GUILD_DIRTY);
    expect(content).not.toContain(CHANNEL_DIRTY);
    expect(loggedText(debug)).not.toContain(GUILD_DIRTY);
    expect(loggedText(debug)).not.toContain(CHANNEL_DIRTY);
  });

  it('does not throw when the mod-log channel cannot be fetched', async () => {
    const { guild, send, configStore, logger, debug } = harness({
      guildId: GUILD_FETCH,
      channelId: CHANNEL_FETCH,
      fetchImpl: async () => {
        throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
      },
    });

    await expect(
      notifyMissingPermissions({
        guild,
        guildId: GUILD_FETCH,
        action: 'moving a member',
        configStore,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(loggedText(debug)).not.toContain(GUILD_FETCH);
    expect(loggedText(debug)).not.toContain(CHANNEL_FETCH);
    expect(loggedText(debug)).not.toContain('Unknown Channel');
  });

  it('does not throw when guild config lookup fails', async () => {
    const { guild, send, configStore, logger, debug } = harness({
      guildId: GUILD_CONFIG,
      getGuildConfig: async () => {
        throw new Error(`database down for ${GUILD_CONFIG}`);
      },
    });

    await expect(
      notifyMissingPermissions({
        guild,
        guildId: GUILD_CONFIG,
        action: 'banning a member',
        configStore,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(loggedText(debug)).not.toContain(GUILD_CONFIG);
  });
});

describe('isMissingPermissions', () => {
  it('matches only a Discord missing-permissions failure', () => {
    expect(isMissingPermissions({ code: 50013 })).toBe(true);
    expect(isMissingPermissions({ code: '50013' })).toBe(true);
    expect(isMissingPermissions(Object.assign(new Error('Missing Permissions'), { code: 50013 }))).toBe(true);
    expect(isMissingPermissions({ code: 50001 })).toBe(false);
    expect(isMissingPermissions(new Error('socket hang up'))).toBe(false);
    expect(isMissingPermissions(null)).toBe(false);
  });
});

describe('sdk barrel', () => {
  it('re-exports the permission notice helper', () => {
    expect(exportedNotify).toBe(notifyMissingPermissions);
    expect(exportedIsMissingPermissions).toBe(isMissingPermissions);
    expect(PERMISSION_NOTICE_WINDOW_MS).toBe(WINDOW_MS);
  });
});
