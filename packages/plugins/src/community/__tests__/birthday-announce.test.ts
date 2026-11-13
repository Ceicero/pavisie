import { ChannelType, type Guild } from 'discord.js';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../../sdk/testing';
import { configSchema, type CommunityConfig } from '../manifest';
import { announceBirthdaysForGuild, birthdayAnnounceJob } from '../jobs/birthday-announce';
import { birthdayRoleRemoveJob } from '../jobs/birthday-role-remove';

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const CHANNEL_ID = 'chan-1';
const ROLE_ID = 'role-1';

// 2026-03-04 09:15 UTC — a Wednesday, not a leap year.
const NOW = new Date('2026-03-04T09:15:00Z');

function makeConfig(patch: Partial<CommunityConfig['birthdays']> = {}): CommunityConfig {
  return configSchema.parse({
    birthdays: { enabled: true, channelId: CHANNEL_ID, announceHour: 9, ...patch },
  });
}

interface FakeGuildOptions {
  memberPresent?: boolean;
  /** Discord.js `Guild.available` — false during a regional outage. Defaults to true. */
  available?: boolean;
  /** Defaults to `GUILD_ID`. ioredis-mock shares data across clients, so tests that stamp a guild-day key must not reuse it. */
  guildId?: string;
  /** Additional member ids `members.fetch` should resolve. The primary `USER_ID` is always present unless `memberPresent` is false. */
  extraUserIds?: string[];
  /** Runs before the payload is recorded. Throw to simulate a failed `channel.send`. */
  onSend?: (payload: unknown) => Promise<void> | void;
  /** Replaces `channels.fetch`. Receives the default text channel so a retry can return it. */
  fetchChannel?: (channel: unknown) => Promise<unknown>;
}

/** Minimal discord.js Guild stand-in covering everything the birthday job touches. */
function makeFakeGuild(opts: FakeGuildOptions = {}) {
  const sent: unknown[] = [];
  const rolesAdded: string[] = [];
  const rolesRemoved: string[] = [];
  const memberRoleIds = new Set<string>();

  const role = { id: ROLE_ID, position: 1, managed: false, permissions: { bitfield: 0n } };
  const member = {
    id: USER_ID,
    displayName: 'Ada',
    roles: {
      cache: { has: (id: string) => memberRoleIds.has(id) },
      add: async (r: { id: string }) => {
        rolesAdded.push(r.id);
        memberRoleIds.add(r.id);
      },
      remove: async (id: string) => {
        rolesRemoved.push(id);
        memberRoleIds.delete(id);
      },
    },
  };
  const channel = {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload: unknown) => {
      if (opts.onSend) await opts.onSend(payload);
      sent.push(payload);
    },
  };
  const guild = {
    id: opts.guildId ?? GUILD_ID,
    name: 'Test Guild',
    available: opts.available ?? true,
    memberCount: 42,
    members: {
      me: { roles: { highest: { position: 10 } } },
      fetch: async (id: string) => {
        if (opts.memberPresent === false) throw new Error('Unknown Member');
        if (id === USER_ID) return member;
        if (opts.extraUserIds?.includes(id)) {
          return {
            id,
            displayName: `Member ${id}`,
            roles: {
              cache: { has: () => false },
              add: async () => undefined,
              remove: async () => undefined,
            },
          };
        }
        throw new Error('Unknown Member');
      },
    },
    channels: { fetch: async () => (opts.fetchChannel ? opts.fetchChannel(channel) : channel) },
    roles: { cache: new Map([[ROLE_ID, role]]), fetch: async () => role },
  };
  return { guild: guild as unknown as Guild, sent, rolesAdded, rolesRemoved, memberRoleIds };
}

interface Setup {
  birthdayRows?: {
    id: string;
    userId: string;
    month: number;
    day: number;
    lastAnnouncedYear: number | null;
  }[];
  guildOptions?: FakeGuildOptions;
  /** Overrides the queue's `add` implementation (default just records the call). Used to simulate an enqueue failure. */
  queueAdd?: (name: string, data: unknown, opts: unknown) => Promise<void>;
  /** Overrides `ctx.logger` (default is the real silent pino logger from `createTestContext`). Used to spy on warn calls. */
  logger?: Logger;
}

