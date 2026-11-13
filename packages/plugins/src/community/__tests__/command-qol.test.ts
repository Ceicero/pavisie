import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { createTestContext, type RecordedPrismaCall } from '../../sdk/testing';
import type { CommandContext, PluginContext } from '../../sdk';
import { configSchema } from '../manifest';
import { command as announceCommand } from '../commands/announce';
import { command as eventCommand } from '../commands/event';
import { command as giveawayCommand } from '../commands/giveaway';
import { command as pollCommand } from '../commands/poll';
import { command as remindCommand } from '../commands/remind';
import { command as suggestCommand } from '../commands/suggest';
import { command as suggestionsCommand } from '../commands/suggestions';
import en from '../locales/en.json';

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
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

type OptValue = string | number | boolean | null;

function replyText(replies: { embeds?: EmbedBuilder[] }[]): string {
  return replies[0]?.embeds?.[0]?.data.description ?? '';
}

function textGuild(send: () => Promise<unknown>) {
  const channel = {
    id: 'ch1',
    name: 'general',
    type: 0,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn(send),
    messages: { delete: vi.fn(async () => undefined) },
  };
  const guild = {
    id: 'guild-1',
    name: 'Test',
    channels: { fetch: async (id: string) => (id === 'ch1' ? channel : null) },
    members: { me: { id: 'bot' } },
    scheduledEvents: {
      create: vi.fn(async () => {
        throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      }),
      delete: vi.fn(async () => undefined),
    },
  };
  return { guild, channel };
}

function harness(opts: {
  sub: string;
  values?: Record<string, OptValue>;
  channelId?: string;
  config?: unknown;
  prismaOverrides?: Parameters<typeof createTestContext>[0] extends infer T
    ? T extends { prismaOverrides?: infer P }
      ? P
      : never
    : never;
  queueAdd?: () => Promise<unknown>;
  guild?: ReturnType<typeof textGuild>['guild'];
}) {
  const replies: { embeds?: EmbedBuilder[]; ephemeral?: boolean }[] = [];
  const jobs: string[] = [];
  const { ctx, prismaCalls } = createTestContext({
    config: opts.config ?? configSchema.parse({}),
    prismaOverrides: opts.prismaOverrides,
    overrides: {
      queue: () =>
        ({
          add: async () => {
            jobs.push('add');
            if (opts.queueAdd) await opts.queueAdd();
          },
          upsertJobScheduler: async () => {
            jobs.push('sched');
          },
        }) as unknown as ReturnType<PluginContext['queue']>,
    },
  });
  const values = opts.values ?? {};
  const interaction = {
    user: { id: 'user-1' },
    guild: opts.guild ?? { id: 'guild-1', channels: { fetch: async () => null }, members: { me: null } },
    channelId: 'ch1',
    options: {
      getSubcommand: () => opts.sub,
      getString: (name: string) => (typeof values[name] === 'string' ? values[name] : null),
      getInteger: (name: string) => (typeof values[name] === 'number' ? values[name] : null),
      getBoolean: (name: string) => (typeof values[name] === 'boolean' ? values[name] : null),
      getChannel: () => (opts.channelId ? { id: opts.channelId } : null),
      getRole: () => null,
    },
    reply: vi.fn(async (payload: { embeds?: EmbedBuilder[]; ephemeral?: boolean }) => {
      replies.push(payload);
    }),
  };
  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: 'guild-1',
    staffLevel: 'admin',
    locale: 'en-US' as never,
    t: realT,
    config: async <T>() => (opts.config ?? configSchema.parse({})) as T,
  };
  return { c, replies, prismaCalls, jobs };
}

function deleted(calls: RecordedPrismaCall[], model: string): boolean {
  return calls.some((call) => call.model === model && call.method === 'delete');
}

function created(calls: RecordedPrismaCall[], model: string): boolean {
  return calls.some((call) => call.model === model && call.method === 'create');
}

const giveawayRow = {
  id: 'gw1',
  prize: 'Nitro',
  winnerCount: 1,
  ended: false,
  endsAt: new Date(Date.now() + 3_600_000),
  hostId: 'user-1',
  requiredRoleIds: [] as string[],
  winnerIds: [] as string[],
  minAccountAgeDays: null,
  minLevel: null,
};

const suggestionRow = {
  id: 's1',
  number: 1,
  content: 'add cats',
  authorId: 'user-1',
  status: 'PENDING',
  upvotes: 0,
  downvotes: 0,
  staffNote: null,
};

