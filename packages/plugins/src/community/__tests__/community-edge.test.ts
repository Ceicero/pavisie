import type { Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { CommunityEvent, Giveaway, Poll, Reminder, Suggestion } from '@pavisie/database';
import { createTestContext, type PrismaStubOverrides } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import {
  closePoll,
  deliverReminder,
  finalizeGiveaway,
  fireEventReminder,
  rerollGiveaway,
  syncSuggestionMessage,
} from '../actions';
import { catchUpCommunitySchedules } from '../jobs/community-catchup';
import { reminderSweepJob } from '../jobs/reminder-sweep';
import { buildPollEmbed } from '../render';

function discordError(code: number): Error {
  return Object.assign(new Error(`Discord ${code}`), { code });
}

interface ChannelOpts {
  fetchChannel?: () => Promise<unknown>;
  fetchMessage?: () => Promise<{ edit: () => Promise<void> }>;
  send?: (payload: unknown) => Promise<unknown>;
  deleteMessage?: (id: string) => Promise<void>;
  fetchMember?: (id: string) => Promise<unknown>;
}

function fakeGuild(opts: ChannelOpts = {}) {
  const sent: unknown[] = [];
  const deleted: string[] = [];
  const channel = {
    id: 'ch1',
    type: 0,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn(async (payload: unknown) => {
      if (opts.send) return opts.send(payload);
      sent.push(payload);
      return { id: 'sent' };
    }),
    messages: {
      fetch: vi.fn(async () => {
        if (opts.fetchMessage) return opts.fetchMessage();
        return { edit: async () => undefined };
      }),
      delete: vi.fn(async (id: string) => {
        if (opts.deleteMessage) return opts.deleteMessage(id);
        deleted.push(id);
      }),
    },
  };
  const user = { id: 'user-1', send: vi.fn(async () => undefined) };
  const guild = {
    id: 'guild-1',
    name: 'Test',
    members: {
      me: { id: 'bot' },
      fetch: vi.fn(async (id: string) => {
        if (opts.fetchMember) return opts.fetchMember(id);
        return { id, user };
      }),
    },
    channels: {
      fetch: vi.fn(async () => {
        if (opts.fetchChannel) return opts.fetchChannel();
        return channel;
      }),
    },
  };
  return { guild: guild as unknown as Guild, channel, user, sent, deleted };
}

function withClient(guild: Guild, prismaOverrides: object, usersFetch?: (id: string) => Promise<unknown>) {
  const base = createTestContext({ prismaOverrides: prismaOverrides as PrismaStubOverrides });
  const ctx: PluginContext = {
    ...base.ctx,
    client: {
      guilds: { fetch: async () => guild },
      users: { fetch: usersFetch ?? (async () => ({ id: 'user-1', send: async () => undefined })) },
    } as unknown as PluginContext['client'],
  };
  return { ...base, ctx };
}

function giveaway(partial: Partial<Giveaway> & { entries?: { userId: string }[] }): Giveaway & {
  entries: { userId: string }[];
} {
  return {
    id: 'gw1',
    guildId: 'guild-1',
    channelId: 'ch1',
    messageId: 'msg1',
    prize: 'Nitro',
    winnerCount: 1,
    hostId: 'host',
    endsAt: new Date('2026-01-01T00:00:00Z'),
    ended: false,
    requiredRoleIds: [],
    minAccountAgeDays: null,
    minLevel: null,
    winnerIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    entries: [],
    ...partial,
  } as Giveaway & { entries: { userId: string }[] };
}

describe('giveaway draws', () => {
  it('ends a giveaway with no entrants and says nobody won', async () => {
    const row = giveaway({ entries: [] });
    const { guild, channel } = fakeGuild();
    const { ctx } = withClient(guild, {
      giveaway: {
        findUnique: async () => row,
        updateMany: async () => {
          row.ended = true;
          return { count: 1 };
        },
      },
    });
    const result = await finalizeGiveaway(ctx, row.id);
    expect(result?.ended).toBe(true);
    expect(result?.winnerIds).toEqual([]);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(channel.send.mock.calls[0]?.[0])).toContain('No valid entries');
  });

  it('draws the only entrant once and does not draw again on a second run', async () => {
    const row = giveaway({ id: 'gw-only', winnerCount: 3, entries: [{ userId: 'only' }, { userId: 'only' }] });
    const { guild, channel } = fakeGuild();
    const { ctx } = withClient(guild, {
      giveaway: {
        findUnique: async () => row,
        updateMany: async (args: { data?: { winnerIds?: string[] } }) => {
          row.ended = true;
          row.winnerIds = args.data?.winnerIds ?? [];
          return { count: 1 };
        },
      },
    });
    const first = await finalizeGiveaway(ctx, row.id);
    expect(first?.winnerIds).toEqual(['only']);
    const sends = channel.send.mock.calls.length;
    const second = await finalizeGiveaway(ctx, row.id);
    expect(second?.winnerIds).toEqual(['only']);
    expect(channel.send.mock.calls.length).toBe(sends);
  });

  it('announces winners that were drawn before a restart, without drawing new ones', async () => {
    const row = giveaway({
      id: 'gw-saved',
      ended: true,
      winnerIds: ['saved'],
      entries: [{ userId: 'saved' }, { userId: 'other' }],
    });
    const { guild, channel } = fakeGuild();
    let claims = 0;
    const { ctx } = withClient(guild, {
      giveaway: {
        findUnique: async () => row,
        updateMany: async () => {
          claims += 1;
          return { count: 0 };
        },
      },
    });
    const result = await finalizeGiveaway(ctx, row.id);
    expect(claims).toBe(0);
    expect(result?.winnerIds).toEqual(['saved']);
    expect(JSON.stringify(channel.send.mock.calls[0]?.[0])).toContain('<@saved>');
  });

  it('still finishes the draw when the original message or channel is gone', async () => {
    const missingMessage = giveaway({ id: 'gw-missing-message', entries: [{ userId: 'winner' }] });
    const goneMessage = fakeGuild({ fetchMessage: async () => Promise.reject(discordError(10008)) });
    const { ctx: messageCtx } = withClient(goneMessage.guild, {
      giveaway: {
        findUnique: async () => missingMessage,
        updateMany: async (args: { data?: { winnerIds?: string[] } }) => {
          missingMessage.ended = true;
          missingMessage.winnerIds = args.data?.winnerIds ?? [];
          return { count: 1 };
        },
      },
    });
    await expect(finalizeGiveaway(messageCtx, missingMessage.id)).resolves.toMatchObject({ ended: true });
    expect(goneMessage.channel.send).toHaveBeenCalled();

    const missingChannel = giveaway({ id: 'gw2', entries: [{ userId: 'winner' }] });
    const goneChannel = fakeGuild({ fetchChannel: async () => Promise.reject(discordError(10003)) });
    const { ctx: channelCtx } = withClient(goneChannel.guild, {
      giveaway: {
        findUnique: async () => missingChannel,
        updateMany: async (args: { data?: { winnerIds?: string[] } }) => {
          missingChannel.ended = true;
          missingChannel.winnerIds = args.data?.winnerIds ?? [];
          return { count: 1 };
        },
      },
    });
    await expect(finalizeGiveaway(channelCtx, missingChannel.id)).resolves.toMatchObject({ ended: true });
    expect(goneChannel.channel.send).not.toHaveBeenCalled();
    expect(goneChannel.guild.members.fetch).toHaveBeenCalled();
  });

  it('does not get stuck retrying when the channel rejects the announcement for missing permissions', async () => {
    const row = giveaway({ id: 'gw-denied', entries: [{ userId: 'winner' }] });
    const { guild, channel } = fakeGuild({
      send: async () => Promise.reject(discordError(50013)),
    });
    const { ctx } = withClient(guild, {
      giveaway: {
        findUnique: async () => row,
        updateMany: async (args: { data?: { winnerIds?: string[] } }) => {
          row.ended = true;
          row.winnerIds = args.data?.winnerIds ?? [];
          return { count: 1 };
        },
      },
    });
    const warn = vi.spyOn(ctx.logger, 'warn');
    await expect(finalizeGiveaway(ctx, row.id)).resolves.toMatchObject({ ended: true });
    expect(warn).toHaveBeenCalled();
    channel.send.mockClear();
    await finalizeGiveaway(ctx, row.id);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('does not replace winners or announce when a reroll has nobody new', async () => {
    const row = giveaway({ ended: true, winnerIds: ['only'], entries: [{ userId: 'only' }] });
    const { guild, channel } = fakeGuild();
    let updates = 0;
    const { ctx } = withClient(guild, {
      giveaway: {
        findUnique: async () => row,
        update: async () => {
          updates += 1;
          return row;
        },
      },
    });
    const result = await rerollGiveaway(ctx, row.id);
    expect(result?.winnerIds).toEqual([]);
    expect(updates).toBe(0);
    expect(channel.send).not.toHaveBeenCalled();
    expect(row.winnerIds).toEqual(['only']);
  });

  it('rerolls only from entrants who have not already won', async () => {
    const row = giveaway({
      ended: true,
      winnerCount: 2,
      winnerIds: ['a', 'b'],
      entries: [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }],
    });
    const { guild } = fakeGuild();
    const { ctx } = withClient(guild, {
      giveaway: {
        findUnique: async () => row,
        update: async (args: { data?: { winnerIds?: string[] } }) => {
          row.winnerIds = args.data?.winnerIds ?? row.winnerIds;
          return row;
        },
      },
    });
    const result = await rerollGiveaway(ctx, row.id, 2);
    expect(result?.winnerIds).toEqual(['c']);
  });
});

describe('poll closing', () => {
  const poll = {
    id: 'poll1',
    guildId: 'guild-1',
    channelId: 'ch1',
    messageId: 'msg1',
    question: 'Cats or dogs?',
    anonymous: false,
    multiSelect: false,
    endsAt: new Date('2026-01-01T00:00:00Z'),
    closed: false,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Poll;

  it('names a tie on the closed results embed', () => {
    const embed = buildPollEmbed({ ...poll, closed: true }, [
      { optionId: 'a', label: 'Cats', position: 0, votes: 2 },
      { optionId: 'b', label: 'Dogs', position: 1, votes: 2 },
    ]);
    const result = embed.data.fields?.find((field) => field.name === 'Result');
    expect(result?.value).toContain('Tie');
    expect(result?.value).toContain('Cats');
    expect(result?.value).toContain('Dogs');
  });

  it('closes the poll and posts results when the original message was deleted', async () => {
    const { guild, channel } = fakeGuild({ fetchMessage: async () => Promise.reject(discordError(10008)) });
    let closed = false;
    const { ctx } = withClient(guild, {
      poll: {
        findUnique: async () => ({ ...poll, closed }),
        update: async (args: { data?: { closed?: boolean } }) => {
          closed = args.data?.closed ?? closed;
          return { ...poll, closed };
        },
      },
    });
    const updated = await closePoll(ctx, poll.id);
    expect(updated?.closed).toBe(true);
    expect(closed).toBe(true);
    expect(channel.send).toHaveBeenCalled();
  });

  it('stays closed when the bot is missing permissions, and reopens when the edit can be retried', async () => {
    const denied = fakeGuild({ fetchMessage: async () => Promise.reject(discordError(50013)) });
    let deniedClosed = false;
    const deniedCtx = withClient(denied.guild, {
      poll: {
        findUnique: async () => ({ ...poll, closed: deniedClosed }),
        update: async (args: { data?: { closed?: boolean } }) => {
          deniedClosed = args.data?.closed ?? deniedClosed;
          return { ...poll, closed: deniedClosed };
        },
      },
    });
    await expect(closePoll(deniedCtx.ctx, poll.id)).resolves.toMatchObject({ closed: true });
    expect(deniedClosed).toBe(true);

    const flaky = fakeGuild({ fetchMessage: async () => Promise.reject(new Error('timeout')) });
    let flakyClosed = false;
    const flakyCtx = withClient(flaky.guild, {
      poll: {
        findUnique: async () => ({ ...poll, closed: flakyClosed }),
        update: async (args: { data?: { closed?: boolean } }) => {
          flakyClosed = args.data?.closed ?? flakyClosed;
          return { ...poll, closed: flakyClosed };
        },
      },
    });
    await expect(closePoll(flakyCtx.ctx, poll.id)).rejects.toThrow(/retried/);
    expect(flakyClosed).toBe(false);
  });
});

describe('suggestions whose post is gone', () => {
  const suggestion = {
    id: 's1',
    guildId: 'guild-1',
    number: 1,
    authorId: 'user-1',
    channelId: 'ch1',
    messageId: 'msg1',
    content: 'add cats',
    status: 'PENDING',
    staffNote: null,
    threadId: 'thread1',
    upvotes: 0,
    downvotes: 0,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Suggestion;

  it('clears the stored message id when an edit finds the message deleted', async () => {
    const { guild } = fakeGuild({ fetchMessage: async () => Promise.reject(discordError(10008)) });
    let cleared: unknown;
    const { ctx } = withClient(guild, {
      suggestion: {
        update: async (args: { data?: unknown }) => {
          cleared = args.data;
          return suggestion;
        },
      },
    });
    await expect(syncSuggestionMessage(ctx, suggestion)).resolves.toBeUndefined();
    expect(cleared).toMatchObject({ messageId: null });
  });

  it('keeps the message id when the bot is missing permissions to edit', async () => {
    const { guild } = fakeGuild({ fetchMessage: async () => Promise.reject(discordError(50001)) });
    let updates = 0;
    const { ctx } = withClient(guild, {
      suggestion: {
        update: async () => {
          updates += 1;
          return suggestion;
        },
      },
    });
    await syncSuggestionMessage(ctx, { ...suggestion, status: 'APPROVED' });
    expect(updates).toBe(0);
  });

  it('treats deleting an already-deleted suggestion post as success', async () => {
    const { guild } = fakeGuild({ deleteMessage: async () => Promise.reject(discordError(10008)) });
    let cleared: unknown;
    const { ctx } = withClient(guild, {
      suggestion: {
        update: async (args: { data?: unknown }) => {
          cleared = args.data;
          return suggestion;
        },
      },
    });
    await syncSuggestionMessage(ctx, { ...suggestion, deletedAt: new Date() });
    expect(cleared).toMatchObject({ messageId: null });
  });
});

describe('reminders', () => {
  const reminder = {
    id: 'r1',
    guildId: 'guild-1',
    userId: 'user-1',
    channelId: 'ch1',
    content: 'stand up',
    remindAt: new Date('2026-01-01T00:00:00Z'),
    recurring: null,
    delivered: false,
    deliveredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Reminder;

  it('delivers a one-off reminder only once when the sweep and the job both run', async () => {
    const { guild, channel } = fakeGuild();
    let delivered = false;
    const { ctx } = withClient(guild, {
      reminder: {
        findUnique: async () => ({ ...reminder, delivered }),
        updateMany: async () => {
          if (delivered) return { count: 0 };
          delivered = true;
          return { count: 1 };
        },
      },
    });
    await deliverReminder(ctx, reminder.id);
    await deliverReminder(ctx, reminder.id);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('DMs the user when the reminder channel was deleted', async () => {
    const { guild, channel } = fakeGuild({ fetchChannel: async () => Promise.reject(discordError(10003)) });
    const dm = vi.fn(async () => undefined);
    const { ctx } = withClient(
      guild,
      {
        reminder: {
          findUnique: async () => reminder,
          updateMany: async () => ({ count: 1 }),
        },
      },
      async () => ({ id: 'user-1', send: dm }),
    );
    await deliverReminder(ctx, reminder.id);
    expect(channel.send).not.toHaveBeenCalled();
    expect(dm).toHaveBeenCalledTimes(1);
  });

  it('falls back to a DM when the bot lacks permission to post in the channel', async () => {
    const { guild } = fakeGuild({ send: async () => Promise.reject(discordError(50013)) });
    const dm = vi.fn(async () => undefined);
    const { ctx } = withClient(
      guild,
      {
        reminder: {
          findUnique: async () => reminder,
          updateMany: async () => ({ count: 1 }),
        },
      },
      async () => ({ id: 'user-1', send: dm }),
    );
    await expect(deliverReminder(ctx, reminder.id)).resolves.toBeUndefined();
    expect(dm).toHaveBeenCalledTimes(1);
  });

  it('leaves a recurring reminder listed and does not deliver the same tick twice', async () => {
    const recurring = { ...reminder, recurring: '0 9 * * *' };
    const { guild, channel } = fakeGuild();
    const updates: unknown[] = [];
    const { ctx } = withClient(guild, {
      reminder: {
        findUnique: async () => recurring,
        update: async (args: { data?: unknown }) => {
          updates.push(args.data);
          return recurring;
        },
      },
    });
    await deliverReminder(ctx, recurring.id);
    await deliverReminder(ctx, recurring.id);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([{ deliveredAt: expect.any(Date) }]);
  });

  it('restores a recurring scheduler that disappeared after a restart', async () => {
    const recurring = { ...reminder, recurring: '0 9 * * *' };
    const upserts: unknown[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        reminder: {
          findMany: async (...args: unknown[]) => {
            const where = (args[0] as { where?: { recurring?: unknown } } | undefined)?.where;
            const recurringFilter = where?.recurring;
            if (recurringFilter && typeof recurringFilter === 'object' && 'not' in recurringFilter) {
              return [recurring];
            }
            return [];
          },
        },
      },
    });
    ctx.services.register('host', {
      getGuildConfig: async () => ({ timezone: 'America/New_York' }),
    } as never);
    ctx.queue = () =>
      ({
        getJobScheduler: async () => undefined,
        upsertJobScheduler: async (...args: unknown[]) => {
          upserts.push(args);
        },
      }) as unknown as ReturnType<PluginContext['queue']>;
    await reminderSweepJob.processor(ctx, {} as never);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toEqual([
      'rem-r1',
      { pattern: '0 9 * * *', tz: 'America/New_York' },
      { name: 'reminder-deliver', data: { reminderId: 'r1' } },
    ]);
  });
});

describe('event reminders', () => {
  const event = {
    id: 'ev1',
    guildId: 'guild-1',
    channelId: 'ch1',
    title: 'Game night',
    startsAt: new Date(Date.now() + 60_000),
    reminderMinutes: [10],
  } as CommunityEvent;

  it('sends one reminder when the job and the catch-up both fire', async () => {
    const { guild, channel } = fakeGuild();
    const { ctx } = withClient(guild, {
      communityEvent: { findUnique: async () => event },
      eventRsvp: { findMany: async () => [{ userId: 'user-1', status: 'GOING' }] },
    });
    await fireEventReminder(ctx, event.id, 10);
    await fireEventReminder(ctx, event.id, 10);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('does not throw or retry forever when the event channel was deleted', async () => {
    const { guild, channel } = fakeGuild({ fetchChannel: async () => Promise.reject(discordError(10003)) });
    const { ctx } = withClient(guild, {
      communityEvent: { findUnique: async () => event },
      eventRsvp: { findMany: async () => [{ userId: 'user-1', status: 'GOING' }] },
    });
    await expect(fireEventReminder(ctx, event.id, 10)).resolves.toBeUndefined();
    await fireEventReminder(ctx, event.id, 10);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('does not throw when the bot cannot post the reminder', async () => {
    const { guild } = fakeGuild({ send: async () => Promise.reject(discordError(50013)) });
    const { ctx } = withClient(guild, {
      communityEvent: { findUnique: async () => event },
      eventRsvp: { findMany: async () => [{ userId: 'user-1', status: 'GOING' }] },
    });
    await expect(fireEventReminder(ctx, event.id, 10)).resolves.toBeUndefined();
  });
});

describe('catch-up after a restart', () => {
  it('ends an overdue giveaway and closes an overdue poll whose jobs never ran', async () => {
    const row = giveaway({ id: 'gw-catchup', entries: [] });
    const poll = {
      id: 'poll1',
      guildId: 'guild-1',
      channelId: 'ch1',
      messageId: null,
      question: 'Ready?',
      anonymous: true,
      multiSelect: false,
      endsAt: new Date('2026-01-01T00:00:00Z'),
      closed: false,
      createdBy: 'user-1',
    } as Poll;
    const { guild } = fakeGuild();
    const { ctx } = withClient(guild, {
      giveaway: {
        findMany: async () => [{ id: row.id }],
        findUnique: async () => row,
        updateMany: async (args: { data?: { winnerIds?: string[] } }) => {
          row.ended = true;
          row.winnerIds = args.data?.winnerIds ?? [];
          return { count: 1 };
        },
      },
      poll: {
        findMany: async () => [{ id: poll.id }],
        findUnique: async () => poll,
        update: async () => ({ ...poll, closed: true }),
      },
      communityEvent: { findMany: async () => [] },
    });
    const result = await catchUpCommunitySchedules(ctx, new Date('2026-06-01T00:00:00Z'));
    expect(result.giveaways).toBe(1);
    expect(result.polls).toBe(1);
    expect(row.ended).toBe(true);
  });
});