/** Shape of the `where` clause `announceBirthdaysForGuild` sends — kept in sync with the real query so the
 * fixture below exercises the exact same NULL-vs-not-equal logic Postgres would apply. */
interface BirthdayWhere {
  guildId: string;
  OR: { month: number; day: number }[];
  AND: [{ OR: [{ lastAnnouncedYear: null }, { lastAnnouncedYear: { not: number } }] }];
}

function setup(input: Setup = {}) {
  const rows = input.birthdayRows ?? [
    { id: 'b1', userId: USER_ID, month: 3, day: 4, lastAnnouncedYear: null },
  ];
  const updates: unknown[] = [];
  const findManyArgs: unknown[] = [];
  const queued: { name: string; data: unknown; opts: unknown }[] = [];
  const fake = makeFakeGuild(input.guildOptions);
  const queueAdd =
    input.queueAdd ??
    (async (name: string, data: unknown, opts: unknown) => {
      queued.push({ name, data, opts });
    });

  const { ctx } = createTestContext({
    prismaOverrides: {
      birthday: {
        // Honour the real where-clause (OR date match + NULL-safe year check) exactly like Postgres would:
        // a NULL `lastAnnouncedYear` is due; a row whose year equals this year is not.
        findMany: async (args: unknown) => {
          findManyArgs.push(args);
          const where = (args as { where: BirthdayWhere }).where;
          const yearNotCondition = where.AND[0].OR[1].lastAnnouncedYear.not;
          const isDue = (year: number | null) => year === null || year !== yearNotCondition;
          return rows.filter(
            (r) =>
              isDue(r.lastAnnouncedYear) && where.OR.some((md) => md.month === r.month && md.day === r.day),
          );
        },
        update: async (args: unknown) => {
          updates.push(args);
          const { where, data } = args as { where: { id: string }; data: { lastAnnouncedYear: number } };
          const row = rows.find((r) => r.id === where.id);
          if (row) row.lastAnnouncedYear = data.lastAnnouncedYear;
          return row;
        },
      },
    },
    overrides: {
      queue: () => ({ add: queueAdd }) as unknown as Queue,
      ...(input.logger ? { logger: input.logger } : {}),
    },
  });

  return { ctx, ...fake, updates, findManyArgs, queued, rows };
}