describe('community command quality of life', () => {
  it('rejects a blank giveaway prize and an out-of-range duration', async () => {
    const blank = harness({ sub: 'start', values: { prize: '   ', duration: '1h' } });
    await giveawayCommand.execute(blank.c);
    expect(replyText(blank.replies)).toContain(realT('giveaway.emptyPrize'));
    expect(blank.replies[0]?.ephemeral).toBe(true);
    expect(created(blank.prismaCalls, 'giveaway')).toBe(false);

    const short = harness({ sub: 'start', values: { prize: 'Nitro', duration: '10s' } });
    await giveawayCommand.execute(short.c);
    expect(replyText(short.replies)).toContain(realT('giveaway.durationRange'));
    expect(created(short.prismaCalls, 'giveaway')).toBe(false);
  });

  it('deletes the giveaway row and explains a channel post failure', async () => {
    const { guild } = textGuild(async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    });
    const { c, replies, prismaCalls, jobs } = harness({
      sub: 'start',
      values: { prize: 'Nitro', duration: '1h' },
      guild,
      prismaOverrides: { giveaway: { create: async () => giveawayRow } },
    });
    await giveawayCommand.execute(c);
    expect(replyText(replies)).toContain(realT('giveaway.badChannel'));
    expect(replies[0]?.ephemeral).toBe(true);
    expect(deleted(prismaCalls, 'giveaway')).toBe(true);
    expect(jobs).toEqual([]);
  });

  it('uses a helpful empty state for /giveaway list', async () => {
    const { c, replies } = harness({ sub: 'list' });
    await giveawayCommand.execute(c);
    expect(replyText(replies)).toContain(realT('giveaway.listEmpty'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('rejects an empty poll question, duplicate options, and a too-short duration', async () => {
    const empty = harness({ sub: 'create', values: { question: '  ', option1: 'A', option2: 'B' } });
    await pollCommand.execute(empty.c);
    expect(replyText(empty.replies)).toContain(realT('poll.emptyQuestion'));
    expect(created(empty.prismaCalls, 'poll')).toBe(false);

    const dup = harness({ sub: 'create', values: { question: 'Food?', option1: 'Yes', option2: 'yes' } });
    await pollCommand.execute(dup.c);
    expect(replyText(dup.replies)).toContain('Yes, yes');
    expect(dup.replies[0]?.ephemeral).toBe(true);
    expect(created(dup.prismaCalls, 'poll')).toBe(false);

    const short = harness({
      sub: 'create',
      values: { question: 'Food?', option1: 'Yes', option2: 'No', duration: '5s' },
    });
    await pollCommand.execute(short.c);
    expect(replyText(short.replies)).toContain(realT('poll.durationRange'));
  });

  it('keeps anonymous poll results ephemeral', async () => {
    const poll = {
      id: 'poll1',
      question: 'Food?',
      anonymous: true,
      closed: false,
      multiSelect: false,
      endsAt: null,
      options: [{ id: 'o1', label: 'Yes', position: 0 }],
      votes: [],
    };
    const hidden = harness({
      sub: 'results',
      values: { id: 'poll1' },
      prismaOverrides: { poll: { findFirst: async () => poll } },
    });
    await pollCommand.execute(hidden.c);
    expect(hidden.replies[0]?.ephemeral).toBe(true);

    const visible = harness({
      sub: 'results',
      values: { id: 'poll1' },
      prismaOverrides: { poll: { findFirst: async () => ({ ...poll, anonymous: false }) } },
    });
    await pollCommand.execute(visible.c);
    expect(visible.replies[0]?.ephemeral).toBe(false);
  });

  it('rejects an event that already started or ends before it starts', async () => {
    const past = harness({ sub: 'create', values: { title: 'Launch', 'starts-at': '2000-01-01T00:00:00Z' } });
    await eventCommand.execute(past.c);
    expect(replyText(past.replies)).toContain(realT('event.past'));
    expect(past.replies[0]?.ephemeral).toBe(true);
    expect(created(past.prismaCalls, 'communityEvent')).toBe(false);

    const backwards = harness({
      sub: 'create',
      values: { title: '  Game night  ', 'starts-at': '2h', 'ends-at': '30m' },
    });
    await eventCommand.execute(backwards.c);
    expect(replyText(backwards.replies)).toContain(realT('event.endsBeforeStart'));
    expect(created(backwards.prismaCalls, 'communityEvent')).toBe(false);
  });

  it('removes a half-posted event when the channel send fails', async () => {
    const { guild, channel } = textGuild(async () => {
      throw new Error('boom');
    });
    const eventRow = {
      id: 'ev1',
      title: 'Game night',
      description: null,
      startsAt: new Date(Date.now() + 3 * 3_600_000),
      endsAt: null,
      hostId: 'user-1',
    };
    const { c, replies, prismaCalls, jobs } = harness({
      sub: 'create',
      values: { title: 'Game night', 'starts-at': '3h' },
      guild,
      prismaOverrides: {
        communityEvent: {
          create: async () => eventRow,
          update: async () => eventRow,
        },
      },
    });
    await eventCommand.execute(c);
    expect(replyText(replies)).toContain(realT('event.postFailed'));
    expect(replies[0]?.ephemeral).toBe(true);
    expect(deleted(prismaCalls, 'communityEvent')).toBe(true);
    expect(channel.messages.delete).not.toHaveBeenCalled();
    expect(jobs).toEqual([]);
  });

  it('tells the admin when the native Discord event was rejected', async () => {
    const { guild } = textGuild(async () => ({ id: 'msg1' }));
    const eventRow = {
      id: 'ev1',
      title: 'Game night',
      description: null,
      startsAt: new Date(Date.now() + 3 * 3_600_000),
      endsAt: null,
      hostId: 'user-1',
    };
    const { c, replies } = harness({
      sub: 'create',
      values: { title: 'Game night', 'starts-at': '3h', 'create-discord-event': true },
      guild,
      prismaOverrides: {
        communityEvent: {
          create: async () => eventRow,
          update: async () => eventRow,
        },
      },
    });
    await eventCommand.execute(c);
    expect(replyText(replies)).toContain(realT('event.discordEventFailed'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('uses a helpful empty state for /event list', async () => {
    const { c, replies } = harness({ sub: 'list' });
    await eventCommand.execute(c);
    expect(replyText(replies)).toContain(realT('event.listEmpty'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('rejects a past one-off reminder and explains a save failure', async () => {
    const past = harness({ sub: 'set', values: { when: '2000-01-01T00:00:00Z', message: '  ping  ' } });
    await remindCommand.execute(past.c);
    expect(replyText(past.replies)).toContain(realT('remind.past'));
    expect(created(past.prismaCalls, 'reminder')).toBe(false);

    const blank = harness({ sub: 'set', values: { when: '1h', message: '   ' } });
    await remindCommand.execute(blank.c);
    expect(replyText(blank.replies)).toContain(realT('remind.emptyMessage'));

    const failed = harness({
      sub: 'set',
      values: { when: '1h', message: 'ping' },
      prismaOverrides: { reminder: { create: async () => ({ id: 'r1' }) } },
      queueAdd: async () => {
        throw new Error('queue down');
      },
    });
    await remindCommand.execute(failed.c);
    expect(replyText(failed.replies)).toContain(realT('remind.saveFailed'));
    expect(failed.replies[0]?.ephemeral).toBe(true);
    expect(deleted(failed.prismaCalls, 'reminder')).toBe(true);
  });

  it('uses a helpful empty state for /remind list', async () => {
    const { c, replies } = harness({ sub: 'list' });
    await remindCommand.execute(c);
    expect(replyText(replies)).toContain(realT('remind.listEmpty'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('rejects a past announcement and rolls back a failed schedule', async () => {
    const past = harness({
      sub: 'schedule',
      values: { when: '2000-01-01T00:00:00Z', message: 'hello' },
      channelId: 'ch1',
    });
    await announceCommand.execute(past.c);
    expect(replyText(past.replies)).toContain(realT('announce.past'));
    expect(past.replies[0]?.ephemeral).toBe(true);
    expect(created(past.prismaCalls, 'scheduledAnnouncement')).toBe(false);

    const { guild } = textGuild(async () => ({ id: 'msg1' }));
    const failed = harness({
      sub: 'schedule',
      values: { when: '2h', message: 'hello' },
      channelId: 'ch1',
      guild,
      prismaOverrides: { scheduledAnnouncement: { create: async () => ({ id: 'a1' }) } },
      queueAdd: async () => {
        throw new Error('queue down');
      },
    });
    await announceCommand.execute(failed.c);
    expect(replyText(failed.replies)).toContain(realT('announce.scheduleFailed'));
    expect(deleted(failed.prismaCalls, 'scheduledAnnouncement')).toBe(true);
  });

  it('uses a helpful empty state for /announce list', async () => {
    const { c, replies } = harness({ sub: 'list' });
    await announceCommand.execute(c);
    expect(replyText(replies)).toContain(realT('announce.listEmpty'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('rejects an empty suggestion and removes the row when posting fails', async () => {
    const cfg = configSchema.parse({ suggestions: { channelId: 'ch1' } });
    const empty = harness({ sub: 'ignored', values: { text: '   ' }, config: cfg });
    await suggestCommand.execute(empty.c);
    expect(replyText(empty.replies)).toContain(realT('suggest.empty'));
    expect(empty.replies[0]?.ephemeral).toBe(true);

    const { guild } = textGuild(async () => {
      throw new Error('cannot send');
    });
    const failed = harness({
      sub: 'ignored',
      values: { text: 'add cats' },
      config: cfg,
      guild,
      prismaOverrides: {
        suggestion: {
          aggregate: async () => ({ _max: { number: 0 } }),
          create: async () => suggestionRow,
        },
      },
    });
    await suggestCommand.execute(failed.c);
    expect(replyText(failed.replies)).toContain(realT('suggest.postFailed'));
    expect(failed.replies[0]?.ephemeral).toBe(true);
    expect(deleted(failed.prismaCalls, 'suggestion')).toBe(true);
  });

  it('uses a helpful empty state for /suggestions list, including a status filter', async () => {
    const all = harness({ sub: 'list' });
    await suggestionsCommand.execute(all.c);
    expect(replyText(all.replies)).toContain(realT('suggestions.listEmpty'));
    expect(all.replies[0]?.ephemeral).toBe(true);

    const filtered = harness({ sub: 'list', values: { status: 'APPROVED' } });
    await suggestionsCommand.execute(filtered.c);
    expect(replyText(filtered.replies)).toContain(
      realT('suggestions.listEmptyFiltered', { status: 'APPROVED' }),
    );
    expect(filtered.replies[0]?.ephemeral).toBe(true);
  });
});
