import type { Guild } from 'discord.js';
import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { CommunityEvent, Giveaway, Poll, ScheduledAnnouncement } from '@pavisie/database';
import { createTestContext, type PrismaStubOverrides } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { runAnnouncement } from '../actions';
import { configSchema, type CommunityConfig } from '../manifest';
import { announcementRunJob } from '../jobs/announcement-run';
import { announceBirthdaysForGuild, birthdayAnnounceJob } from '../jobs/birthday-announce';
import { birthdayRoleRemoveJob } from '../jobs/birthday-role-remove';
import { catchUpCommunitySchedules, communityCatchupJob } from '../jobs/community-catchup';
import { eventReminderJob } from '../jobs/event-reminder';
import { giveawayEndJob } from '../jobs/giveaway-end';
import { pollEndJob } from '../jobs/poll-end';

function discordError(code: number, message = `Discord ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

interface SentPayload {
  content?: string;
  allowedMentions?: { users?: string[]; parse?: string[] };
}

interface FakeChannel {
  send: ReturnType<typeof vi.fn>;
  messages: { fetch: ReturnType<typeof vi.fn> };
  edit: ReturnType<typeof vi.fn>;
}

function fakeGuild(
  opts: {
    fetchChannel?: () => Promise<unknown>;
    fetchMessage?: () => Promise<{ edit: () => Promise<void> }>;
    send?: (payload: unknown) => Promise<unknown>;
    /** When false, the bot fails the send-permission pre-check. */
    canSend?: boolean;
    fetchMember?: (id: string) => Promise<unknown>;
  } = {},
): { guild: Guild; channel: FakeChannel; user: { send: ReturnType<typeof vi.fn> } } {
  const edit = vi.fn(async () => undefined);
  const user = { id: 'user-1', send: vi.fn(async () => undefined) };
  const channel = {
    id: 'ch1',
    type: 0,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => opts.canSend !== false }),
    send: vi.fn(async (payload: unknown) => {
      if (opts.send) return opts.send(payload);
      return { id: 'sent' };
    }),
    messages: {
      fetch: vi.fn(async () => {
        if (opts.fetchMessage) return opts.fetchMessage();
        return { edit };
      }),
    },
    edit,
  };
  const guild = {
    id: 'guild-1',
    name: 'Test',
    available: true,
    members: {
      me: { id: 'bot', roles: { highest: { position: 10 } } },
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
  return { guild: guild as unknown as Guild, channel, user };
}

function withGuild(guild: Guild, prismaOverrides: object, client?: PluginContext['client']): PluginContext {
  const { ctx } = createTestContext({ prismaOverrides: prismaOverrides as PrismaStubOverrides });
  ctx.client =
    client ??
    ({
      guilds: { cache: new Map([[guild.id, guild]]), fetch: async () => guild },
      users: { fetch: async () => ({ id: 'user-1', send: async () => undefined }) },
    } as unknown as PluginContext['client']);
  return ctx;
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

function pollRow(partial: Partial<Poll> = {}): Poll {
  return {
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
    ...partial,
  } as Poll;
}

function eventRow(partial: Partial<CommunityEvent> = {}): CommunityEvent {
  return {
    id: 'ev1',
    guildId: 'guild-1',
    channelId: 'ch1',
    title: 'Raid night',
    startsAt: new Date('2026-06-01T12:08:00.000Z'),
    reminderMinutes: [10],
    ...partial,
  } as CommunityEvent;
}

describe('announcement-run', () => {
  function announcement(partial: Partial<ScheduledAnnouncement> = {}): ScheduledAnnouncement {
    return {
      id: 'ann1',
      guildId: 'guild-1',
      channelId: 'ch1',
      content: { content: 'Gates open at 8.' },
      cron: null,
      runAt: new Date('2026-06-01T12:00:00Z'),
      enabled: true,
      lastRunAt: null,
      createdBy: 'host',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...partial,
    } as ScheduledAnnouncement;
  }

  it('posts a one-off announcement once, then disables it so a second delivery does not post again', async () => {
    const row = announcement();
    const updates: { data?: { lastRunAt?: Date; enabled?: boolean } }[] = [];
    const { guild, channel } = fakeGuild();
    const ctx = withGuild(guild, {
      scheduledAnnouncement: {
        findUnique: async () => row,
        update: async (args: { data?: { lastRunAt?: Date; enabled?: boolean } }) => {
          updates.push(args);
          if (args.data?.lastRunAt) row.lastRunAt = args.data.lastRunAt;
          if (args.data?.enabled !== undefined) row.enabled = args.data.enabled;
          return row;
        },
      },
    });

    await announcementRunJob.processor(ctx, { data: { announcementId: row.id } } as never);
    await announcementRunJob.processor(ctx, { data: { announcementId: row.id } } as never);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith({
      content: 'Gates open at 8.',
      allowedMentions: { parse: ['users', 'roles'] },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data?.enabled).toBe(false);
    expect(updates[0]?.data?.lastRunAt).toBeInstanceOf(Date);
    expect(row.enabled).toBe(false);
  });

  it('posts a recurring announcement and leaves it enabled for the next tick', async () => {
    const row = announcement({ cron: '0 9 * * *' });
    let updated: { lastRunAt?: Date; enabled?: boolean } | undefined;
    const { guild, channel } = fakeGuild();
    const ctx = withGuild(guild, {
      scheduledAnnouncement: {
        findUnique: async () => row,
        update: async (args: { data?: { lastRunAt?: Date; enabled?: boolean } }) => {
          updated = args.data;
          return row;
        },
      },
    });

    await runAnnouncement(ctx, row.id);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(updated).toEqual({ lastRunAt: expect.any(Date) });
    expect(row.enabled).toBe(true);
  });

  it('does not post or touch a disabled announcement', async () => {
    const row = announcement({ enabled: false });
    const { guild, channel } = fakeGuild();
    let updates = 0;
    const ctx = withGuild(guild, {
      scheduledAnnouncement: {
        findUnique: async () => row,
        update: async () => {
          updates += 1;
          return row;
        },
      },
    });

    await announcementRunJob.processor(ctx, { data: { announcementId: row.id } } as never);

    expect(channel.send).not.toHaveBeenCalled();
    expect(updates).toBe(0);
    expect(guild.channels.fetch).not.toHaveBeenCalled();
  });
});

describe('giveaway-end', () => {
  it('keeps the drawn winners and announces them on a later attempt after a transient channel error', async () => {
    const row = giveaway({
      id: 'gw-retry',
      winnerCount: 1,
      // Within GIVEAWAY_ANNOUNCED_TTL_SECONDS (30 days). Older endsAt is retired without throwing.
      endsAt: new Date(),
      entries: [{ userId: 'alpha' }, { userId: 'beta' }],
    });
    let claims = 0;
    let sends = 0;
    const { guild, channel, user } = fakeGuild({
      send: async () => {
        sends += 1;
        if (sends === 1) throw new Error('socket hang up');
        return { id: 'announced' };
      },
    });
    const ctx = withGuild(guild, {
      giveaway: {
        findUnique: async () => row,
        updateMany: async (args: { data?: { winnerIds?: string[] } }) => {
          claims += 1;
          row.ended = true;
          row.winnerIds = args.data?.winnerIds ?? [];
          return { count: 1 };
        },
      },
    });

    await expect(giveawayEndJob.processor(ctx, { data: { giveawayId: row.id } } as never)).rejects.toThrow(
      /retried/,
    );
    const drawn = [...row.winnerIds];
    expect(drawn).toHaveLength(1);
    expect(user.send).not.toHaveBeenCalled();

    await giveawayEndJob.processor(ctx, { data: { giveawayId: row.id } } as never);

    expect(claims).toBe(1);
    expect(row.winnerIds).toEqual(drawn);
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(user.send).toHaveBeenCalledTimes(1);
    expect(user.send.mock.calls[0]?.[0]).toEqual(expect.stringContaining(`**${row.prize}**`));
  });

  it('DMs the winners when the channel rejects the announcement for missing permissions, and does not post again', async () => {
    const row = giveaway({ id: 'gw-dm', entries: [{ userId: 'winner' }] });
    const { guild, channel, user } = fakeGuild({
      send: async () => Promise.reject(discordError(50013)),
    });
    const ctx = withGuild(guild, {
      giveaway: {
        findUnique: async () => row,
        updateMany: async (args: { data?: { winnerIds?: string[] } }) => {
          row.ended = true;
          row.winnerIds = args.data?.winnerIds ?? [];
          return { count: 1 };
        },
      },
    });

    await giveawayEndJob.processor(ctx, { data: { giveawayId: row.id } } as never);
    await giveawayEndJob.processor(ctx, { data: { giveawayId: row.id } } as never);

    expect(row.ended).toBe(true);
    expect(row.winnerIds).toEqual(['winner']);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(user.send).toHaveBeenCalledTimes(1);
    expect(user.send.mock.calls[0]?.[0]).toEqual(expect.stringContaining('You won **Nitro**'));
  });
});

describe('poll-end', () => {
  it.each([
    ['unknown channel', 10003],
    ['missing access', 50001],
  ] as const)(
    'stays closed and does not post when the channel fetch fails with %s (%i)',
    async (_label, code) => {
      const poll = pollRow({ id: `poll-${code}` });
      let closed = false;
      const { guild, channel } = fakeGuild({
        fetchChannel: async () => Promise.reject(discordError(code)),
      });
      const ctx = withGuild(guild, {
        poll: {
          findUnique: async () => ({ ...poll, closed }),
          update: async (args: { data?: { closed?: boolean } }) => {
            closed = args.data?.closed ?? closed;
            return { ...poll, closed };
          },
        },
      });

      await pollEndJob.processor(ctx, { data: { pollId: poll.id } } as never);
      await pollEndJob.processor(ctx, { data: { pollId: poll.id } } as never);

      expect(closed).toBe(true);
      expect(channel.send).not.toHaveBeenCalled();
      expect(channel.messages.fetch).not.toHaveBeenCalled();
    },
  );

  it('stays closed without fetching the message when the bot cannot send in the channel', async () => {
    const poll = pollRow({ id: 'poll-perms' });
    let closed = false;
    const { guild, channel } = fakeGuild({ canSend: false });
    const ctx = withGuild(guild, {
      poll: {
        findUnique: async () => ({ ...poll, closed }),
        update: async (args: { data?: { closed?: boolean } }) => {
          closed = args.data?.closed ?? closed;
          return { ...poll, closed };
        },
      },
    });

    await pollEndJob.processor(ctx, { data: { pollId: poll.id } } as never);

    expect(closed).toBe(true);
    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('reopens when the guild cannot be reached, then catch-up closes and edits the results', async () => {
    const poll = pollRow({ id: 'poll-blip' });
    let closed = false;
    const { guild, channel } = fakeGuild();
    let fetches = 0;
    const ctx = withGuild(
      guild,
      {
        poll: {
          findUnique: async () => ({ ...poll, closed }),
          findMany: async () => (closed ? [] : [{ id: poll.id }]),
          update: async (args: { data?: { closed?: boolean } }) => {
            closed = args.data?.closed ?? closed;
            return { ...poll, closed };
          },
        },
        giveaway: { findMany: async () => [] },
        communityEvent: { findMany: async () => [] },
      },
      {
        guilds: {
          fetch: async () => {
            fetches += 1;
            if (fetches === 1) throw new Error('socket hang up');
            return guild;
          },
        },
      } as unknown as PluginContext['client'],
    );

    await expect(pollEndJob.processor(ctx, { data: { pollId: poll.id } } as never)).rejects.toThrow(
      /retried/,
    );
    expect(closed).toBe(false);
    expect(channel.edit).not.toHaveBeenCalled();

    const result = await catchUpCommunitySchedules(ctx, new Date('2026-06-01T12:00:00Z'));

    expect(result.polls).toBe(1);
    expect(closed).toBe(true);
    expect(channel.edit).toHaveBeenCalledTimes(1);
  });

  it('reopens when the original message is gone and the replacement post fails transiently', async () => {
    const poll = pollRow({ id: 'poll-repost' });
    let closed = false;
    let sends = 0;
    const { guild, channel } = fakeGuild({
      fetchMessage: async () => Promise.reject(discordError(10008)),
      send: async () => {
        sends += 1;
        if (sends === 1) throw new Error('socket hang up');
        return { id: 'results' };
      },
    });
    const ctx = withGuild(guild, {
      poll: {
        findUnique: async () => ({ ...poll, closed }),
        update: async (args: { data?: { closed?: boolean } }) => {
          closed = args.data?.closed ?? closed;
          return { ...poll, closed };
        },
      },
    });

    await expect(pollEndJob.processor(ctx, { data: { pollId: poll.id } } as never)).rejects.toThrow(
      /retried/,
    );
    expect(closed).toBe(false);

    await pollEndJob.processor(ctx, { data: { pollId: poll.id } } as never);

    expect(closed).toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });
});

describe('event-reminder', () => {
  function going(userIds: string[]) {
    return userIds.map((userId) => ({ userId, status: 'GOING' as const }));
  }

  it('uses the singular minute label for a one-minute reminder', async () => {
    const event = eventRow({ id: 'ev-one', title: 'Standup', reminderMinutes: [1] });
    const { guild, channel } = fakeGuild();
    const ctx = withGuild(guild, {
      communityEvent: { findUnique: async () => event },
      eventRsvp: { findMany: async () => going(['user-1']) },
    });

    await eventReminderJob.processor(ctx, { data: { eventId: event.id, minutesBefore: 1 } } as never);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0]?.[0]).toMatchObject({
      content: '📅 **Standup** starts in 1 minute! <@user-1>',
      allowedMentions: { users: ['user-1'] },
    });
  });

  it('splits a large RSVP list across messages without dropping or re-pinging anyone', async () => {
    const userIds = Array.from({ length: 120 }, (_, i) => String(10_000_000_000_000_000n + BigInt(i)));
    const event = eventRow({ id: 'ev-chunk', title: 'Raid night', reminderMinutes: [10] });
    const { guild, channel } = fakeGuild();
    const ctx = withGuild(guild, {
      communityEvent: { findUnique: async () => event },
      eventRsvp: { findMany: async () => going(userIds) },
    });

    await eventReminderJob.processor(ctx, { data: { eventId: event.id, minutesBefore: 10 } } as never);

    const payloads = channel.send.mock.calls.map((call) => call[0] as SentPayload);
    expect(payloads.length).toBeGreaterThan(1);
    const mentioned: string[] = [];
    for (const [index, payload] of payloads.entries()) {
      const users = payload.allowedMentions?.users ?? [];
      expect(payload.content?.length ?? 0).toBeLessThanOrEqual(2000);
      expect(users.length).toBeGreaterThan(0);
      expect(users.length).toBeLessThanOrEqual(100);
      expect(payload.content).toContain(index === 0 ? 'starts in 10 minutes!' : '(continued)');
      for (const id of users) expect(payload.content).toContain(`<@${id}>`);
      mentioned.push(...users);
    }
    expect(mentioned).toEqual(userIds);

    await eventReminderJob.processor(ctx, { data: { eventId: event.id, minutesBefore: 10 } } as never);
    expect(channel.send).toHaveBeenCalledTimes(payloads.length);
  });
});

describe('community-catchup', () => {
  const NOW = new Date('2026-06-01T12:00:00.000Z');

  it('runs every five minutes', () => {
    expect(communityCatchupJob.name).toBe('community-catchup');
    expect(communityCatchupJob.repeat).toEqual({ pattern: '*/5 * * * *' });
  });

  it('sends only reminders that are due and still inside the grace window', async () => {
    const due = eventRow({
      id: 'ev-due',
      title: 'Due',
      startsAt: new Date('2026-06-01T12:08:00.000Z'),
      reminderMinutes: [60, 10],
    });
    const early = eventRow({
      id: 'ev-early',
      title: 'Early',
      startsAt: new Date('2026-06-01T12:40:00.000Z'),
      reminderMinutes: [10],
    });
    const stale = eventRow({
      id: 'ev-stale',
      title: 'Stale',
      startsAt: new Date('2026-06-01T11:50:00.000Z'),
      reminderMinutes: [10],
    });
    const events = [due, early, stale];
    const { guild, channel } = fakeGuild();
    const reminded: { eventId: string; minutesBefore: number }[] = [];
    const ctx = withGuild(guild, {
      giveaway: { findMany: async () => [] },
      poll: { findMany: async () => [] },
      communityEvent: {
        findMany: async () => events,
        findUnique: async (args: { where: { id: string } }) =>
          events.find((event) => event.id === args.where.id) ?? null,
      },
      eventRsvp: {
        findMany: async (args: { where: { eventId: string } }) => {
          if (args.where.eventId !== due.id) return [];
          return [{ userId: 'user-1', status: 'GOING' }];
        },
      },
    });
    const original = channel.send.getMockImplementation();
    channel.send.mockImplementation(async (payload: unknown) => {
      const content = (payload as SentPayload).content ?? '';
      const match = content.match(/starts in (\d+) minute/);
      reminded.push({
        eventId: content.includes('Due') ? due.id : 'other',
        minutesBefore: Number(match?.[1]),
      });
      return original?.call(channel, payload);
    });

    const result = await catchUpCommunitySchedules(ctx, NOW);

    expect(result.eventReminders).toBe(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(reminded).toEqual([{ eventId: due.id, minutesBefore: 10 }]);
  });

  it('sends a reminder on the next catch-up when the first post fails transiently', async () => {
    const event = eventRow({
      id: 'ev-retry',
      startsAt: new Date('2026-06-01T12:08:00.000Z'),
      reminderMinutes: [10],
    });
    let sends = 0;
    const { guild, channel } = fakeGuild({
      send: async () => {
        sends += 1;
        if (sends === 1) throw new Error('socket hang up');
        return { id: 'reminded' };
      },
    });
    const ctx = withGuild(guild, {
      giveaway: { findMany: async () => [] },
      poll: { findMany: async () => [] },
      communityEvent: {
        findMany: async () => [event],
        findUnique: async () => event,
      },
      eventRsvp: { findMany: async () => [{ userId: 'user-1', status: 'GOING' }] },
    });

    const first = await catchUpCommunitySchedules(ctx, NOW);
    const second = await catchUpCommunitySchedules(ctx, NOW);

    expect(first.eventReminders).toBe(0);
    expect(second.eventReminders).toBe(1);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it('does not post again when the channel rejected the reminder for missing permissions', async () => {
    const event = eventRow({
      id: 'ev-denied',
      startsAt: new Date('2026-06-01T12:08:00.000Z'),
      reminderMinutes: [10],
    });
    const { guild, channel } = fakeGuild({
      send: async () => Promise.reject(discordError(50013)),
    });
    const ctx = withGuild(guild, {
      giveaway: { findMany: async () => [] },
      poll: { findMany: async () => [] },
      communityEvent: {
        findMany: async () => [event],
        findUnique: async () => event,
      },
      eventRsvp: { findMany: async () => [{ userId: 'user-1', status: 'GOING' }] },
    });

    const first = await catchUpCommunitySchedules(ctx, NOW);
    const second = await catchUpCommunitySchedules(ctx, NOW);

    expect(first.eventReminders).toBe(1);
    expect(second.eventReminders).toBe(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('still closes a poll and sends a due reminder when one giveaway fails', async () => {
    const poll = pollRow({ id: 'poll-ok', messageId: 'msg-ok' });
    let closed = false;
    const event = eventRow({
      id: 'ev-ok',
      startsAt: new Date('2026-06-01T12:08:00.000Z'),
      reminderMinutes: [10],
    });
    const { guild, channel } = fakeGuild();
    const ctx = withGuild(guild, {
      giveaway: {
        findMany: async () => [{ id: 'gw-bad' }],
        findUnique: async () => {
          throw new Error('database unavailable');
        },
      },
      poll: {
        findMany: async () => [{ id: poll.id }],
        findUnique: async () => ({ ...poll, closed }),
        update: async (args: { data?: { closed?: boolean } }) => {
          closed = args.data?.closed ?? closed;
          return { ...poll, closed };
        },
      },
      communityEvent: {
        findMany: async () => [event],
        findUnique: async () => event,
      },
      eventRsvp: { findMany: async () => [{ userId: 'user-1', status: 'GOING' }] },
    });
    const error = vi.spyOn(ctx.logger, 'error');

    const result = await catchUpCommunitySchedules(ctx, NOW);

    expect(result).toEqual({ giveaways: 0, polls: 1, eventReminders: 1 });
    expect(closed).toBe(true);
    expect(channel.edit).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ giveawayId: 'gw-bad' }),
      'community: catch-up could not end a giveaway',
    );
  });
});

const BIRTHDAY_GUILD = 'guild-1';
const BIRTHDAY_USER = 'user-1';
const BIRTHDAY_CHANNEL = 'chan-1';
const BIRTHDAY_ROLE = 'role-1';
const BIRTHDAY_NOW = new Date('2026-03-04T09:15:00Z');

function birthdayConfig(patch: Partial<CommunityConfig['birthdays']> = {}): CommunityConfig {
  return configSchema.parse({
    birthdays: { enabled: true, channelId: BIRTHDAY_CHANNEL, announceHour: 9, ...patch },
  });
}

interface BirthdayRow {
  id: string;
  userId: string;
  month: number;
  day: number;
  lastAnnouncedYear: number | null;
}

function birthdayGuild(
  opts: {
    users?: { id: string; displayName: string }[];
    channelError?: unknown;
    canSend?: boolean;
    role?: { managed?: boolean; position?: number; permissionsBitfield?: bigint } | null;
    roleAdd?: () => Promise<void>;
    /** ioredis-mock shares data across clients; tests that stamp a guild-day blocked key must not reuse guild-1. */
    guildId?: string;
  } = {},
) {
  const guildId = opts.guildId ?? BIRTHDAY_GUILD;
  const users = opts.users ?? [{ id: BIRTHDAY_USER, displayName: 'Ada' }];
  const sent: SentPayload[] = [];
  const rolesAdded: string[] = [];
  const memberRoleIds = new Map<string, Set<string>>();
  for (const user of users) memberRoleIds.set(user.id, new Set());
  const role =
    opts.role === null
      ? null
      : {
          id: BIRTHDAY_ROLE,
          position: opts.role?.position ?? 1,
          managed: opts.role?.managed ?? false,
          permissions: { bitfield: opts.role?.permissionsBitfield ?? 0n },
        };
  const channel = {
    id: BIRTHDAY_CHANNEL,
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => opts.canSend !== false }),
    send: async (payload: SentPayload) => {
      sent.push(payload);
    },
  };
  const guild = {
    id: guildId,
    name: 'Test Guild',
    available: true,
    memberCount: 42,
    members: {
      me: { roles: { highest: { position: 10 } } },
      fetch: async (id: string) => {
        const user = users.find((candidate) => candidate.id === id);
        if (!user) throw discordError(10007, 'Unknown Member');
        const roles = memberRoleIds.get(id)!;
        return {
          id,
          displayName: user.displayName,
          roles: {
            cache: { has: (roleId: string) => roles.has(roleId) },
            add: async (r: { id: string }) => {
              if (opts.roleAdd) await opts.roleAdd();
              rolesAdded.push(r.id);
              roles.add(r.id);
            },
            remove: async (idToRemove: string) => {
              roles.delete(idToRemove);
            },
          },
        };
      },
    },
    channels: {
      fetch: async () => {
        if (opts.channelError) throw opts.channelError;
        return channel;
      },
    },
    roles: {
      cache: new Map(role ? [[BIRTHDAY_ROLE, role]] : []),
      fetch: async () => role,
    },
  };
  return { guild: guild as unknown as Guild, sent, rolesAdded, memberRoleIds };
}

function birthdaySetup(
  opts: {
    rows?: BirthdayRow[];
    guild?: ReturnType<typeof birthdayGuild>;
    queueAdd?: (name: string, data: unknown, opts: unknown) => Promise<void>;
  } = {},
) {
  const rows = opts.rows ?? [{ id: 'b1', userId: BIRTHDAY_USER, month: 3, day: 4, lastAnnouncedYear: null }];
  const updates: { where: { id: string }; data: { lastAnnouncedYear: number } }[] = [];
  const findManyArgs: unknown[] = [];
  const queued: unknown[] = [];
  const fake = opts.guild ?? birthdayGuild();
  const prismaOverrides = {
    birthday: {
      findMany: async (args: unknown) => {
        findManyArgs.push(args);
        const where = (
          args as {
            where: {
              OR: { month: number; day: number }[];
              AND: [{ OR: [{ lastAnnouncedYear: null }, { lastAnnouncedYear: { not: number } }] }];
            };
          }
        ).where;
        const year = where.AND[0].OR[1].lastAnnouncedYear.not;
        return rows.filter(
          (row) =>
            (row.lastAnnouncedYear === null || row.lastAnnouncedYear !== year) &&
            where.OR.some((md) => md.month === row.month && md.day === row.day),
        );
      },
      update: async (args: { where: { id: string }; data: { lastAnnouncedYear: number } }) => {
        updates.push(args);
        const row = rows.find((candidate) => candidate.id === args.where.id);
        if (row) row.lastAnnouncedYear = args.data.lastAnnouncedYear;
        return row;
      },
    },
  };
  const { ctx } = createTestContext({
    prismaOverrides: prismaOverrides as PrismaStubOverrides,
    overrides: {
      queue: () =>
        ({
          add:
            opts.queueAdd ??
            (async (name: string, data: unknown, jobOpts: unknown) => {
              queued.push({ name, data, opts: jobOpts });
            }),
        }) as unknown as ReturnType<PluginContext['queue']>,
    },
  });
  return { ctx, rows, updates, findManyArgs, queued, ...fake };
}

describe('birthday announce edges', () => {
  it('does not query or post when birthdays are disabled or have no channel', async () => {
    const disabled = birthdaySetup();
    await expect(
      announceBirthdaysForGuild(
        disabled.ctx,
        disabled.guild,
        birthdayConfig({ enabled: false }),
        BIRTHDAY_NOW,
      ),
    ).resolves.toEqual({ guildId: BIRTHDAY_GUILD, announced: 0, skippedReason: 'disabled' });

    const noChannel = birthdaySetup();
    await expect(
      announceBirthdaysForGuild(
        noChannel.ctx,
        noChannel.guild,
        birthdayConfig({ channelId: null }),
        BIRTHDAY_NOW,
      ),
    ).resolves.toEqual({ guildId: BIRTHDAY_GUILD, announced: 0, skippedReason: 'disabled' });

    expect(disabled.findManyArgs).toHaveLength(0);
    expect(noChannel.findManyArgs).toHaveLength(0);
    expect(disabled.sent).toHaveLength(0);
  });

  it('skips a missing birthday channel without stamping the year', async () => {
    const s = birthdaySetup({
      guild: birthdayGuild({ channelError: discordError(10003), guildId: 'guild-missing-channel' }),
    });

    const result = await announceBirthdaysForGuild(s.ctx, s.guild, birthdayConfig(), BIRTHDAY_NOW);

    expect(result).toEqual({ guildId: 'guild-missing-channel', announced: 0, skippedReason: 'channel' });
    expect(s.updates).toHaveLength(0);
    expect(s.rows[0]?.lastAnnouncedYear).toBeNull();
    expect(s.sent).toHaveLength(0);
  });

  it('announces every due member and stamps each of them', async () => {
    const s = birthdaySetup({
      rows: [
        { id: 'b1', userId: 'user-1', month: 3, day: 4, lastAnnouncedYear: null },
        { id: 'b2', userId: 'user-2', month: 3, day: 4, lastAnnouncedYear: null },
      ],
      guild: birthdayGuild({
        users: [
          { id: 'user-1', displayName: 'Ada' },
          { id: 'user-2', displayName: 'Grace' },
        ],
      }),
    });

    const result = await announceBirthdaysForGuild(s.ctx, s.guild, birthdayConfig(), BIRTHDAY_NOW);

    expect(result.announced).toBe(2);
    expect(s.sent.map((payload) => payload.allowedMentions)).toEqual([
      { users: ['user-1'], parse: [] },
      { users: ['user-2'], parse: [] },
    ]);
    expect(s.updates.map((update) => update.where.id)).toEqual(['b1', 'b2']);
    expect(s.rows.every((row) => row.lastAnnouncedYear === 2026)).toBe(true);
  });

  it('announces a Feb 29 birthday on Feb 29 in a leap year and not a Feb 28 birthday', async () => {
    const leapDay = new Date('2024-02-29T09:05:00Z');
    const s = birthdaySetup({
      rows: [
        { id: 'b28', userId: BIRTHDAY_USER, month: 2, day: 28, lastAnnouncedYear: null },
        { id: 'b29', userId: 'user-2', month: 2, day: 29, lastAnnouncedYear: null },
      ],
      guild: birthdayGuild({
        users: [
          { id: BIRTHDAY_USER, displayName: 'Ada' },
          { id: 'user-2', displayName: 'Grace' },
        ],
      }),
    });

    const result = await announceBirthdaysForGuild(s.ctx, s.guild, birthdayConfig(), leapDay);

    expect(result.announced).toBe(1);
    expect(s.findManyArgs[0]).toMatchObject({ where: { OR: [{ month: 2, day: 29 }] } });
    expect(s.updates).toEqual([{ where: { id: 'b29' }, data: { lastAnnouncedYear: 2024 } }]);
    expect(s.rows.find((row) => row.id === 'b28')?.lastAnnouncedYear).toBeNull();
  });

  it('still announces and stamps when the configured role cannot be assigned', async () => {
    const s = birthdaySetup({
      guild: birthdayGuild({ role: { managed: true } }),
    });

    const result = await announceBirthdaysForGuild(
      s.ctx,
      s.guild,
      birthdayConfig({ roleId: BIRTHDAY_ROLE }),
      BIRTHDAY_NOW,
    );

    expect(result.announced).toBe(1);
    expect(s.rolesAdded).toEqual([]);
    expect(s.queued).toEqual([]);
    expect(s.rows[0]?.lastAnnouncedYear).toBe(2026);
  });

  it('still stamps the year when adding the birthday role is rejected', async () => {
    const s = birthdaySetup({
      guild: birthdayGuild({
        roleAdd: async () => {
          throw discordError(50013);
        },
      }),
    });
    const warn = vi.spyOn(s.ctx.logger, 'warn');

    const result = await announceBirthdaysForGuild(
      s.ctx,
      s.guild,
      birthdayConfig({ roleId: BIRTHDAY_ROLE }),
      BIRTHDAY_NOW,
    );

    expect(result.announced).toBe(1);
    expect(s.sent).toHaveLength(1);
    expect(s.rolesAdded).toEqual([]);
    expect(s.queued).toEqual([]);
    expect(s.rows[0]?.lastAnnouncedYear).toBe(2026);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: BIRTHDAY_USER, roleId: BIRTHDAY_ROLE }),
      'community: could not add the birthday role',
    );
  });

  it('logs one guild failure and still announces the next guild', async () => {
    const good = birthdayGuild();
    const bad = birthdayGuild();
    (bad.guild as { id: string }).id = 'guild-bad';
    const queried: string[] = [];
    const logs: unknown[][] = [];
    const { ctx } = createTestContext({
      config: birthdayConfig(),
      prismaOverrides: {
        birthday: {
          findMany: async (args: unknown) => {
            const guildId = (args as { where: { guildId: string } }).where.guildId;
            queried.push(guildId);
            if (guildId === 'guild-bad') throw new Error('birthday query failed');
            return [
              {
                id: 'b-good',
                guildId: BIRTHDAY_GUILD,
                userId: BIRTHDAY_USER,
                month: 3,
                day: 4,
                lastAnnouncedYear: null,
              },
            ];
          },
          update: async () => ({ id: 'b-good' }),
        },
      },
      overrides: {
        client: {
          guilds: {
            cache: new Map([
              ['guild-bad', bad.guild],
              [BIRTHDAY_GUILD, good.guild],
            ]),
          },
        } as never,
        isEnabled: async () => true,
      },
    });
    ctx.services.register('logging', {
      log: async (...args: unknown[]) => {
        logs.push(args);
      },
    } as unknown as NonNullable<ReturnType<typeof ctx.services.get<'logging'>>>);
    vi.useFakeTimers();
    vi.setSystemTime(BIRTHDAY_NOW);
    try {
      await expect(birthdayAnnounceJob.processor(ctx, {} as never)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    expect(queried).toEqual(['guild-bad', BIRTHDAY_GUILD]);
    expect(good.sent).toHaveLength(1);
    expect(bad.sent).toHaveLength(0);
    expect(logs).toEqual([
      [
        'guild-bad',
        'bot.error',
        expect.objectContaining({
          title: 'Birthday announcement failed',
          description: 'birthday query failed',
        }),
      ],
    ]);
  });

  it('skips a guild whose community plugin is disabled and still announces an enabled one', async () => {
    const on = birthdayGuild();
    const offGuild = birthdayGuild();
    (offGuild.guild as { id: string }).id = 'guild-off';
    const queried: string[] = [];
    const { ctx } = createTestContext({
      config: birthdayConfig(),
      prismaOverrides: {
        birthday: {
          findMany: async (args: unknown) => {
            const guildId = (args as { where: { guildId: string } }).where.guildId;
            queried.push(guildId);
            return [
              {
                id: `b-${guildId}`,
                userId: BIRTHDAY_USER,
                month: 3,
                day: 4,
                lastAnnouncedYear: null,
              },
            ];
          },
          update: async () => ({}),
        },
      },
      overrides: {
        client: {
          guilds: {
            cache: new Map([
              ['guild-off', offGuild.guild],
              [BIRTHDAY_GUILD, on.guild],
            ]),
          },
        } as never,
        isEnabled: async (guildId: string) => guildId !== 'guild-off',
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(BIRTHDAY_NOW);
    try {
      await birthdayAnnounceJob.processor(ctx, {} as never);
    } finally {
      vi.useRealTimers();
    }

    expect(queried).toEqual([BIRTHDAY_GUILD]);
    expect(on.sent).toHaveLength(1);
    expect(offGuild.sent).toHaveLength(0);
  });
});

describe('birthday-role-remove', () => {
  function roleGuild() {
    const removed: string[] = [];
    const memberRoleIds = new Set<string>([BIRTHDAY_ROLE]);
    const remove = vi.fn(async (id: string) => {
      removed.push(id);
      memberRoleIds.delete(id);
    });
    const guild = {
      id: BIRTHDAY_GUILD,
      members: {
        fetch: vi.fn(async () => ({
          id: BIRTHDAY_USER,
          roles: {
            cache: { has: (id: string) => memberRoleIds.has(id) },
            remove,
          },
        })),
      },
    };
    return { guild, removed, remove };
  }

  it('fetches the guild when it is not cached and removes the role', async () => {
    const { guild, removed } = roleGuild();
    const fetch = vi.fn(async () => guild);
    const { ctx } = createTestContext({
      overrides: {
        client: { guilds: { cache: new Map(), fetch } } as never,
      },
    });

    await birthdayRoleRemoveJob.processor(ctx, {
      data: { guildId: BIRTHDAY_GUILD, userId: BIRTHDAY_USER, roleId: BIRTHDAY_ROLE },
    } as never);

    expect(fetch).toHaveBeenCalledWith(BIRTHDAY_GUILD);
    expect(removed).toEqual([BIRTHDAY_ROLE]);
  });

  it('returns when the guild no longer exists', async () => {
    const fetch = vi.fn(async () => Promise.reject(discordError(10004)));
    const { ctx } = createTestContext({
      overrides: {
        client: { guilds: { cache: new Map(), fetch } } as never,
      },
    });

    await expect(
      birthdayRoleRemoveJob.processor(ctx, {
        data: { guildId: BIRTHDAY_GUILD, userId: BIRTHDAY_USER, roleId: BIRTHDAY_ROLE },
      } as never),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns when the member has left', async () => {
    const { guild, removed } = roleGuild();
    guild.members.fetch.mockRejectedValueOnce(discordError(10007));
    const { ctx } = createTestContext({
      overrides: {
        client: { guilds: { cache: new Map([[BIRTHDAY_GUILD, guild]]), fetch: async () => guild } } as never,
      },
    });

    await birthdayRoleRemoveJob.processor(ctx, {
      data: { guildId: BIRTHDAY_GUILD, userId: BIRTHDAY_USER, roleId: BIRTHDAY_ROLE },
    } as never);

    expect(removed).toEqual([]);
  });

  it('logs and does not throw when Discord refuses the role removal for missing permissions', async () => {
    const { guild, removed, remove } = roleGuild();
    remove.mockRejectedValueOnce(discordError(50013));
    const { ctx } = createTestContext({
      overrides: {
        client: { guilds: { cache: new Map([[BIRTHDAY_GUILD, guild]]) } } as never,
      },
    });
    const warn = vi.spyOn(ctx.logger, 'warn');

    await expect(
      birthdayRoleRemoveJob.processor(ctx, {
        data: { guildId: BIRTHDAY_GUILD, userId: BIRTHDAY_USER, roleId: BIRTHDAY_ROLE },
      } as never),
    ).resolves.toBeUndefined();

    expect(removed).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: BIRTHDAY_GUILD, userId: BIRTHDAY_USER, roleId: BIRTHDAY_ROLE }),
      'community: could not remove the birthday role',
    );
  });
});