describe('announceBirthdaysForGuild', () => {
  it('announces a due birthday exactly once, mentions only that user, and stamps lastAnnouncedYear', async () => {
    const s = setup();
    const first = await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig(), NOW);
    expect(first.announced).toBe(1);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({
      content: `🎂 Happy birthday, <@${USER_ID}>!`,
      allowedMentions: { users: [USER_ID], parse: [] },
    });
    expect(s.updates[0]).toMatchObject({ where: { id: 'b1' }, data: { lastAnnouncedYear: 2026 } });
    expect(s.rows[0]!.lastAnnouncedYear).toBe(2026);

    // Same hour, later run (or a restart) — nothing due anymore this year.
    const second = await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig(), NOW);
    expect(second.announced).toBe(0);
    expect(s.sent).toHaveLength(1);
    // The query itself excludes already-announced rows for the current year — but via a NULL-safe OR, not a
    // plain NOT (see the next test for why that distinction matters).
    expect(s.findManyArgs[0]).toMatchObject({
      where: { AND: [{ OR: [{ lastAnnouncedYear: null }, { lastAnnouncedYear: { not: 2026 } }] }] },
    });
  });

  it('a NULL lastAnnouncedYear row is due, and a same-year row is not — Postgres NULL comparison, not JS !==', async () => {
    // `NOT: { lastAnnouncedYear: year }` reads like "year !== lastAnnouncedYear" but Postgres's `<>` against a
    // NULL column evaluates to NULL (never TRUE), so that predicate would silently exclude every never-announced
    // row. This fixture's `findMany` mock mirrors that exact NULL-safe semantics (see `setup()` above), so this
    // test only passes when the real query is built the NULL-safe way.
    const s = setup({
      birthdayRows: [
        { id: 'b-null', userId: USER_ID, month: 3, day: 4, lastAnnouncedYear: null },
        { id: 'b-same-year', userId: USER_ID, month: 3, day: 4, lastAnnouncedYear: 2026 },
      ],
    });
    const result = await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig(), NOW);
    expect(result.announced).toBe(1);
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0]).toMatchObject({ where: { id: 'b-null' } });
  });

  it('skips before the guild-local announce hour', async () => {
    const s = setup();
    const result = await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig({ announceHour: 10 }), NOW);
    expect(result).toMatchObject({ announced: 0, skippedReason: 'hour' });
    expect(s.sent).toHaveLength(0);
    expect(s.updates).toHaveLength(0);
  });

  it('uses the guild timezone from the host service for the local hour', async () => {
    const s = setup();
    s.ctx.services.register('host', {
      getGuildConfig: async () => ({ timezone: 'Asia/Tokyo' }),
    } as never);
    // 09:15 UTC is 18:15 in Tokyo. Hour 19 has not started there; hour 18 has.
    // (UTC hour 9 would also be before 19, so the second call — hour 18, which UTC has not reached — is what
    // proves the guild timezone is the clock being compared.)
    expect(
      (await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig({ announceHour: 19 }), NOW)).skippedReason,
    ).toBe('hour');
    expect(
      (await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig({ announceHour: 18 }), NOW)).announced,
    ).toBe(1);
  });

  it('retries a transient send later the same day and does not repeat a birthday that already went out', async () => {
    let user1Attempts = 0;
    const s = setup({
      birthdayRows: [
        { id: 'b1', userId: USER_ID, month: 3, day: 4, lastAnnouncedYear: null },
        { id: 'b2', userId: 'user-2', month: 3, day: 4, lastAnnouncedYear: null },
      ],
      guildOptions: {
        extraUserIds: ['user-2'],
        onSend: async (payload) => {
          const content = (payload as { content?: string }).content ?? '';
          if (!content.includes(`<@${USER_ID}>`)) return;
          user1Attempts += 1;
          if (user1Attempts === 1) throw new Error('socket hang up');
        },
      },
    });

    const during = await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig(), NOW);
    expect(during.announced).toBe(1);
    expect(s.rows.find((row) => row.id === 'b1')!.lastAnnouncedYear).toBeNull();
    expect(s.rows.find((row) => row.id === 'b2')!.lastAnnouncedYear).toBe(2026);
    expect(s.sent.filter((payload) => JSON.stringify(payload).includes('<@user-2>'))).toHaveLength(1);

    // 11:15 UTC is after the configured hour (9). The old hour-equality gate skipped this person until next year.
    const later = new Date('2026-03-04T11:15:00Z');
    const retry = await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig(), later);
    expect(retry.announced).toBe(1);
    expect(s.rows.find((row) => row.id === 'b1')!.lastAnnouncedYear).toBe(2026);
    expect(s.sent.filter((payload) => JSON.stringify(payload).includes('<@user-2>'))).toHaveLength(1);
    expect(s.sent.filter((payload) => JSON.stringify(payload).includes(`<@${USER_ID}>`))).toHaveLength(1);
  });

  it.each([50013, 50001, 10003])(
    'does not retry a birthday Discord permanently rejected (%s)',
    async (code) => {
      let sends = 0;
      const s = setup({
        guildOptions: {
          onSend: async () => {
            sends += 1;
            throw Object.assign(new Error(`Discord ${code}`), { code });
          },
        },
      });
      const during = await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig(), NOW);
      expect(during.announced).toBe(0);
      expect(s.rows[0]!.lastAnnouncedYear).toBe(2026);

      const later = new Date('2026-03-04T16:15:00Z');
      const retry = await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig(), later);
      expect(retry.announced).toBe(0);
      expect(sends).toBe(1);
    },
  );

  it('retries a birthday channel that was temporarily unreachable, and stops when the channel is gone', async () => {
    let transientFetches = 0;
    const transient = setup({
      guildOptions: {
        fetchChannel: async (channel) => {
          transientFetches += 1;
          if (transientFetches === 1) throw new Error('ECONNRESET');
          return channel;
        },
      },
    });
    expect(
      (await announceBirthdaysForGuild(transient.ctx, transient.guild, makeConfig(), NOW)).skippedReason,
    ).toBe('channel');
    expect(transient.rows[0]!.lastAnnouncedYear).toBeNull();
    const later = new Date('2026-03-04T12:15:00Z');
    expect(
      (await announceBirthdaysForGuild(transient.ctx, transient.guild, makeConfig(), later)).announced,
    ).toBe(1);
    expect(transientFetches).toBe(2);

    let goneFetches = 0;
    const gone = setup({
      guildOptions: {
        // Own guild id: the channel-blocked redis key is process-wide under ioredis-mock.
        guildId: 'guild-channel-gone',
        fetchChannel: async () => {
          goneFetches += 1;
          throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        },
      },
    });
    expect((await announceBirthdaysForGuild(gone.ctx, gone.guild, makeConfig(), NOW)).skippedReason).toBe(
      'channel',
    );
    expect(gone.rows[0]!.lastAnnouncedYear).toBeNull();
    expect((await announceBirthdaysForGuild(gone.ctx, gone.guild, makeConfig(), later)).skippedReason).toBe(
      'channel',
    );
    expect(goneFetches).toBe(1);
    expect(gone.sent).toHaveLength(0);
  });

  it('adds the role and enqueues a ~24h removal only when roleId is set', async () => {
    const without = setup();
    await announceBirthdaysForGuild(without.ctx, without.guild, makeConfig(), NOW);
    expect(without.rolesAdded).toEqual([]);
    expect(without.queued).toEqual([]);

    const withRole = setup();
    await announceBirthdaysForGuild(withRole.ctx, withRole.guild, makeConfig({ roleId: ROLE_ID }), NOW);
    expect(withRole.rolesAdded).toEqual([ROLE_ID]);
    expect(withRole.queued).toHaveLength(1);
    expect(withRole.queued[0]).toMatchObject({
      name: 'birthday-role-remove',
      data: { guildId: GUILD_ID, userId: USER_ID, roleId: ROLE_ID },
      // Dash-separated: BullMQ 5.x rejects a custom jobId containing ':' unless it has exactly 3 segments, and
      // this one has 4 (bday-role, guildId, userId, year).
      opts: { delay: 86_400_000, jobId: `bday-role-${GUILD_ID}-${USER_ID}-2026`, removeOnComplete: true },
    });
  });

  it('rolls back the role grant (best-effort) and logs accurately when scheduling the removal job fails', async () => {
    const warnings: unknown[][] = [];
    const fakeLogger = {
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    const s = setup({
      logger: fakeLogger,
      queueAdd: async () => {
        throw new Error('redis unavailable');
      },
    });

    const result = await announceBirthdaysForGuild(s.ctx, s.guild, makeConfig({ roleId: ROLE_ID }), NOW);

    // The announcement message itself still goes out even though the role bookkeeping failed.
    expect(result.announced).toBe(1);
    expect(s.rolesAdded).toEqual([ROLE_ID]);
    // ...but since the 24h auto-removal couldn't be scheduled, the grant is rolled back so it can't become permanent.
    expect(s.rolesRemoved).toEqual([ROLE_ID]);
    expect(s.memberRoleIds.has(ROLE_ID)).toBe(false);
    expect(warnings.some(([, msg]) => msg === 'community: could not schedule birthday role removal')).toBe(
      true,
    );
  });

  it('skips (without deleting) a member who has left, and still announces on Feb 28 for Feb 29 birthdays', async () => {
    const gone = setup({ guildOptions: { memberPresent: false } });
    const r = await announceBirthdaysForGuild(gone.ctx, gone.guild, makeConfig(), NOW);
    expect(r.announced).toBe(0);
    expect(gone.updates).toHaveLength(0);
    expect(gone.rows[0]!.lastAnnouncedYear).toBeNull();

    const leap = setup({
      birthdayRows: [{ id: 'b29', userId: USER_ID, month: 2, day: 29, lastAnnouncedYear: null }],
    });
    const feb28 = new Date('2026-02-28T09:05:00Z'); // 2026 is not a leap year
    expect((await announceBirthdaysForGuild(leap.ctx, leap.guild, makeConfig(), feb28)).announced).toBe(1);
  });
});

