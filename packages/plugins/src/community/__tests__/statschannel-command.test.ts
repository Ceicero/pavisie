import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { createTestContext } from '../../sdk/testing';
import type { CommandContext } from '../../sdk';
import { command as statsChannelCommand } from '../commands/statschannel';
import { configSchema } from '../manifest';
import { statsChannelRenameKey } from '../stats-rename';
import en from '../locales/en.json';

/** Looks a dotted key up in the plugin's real `en.json` with `{var}` interpolation (same stand-in as ai/__tests__/mod-assist.test.ts). */
function realT(key: string, vars?: Record<string, string | number>): string {
  const parts = key.split('.');
  let node: unknown = en;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  if (typeof node !== 'string') return key;
  let out = node;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}

interface FakeOptions {
  sub: string;
  template?: string;
  channelId?: string;
  kind?: string | null;
}

function buildCommandContext(opts: FakeOptions, statsChannels: { channelId: string; template: string }[]) {
  const replies: { embeds?: EmbedBuilder[]; ephemeral?: boolean }[] = [];
  const createdChannels: unknown[] = [];
  const setConfigCalls: unknown[] = [];

  const guild = {
    id: 'guild-1',
    memberCount: 10,
    members: { cache: { filter: () => ({ size: 1 }), size: 10 } },
    premiumSubscriptionCount: 0,
    roles: { cache: { size: 2 }, everyone: { id: 'guild-1' } },
    channels: {
      cache: { size: 3, get: () => undefined },
      create: vi.fn(async (payload: unknown) => {
        createdChannels.push(payload);
        return { id: 'new-channel', name: 'x' };
      }),
    },
  };

  const interaction = {
    user: { id: 'admin-1' },
    guild,
    options: {
      getSubcommand: () => opts.sub,
      getString: (name: string) => {
        if (name === 'template') return opts.template ?? null;
        if (name === 'kind') return opts.kind ?? null;
        return null;
      },
      getChannel: (name: string) => (name === 'channel' && opts.channelId ? { id: opts.channelId } : null),
      getInteger: () => null,
    },
    reply: vi.fn(async (payload: { embeds?: EmbedBuilder[]; ephemeral?: boolean }) => {
      replies.push(payload);
    }),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };

  const cfg = configSchema.parse({ statsChannels });
  const { ctx } = createTestContext({
    config: cfg,
    overrides: {
      setConfig: async <T>(_guildId: string, patch: Partial<T>) => {
        setConfigCalls.push(patch);
        return { ...cfg, ...patch } as T;
      },
    },
  });

  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: 'guild-1',
    staffLevel: 'admin',
    locale: 'en-US' as never,
    t: realT,
    config: async <T>() => cfg as T,
  };

  return { c, replies, createdChannels, setConfigCalls };
}

function firstReplyText(replies: { embeds?: EmbedBuilder[] }[]): string {
  return replies[0]?.embeds?.[0]?.data.description ?? '';
}

describe('/statschannel', () => {
  it('rejects {online} with the Presence-intent explanation and creates nothing', async () => {
    const { c, replies, createdChannels } = buildCommandContext(
      { sub: 'create', template: 'Online: {online}' },
      [],
    );
    await statsChannelCommand.execute(c);
    expect(createdChannels).toHaveLength(0);
    expect(firstReplyText(replies)).toContain('Presence privileged intent');
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('rejects unknown tokens naming them', async () => {
    const { c, replies, createdChannels } = buildCommandContext(
      { sub: 'create', template: 'Members: {memebrs}' },
      [],
    );
    await statsChannelCommand.execute(c);
    expect(createdChannels).toHaveLength(0);
    expect(firstReplyText(replies)).toContain('{memebrs}');
    expect(firstReplyText(replies)).toContain('{members}');
  });

  it('refuses an 11th entry with the limit error', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      channelId: `c${i}`,
      template: 'Members: {members}',
    }));
    const { c, replies, createdChannels } = buildCommandContext(
      { sub: 'create', template: 'Bots: {bots}' },
      ten,
    );
    await statsChannelCommand.execute(c);
    expect(createdChannels).toHaveLength(0);
    expect(firstReplyText(replies)).toContain(realT('statschannel.limit', { max: 10 }));
  });

  it('creates a locked voice channel named from the rendered template and stores it in config', async () => {
    const { c, replies, createdChannels, setConfigCalls } = buildCommandContext(
      { sub: 'create', template: 'Members: {members}' },
      [],
    );
    await statsChannelCommand.execute(c);
    expect(createdChannels).toHaveLength(1);
    const payload = createdChannels[0] as { name: string; type: number; permissionOverwrites: unknown[] };
    expect(payload.name).toBe('Members: 10');
    expect(payload.type).toBe(2); // GuildVoice
    expect(payload.permissionOverwrites).toHaveLength(1);
    expect(setConfigCalls[0]).toEqual({
      statsChannels: [{ channelId: 'new-channel', template: 'Members: {members}' }],
    });
    expect(firstReplyText(replies)).toContain('<#new-channel>');
  });

  it('remove only touches config (never deletes the channel)', async () => {
    const { c, replies, setConfigCalls } = buildCommandContext({ sub: 'remove', channelId: 'c1' }, [
      { channelId: 'c1', template: 'Members: {members}' },
    ]);
    await statsChannelCommand.execute(c);
    expect(setConfigCalls[0]).toEqual({ statsChannels: [] });
    expect(firstReplyText(replies)).toContain('was not deleted');
  });

  describe('refresh', () => {
    // ioredis-mock instances share one in-memory store per process.
    beforeEach(async () => {
      await new RedisMock().flushall();
    });

    function withStatsChannel(name: string) {
      const built = buildCommandContext({ sub: 'refresh' }, [
        { channelId: 'c1', template: 'Members: {members}' },
      ]);
      const channel = { id: 'c1', name, setName: vi.fn(async () => channel) };
      Object.assign(built.c.interaction.guild.channels.cache, {
        get: (id: string) => (id === 'c1' ? channel : undefined),
      });
      return { ...built, channel };
    }

    it('renames a stale channel and records the rename in the channel’s Redis throttle', async () => {
      const { c, channel } = withStatsChannel('Members: 0');
      await statsChannelCommand.execute(c);
      expect(channel.setName).toHaveBeenCalledWith('Members: 10', 'Server stats');
      expect(await c.ctx.redis.ttl(statsChannelRenameKey('guild-1', 'c1'))).toBeGreaterThan(9 * 60);
    });

    it('does not rename a channel the job (or an earlier refresh) renamed under 10 minutes ago', async () => {
      const { c, channel } = withStatsChannel('Members: 0');
      // What the periodic job leaves behind after renaming this channel; the per-guild refresh gate has expired.
      await c.ctx.redis.set(statsChannelRenameKey('guild-1', 'c1'), new Date().toISOString(), 'EX', 7 * 60);

      await statsChannelCommand.execute(c);
      expect(channel.setName).not.toHaveBeenCalled();
      expect(c.interaction.editReply).toHaveBeenCalledTimes(1);
    });
  });

  it('is admin-only and requires Manage Channels from the bot', () => {
    expect(statsChannelCommand.requirement?.staffLevel).toBe('admin');
    expect(statsChannelCommand.requirement?.botPermissions).toHaveLength(1);
    expect(statsChannelCommand.data.name).toBe('statschannel');
  });
});