describe('birthdayAnnounceJob processor', () => {
  it('iterates enabled guilds and never throws when one guild fails', async () => {
    const good = makeFakeGuild();
    const bad = {
      ...makeFakeGuild().guild,
      id: 'guild-bad',
      channels: {
        fetch: async () => {
          throw new Error('boom');
        },
      },
    } as unknown as Guild;
    const config = makeConfig();
    const { ctx } = createTestContext({
      config,
      prismaOverrides: {
        birthday: {
          findMany: async (args: unknown) => {
            const guildId = (args as { where: { guildId: string } }).where.guildId;
            return [
              { id: `b-${guildId}`, guildId, userId: USER_ID, month: 3, day: 4, lastAnnouncedYear: null },
            ];
          },
        },
      },
      overrides: {
        client: {
          guilds: {
            cache: new Map([
              ['guild-bad', bad],
              [GUILD_ID, good.guild],
            ]),
          },
        } as never,
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await expect(birthdayAnnounceJob.processor(ctx, {} as never)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    // The bad guild's channel fetch throws inside openTextChannel (unavailable → skipped); the good one posts.
    expect(good.sent).toHaveLength(1);
  });

  it('skips an unavailable guild before doing any work (regional outage) — never queried, never messaged', async () => {
    const good = makeFakeGuild();
    const unavailable = makeFakeGuild({ available: false });
    const queriedGuildIds: string[] = [];
    const config = makeConfig();
    const { ctx } = createTestContext({
      config,
      prismaOverrides: {
        birthday: {
          findMany: async (args: unknown) => {
            const guildId = (args as { where: { guildId: string } }).where.guildId;
            queriedGuildIds.push(guildId);
            return [
              { id: `b-${guildId}`, guildId, userId: USER_ID, month: 3, day: 4, lastAnnouncedYear: null },
            ];
          },
        },
      },
      overrides: {
        client: {
          guilds: {
            cache: new Map([
              ['guild-unavailable', { ...unavailable.guild, id: 'guild-unavailable' } as unknown as Guild],
              [GUILD_ID, good.guild],
            ]),
          },
        } as never,
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await birthdayAnnounceJob.processor(ctx, {} as never);
    } finally {
      vi.useRealTimers();
    }

    expect(queriedGuildIds).toEqual([GUILD_ID]);
    expect(good.sent).toHaveLength(1);
    expect(unavailable.sent).toHaveLength(0);
  });

  it('is scheduled hourly on the community.birthday-announce queue', () => {
    expect(birthdayAnnounceJob.name).toBe('birthday-announce');
    expect(birthdayAnnounceJob.repeat).toEqual({ pattern: '0 * * * *' });
  });
});

describe('birthdayRoleRemoveJob', () => {
  it('removes the role only if the member still has it', async () => {
    const fake = makeFakeGuild();
    fake.memberRoleIds.add(ROLE_ID);
    const { ctx } = createTestContext({
      overrides: { client: { guilds: { cache: new Map([[GUILD_ID, fake.guild]]) } } as never },
    });
    await birthdayRoleRemoveJob.processor(ctx, {
      data: { guildId: GUILD_ID, userId: USER_ID, roleId: ROLE_ID },
    } as never);
    expect(fake.rolesRemoved).toEqual([ROLE_ID]);

    // Second run: role already gone → no-op.
    await birthdayRoleRemoveJob.processor(ctx, {
      data: { guildId: GUILD_ID, userId: USER_ID, roleId: ROLE_ID },
    } as never);
    expect(fake.rolesRemoved).toEqual([ROLE_ID]);
  });
});
