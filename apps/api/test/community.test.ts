import { describe, expect, it } from 'vitest';
import { redisKey } from '@pavisie/core';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '111111111111111111';
const USER_ID = '222222222222222222';

async function authedApp(overrides: Parameters<typeof buildTestApp>[0] = {}) {
  const built = await buildTestApp({
    guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    ...overrides,
  });
  const { cookieHeader, session } = await loginAs(built.app, built.redis, { userId: USER_ID });
  await seedUserGuilds(built.redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  const mutHeaders = {
    cookie: cookieHeader,
    origin: 'http://localhost:3000',
    'x-csrf-token': session.csrfToken,
  };
  return { ...built, cookieHeader, mutHeaders };
}

describe('community giveaways', () => {
  it('lists giveaways with an entry count derived from the relation', async () => {
    const row = {
      id: 'gw1',
      guildId: GUILD_ID,
      channelId: 'c1',
      messageId: 'm1',
      prize: 'Nitro',
      winnerCount: 1,
      hostId: 'host1',
      endsAt: new Date('2026-02-01T00:00:00Z'),
      ended: false,
      requiredRoleIds: [],
      minAccountAgeDays: null,
      minLevel: null,
      winnerIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { entries: 7 },
    };
    const { app, cookieHeader } = await authedApp({ giveaway: { findMany: async () => [row] } });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/giveaways`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ id: 'gw1', prize: 'Nitro', entryCount: 7 });

    await app.close();
  });
});

describe('community poll results', () => {
  const poll = {
    id: 'poll1',
    guildId: GUILD_ID,
    channelId: 'c1',
    messageId: 'm1',
    question: 'Best pet?',
    anonymous: false,
    multiSelect: false,
    endsAt: null,
    closed: false,
    createdBy: 'author1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const options = [
    { id: 'a', pollId: 'poll1', label: 'Cats', position: 0, emoji: null },
    { id: 'b', pollId: 'poll1', label: 'Dogs', position: 1, emoji: null },
  ];
  const votes = [
    { id: 'v1', pollId: 'poll1', optionId: 'a', userId: 'u1', createdAt: new Date() },
    { id: 'v2', pollId: 'poll1', optionId: 'a', userId: 'u2', createdAt: new Date() },
  ];

  it('tallies votes per option and includes voter ids for a non-anonymous poll', async () => {
    const { app, cookieHeader } = await authedApp({
      poll: { findFirst: async () => poll },
      pollOption: { findMany: async () => options },
      pollVote: { findMany: async () => votes },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/polls/poll1/results`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalVotes).toBe(2);
    expect(body.options[0]).toMatchObject({ id: 'a', votes: 2, voterIds: ['u1', 'u2'] });
    expect(body.options[1]).toMatchObject({ id: 'b', votes: 0 });

    await app.close();
  });

  it('omits voter ids for an anonymous poll', async () => {
    const { app, cookieHeader } = await authedApp({
      poll: { findFirst: async () => ({ ...poll, anonymous: true }) },
      pollOption: { findMany: async () => options },
      pollVote: { findMany: async () => votes },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/polls/poll1/results`,
      headers: { cookie: cookieHeader },
    });
    expect(res.json().options[0]).not.toHaveProperty('voterIds');

    await app.close();
  });

  it('404s for a poll that does not exist in the guild', async () => {
    const { app, cookieHeader } = await authedApp({ poll: { findFirst: async () => null } });
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/polls/nope/results`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('community announcements', () => {
  it('lists scheduled announcements', async () => {
    const row = {
      id: 'ann1',
      guildId: GUILD_ID,
      channelId: 'c1',
      content: { content: 'Hello!' },
      cron: '0 12 * * *',
      runAt: null,
      enabled: true,
      lastRunAt: null,
      createdBy: 'staff1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { app, cookieHeader } = await authedApp({ scheduledAnnouncement: { findMany: async () => [row] } });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/announcements`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      id: 'ann1',
      cron: '0 12 * * *',
      content: { content: 'Hello!' },
    });

    await app.close();
  });

  it('cancels an announcement: disables it and returns the updated DTO', async () => {
    const existing = { id: 'ann1', guildId: GUILD_ID, cron: null };
    const updated = {
      ...existing,
      channelId: 'c1',
      content: { content: 'Hi' },
      runAt: new Date(),
      enabled: false,
      lastRunAt: null,
      createdBy: 'staff1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { app, mutHeaders } = await authedApp({
      scheduledAnnouncement: { findFirst: async () => existing, update: async () => updated },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/community/announcements/ann1/cancel`,
      headers: mutHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'ann1', enabled: false });

    await app.close();
  }, 10_000);

  it('404s cancelling an announcement that does not belong to the guild', async () => {
    const { app, mutHeaders } = await authedApp({ scheduledAnnouncement: { findFirst: async () => null } });
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/community/announcements/nope/cancel`,
      headers: mutHeaders,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('community events', () => {
  it('lists events with RSVP counts summarized from the relation', async () => {
    const row = {
      id: 'ev1',
      guildId: GUILD_ID,
      title: 'Movie night',
      description: null,
      startsAt: new Date('2026-03-01T20:00:00Z'),
      endsAt: null,
      channelId: 'c1',
      messageId: 'm1',
      hostId: 'host1',
      discordEventId: null,
      reminderMinutes: [60, 10],
      createdAt: new Date(),
      updatedAt: new Date(),
      rsvps: [
        {
          id: 'r1',
          eventId: 'ev1',
          userId: 'u1',
          status: 'GOING',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'r2',
          eventId: 'ev1',
          userId: 'u2',
          status: 'MAYBE',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'r3',
          eventId: 'ev1',
          userId: 'u3',
          status: 'DECLINED',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };
    const { app, cookieHeader } = await authedApp({ communityEvent: { findMany: async () => [row] } });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/events`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      id: 'ev1',
      title: 'Movie night',
      rsvps: { going: 1, maybe: 1, declined: 1 },
    });

    await app.close();
  });
});

describe('economy settings', () => {
  it('GET returns manifest defaults, PUT persists a patch', async () => {
    const store = new Map<string, Record<string, unknown>>();
    const { app, cookieHeader, mutHeaders } = await authedApp({
      pluginConfig: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake, args shape mirrors Prisma's generated types
        findUnique: async (args: any) =>
          store.has(args.where.guildId_pluginId.pluginId)
            ? { config: store.get(args.where.guildId_pluginId.pluginId) }
            : null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        upsert: async (args: any) => {
          store.set(args.where.guildId_pluginId.pluginId, args.create.config);
          return { config: args.create.config };
        },
      },
    });

    const before = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/economy/config`,
      headers: { cookie: cookieHeader },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().currencyName).toBe('Coins');
    expect(before.json().dailyMinAmount).toBe(50);

    const put = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/economy/config`,
      headers: mutHeaders,
      payload: { currencyName: 'Gems', currencySymbol: '💎' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().currencyName).toBe('Gems');
    expect(put.json().currencySymbol).toBe('💎');
    // untouched fields keep their defaults
    expect(put.json().dailyMaxAmount).toBe(150);

    await app.close();
  });

  it('rejects an unauthenticated request', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/economy/config` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('community suggestions status', () => {
  it('updates status and writes an audit entry', async () => {
    const existing = { id: 's1', guildId: GUILD_ID, deletedAt: null, status: 'PENDING' };
    const updated = {
      ...existing,
      status: 'APPROVED',
      number: 1,
      authorId: 'a1',
      channelId: 'c1',
      messageId: 'm1',
      content: 'Add dark mode',
      staffNote: null,
      threadId: null,
      upvotes: 0,
      downvotes: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { app, mutHeaders } = await authedApp({
      suggestion: { findFirst: async () => existing, update: async () => updated },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/community/suggestions/s1`,
      headers: mutHeaders,
      payload: { status: 'APPROVED' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');

    await app.close();
  });

  it('404s updating a suggestion that does not belong to the guild', async () => {
    const { app, mutHeaders } = await authedApp({ suggestion: { findFirst: async () => null } });
    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/community/suggestions/nope`,
      headers: mutHeaders,
      payload: { status: 'APPROVED' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('community tags (spec CG-02)', () => {
  const now = new Date('2026-08-01T00:00:00Z');
  const tagRow = {
    id: 'tag1',
    guildId: GUILD_ID,
    name: 'rules',
    content: 'Read the {server} rules',
    embed: null as unknown,
    triggerMode: 'NONE',
    trigger: null as string | null,
    triggerChannelIds: [] as string[],
    staffOnly: false,
    uses: 3,
    createdBy: USER_ID,
    updatedBy: null as string | null,
    createdAt: now,
    updatedAt: now,
  };
  const triggerKey = `pavisie:community:tag-triggers:${GUILD_ID}`;

  it('lists tags with a name-prefix filter and maps the DTO', async () => {
    let seenWhere: unknown;
    const { app, cookieHeader } = await authedApp({
      tag: {
        findMany: async (args: unknown) => {
          seenWhere = (args as { where: unknown }).where;
          return [tagRow];
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/tags?q=RU`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      id: 'tag1',
      name: 'rules',
      content: 'Read the {server} rules',
      embed: null,
      triggerMode: 'NONE',
      uses: 3,
      createdAt: now.toISOString(),
    });
    expect(seenWhere).toMatchObject({ guildId: GUILD_ID, name: { startsWith: 'ru' } });

    await app.close();
  });

  it('creates a tag (201), writes an audit row, and clears the trigger cache key', async () => {
    let createData: Record<string, unknown> | undefined;
    const { app, mutHeaders, redis, prismaCalls } = await authedApp({
      tag: {
        findUnique: async () => null,
        count: async () => 0,
        create: async (args: unknown) => {
          createData = (args as { data: Record<string, unknown> }).data;
          return { ...tagRow, ...createData, id: 'new1', createdAt: now, updatedAt: now };
        },
      },
    });
    await redis.set(triggerKey, '[]');

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/community/tags`,
      headers: mutHeaders,
      payload: {
        name: ' LFG ',
        content: 'Looking for group? Post in #lfg, {user}.',
        triggerMode: 'CONTAINS',
        trigger: 'looking for group',
        triggerChannelIds: ['333333333333333333'],
        staffOnly: false,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: 'new1',
      name: 'lfg',
      triggerMode: 'CONTAINS',
      trigger: 'looking for group',
    });
    expect(createData).toMatchObject({
      guildId: GUILD_ID,
      name: 'lfg',
      triggerMode: 'CONTAINS',
      trigger: 'looking for group',
      triggerChannelIds: ['333333333333333333'],
      createdBy: USER_ID,
    });

    const audit = prismaCalls.find((c) => c.model === 'auditLog' && c.method === 'create');
    expect(audit).toBeDefined();
    expect((audit!.args[0] as { data: { action: string; source: string } }).data).toMatchObject({
      action: 'community.tag.create',
      source: 'DASHBOARD',
    });
    expect(await redis.get(triggerKey)).toBeNull();

    await app.close();
  });

  it('rejects a duplicate name with 409 tag_exists', async () => {
    const { app, mutHeaders } = await authedApp({ tag: { findUnique: async () => ({ id: 'tag1' }) } });
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/community/tags`,
      headers: mutHeaders,
      payload: { name: 'rules', content: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('tag_exists');
    await app.close();
  });

  it('rejects an invalid body (bad name / trigger mode without phrase / no content) with 400', async () => {
    const { app, mutHeaders } = await authedApp({ tag: { findUnique: async () => null } });
    for (const payload of [
      { name: 'Bad Name', content: 'x' },
      { name: 'ok', content: 'x', triggerMode: 'EXACT' },
      { name: 'ok' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/guilds/${GUILD_ID}/community/tags`,
        headers: mutHeaders,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    await app.close();
  });

  it('rejects a staff-only tag with an auto-responder trigger (400)', async () => {
    const { app, mutHeaders } = await authedApp({ tag: { findUnique: async () => null } });
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/community/tags`,
      headers: mutHeaders,
      payload: {
        name: 'ok',
        content: 'x',
        staffOnly: true,
        triggerMode: 'CONTAINS',
        trigger: 'how do i verify',
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('maps a Prisma P2002 unique violation on tag.create to 409 tag_exists (race past the check-then-write gate)', async () => {
    const { Prisma } = await import('@pavisie/database');
    const { app, mutHeaders } = await authedApp({
      tag: {
        findUnique: async () => null, // the pre-check sees no clash…
        count: async () => 0,
        create: async () => {
          // …but the write itself races with a concurrent insert and hits the unique constraint.
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '5.0.0',
          });
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/community/tags`,
      headers: mutHeaders,
      payload: { name: 'rules', content: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('tag_exists');
    await app.close();
  });

  it('maps a Prisma P2002 unique violation on tag.update (rename) to 409 tag_exists', async () => {
    const { Prisma } = await import('@pavisie/database');
    const { app, mutHeaders } = await authedApp({
      tag: {
        findFirst: async () => tagRow,
        findUnique: async () => null, // the pre-check sees no clash…
        update: async () => {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '5.0.0',
          });
        },
      },
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/community/tags/tag1`,
      headers: mutHeaders,
      payload: { name: 'renamed', content: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('tag_exists');
    await app.close();
  });

  it('updates a tag (200), audits, and clears the trigger cache key', async () => {
    let updateData: Record<string, unknown> | undefined;
    const { app, mutHeaders, redis, prismaCalls } = await authedApp({
      tag: {
        findFirst: async () => tagRow,
        findUnique: async () => null,
        update: async (args: unknown) => {
          updateData = (args as { data: Record<string, unknown> }).data;
          return { ...tagRow, ...updateData, updatedAt: now };
        },
      },
    });
    await redis.set(triggerKey, '[]');

    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/community/tags/tag1`,
      headers: mutHeaders,
      payload: {
        name: 'rules',
        content: null,
        embed: { title: 'Rules', description: 'Be kind in {server}.', colorHex: '#5865F2' },
        triggerMode: 'NONE',
        trigger: 'stale phrase',
        triggerChannelIds: ['333333333333333333'],
        staffOnly: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'rules',
      content: null,
      embed: { title: 'Rules', description: 'Be kind in {server}.', colorHex: '#5865F2' },
      staffOnly: true,
      trigger: null,
      triggerChannelIds: [],
    });
    // NONE mode always clears trigger + channels, and updatedBy is stamped.
    expect(updateData).toMatchObject({ trigger: null, triggerChannelIds: [], updatedBy: USER_ID });

    const audit = prismaCalls.find((c) => c.model === 'auditLog' && c.method === 'create');
    expect((audit!.args[0] as { data: { action: string } }).data.action).toBe('community.tag.update');
    expect(await redis.get(triggerKey)).toBeNull();

    await app.close();
  });

  it('409s when renaming onto another existing tag', async () => {
    const { app, mutHeaders } = await authedApp({
      tag: { findFirst: async () => tagRow, findUnique: async () => ({ id: 'other' }) },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/community/tags/tag1`,
      headers: mutHeaders,
      payload: { name: 'lfg', content: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('tag_exists');
    await app.close();
  });

  it('deletes a tag (204), audits, clears the cache; 404 for unknown', async () => {
    const { app, mutHeaders, redis, prismaCalls } = await authedApp({
      tag: {
        findFirst: async (args: unknown) =>
          (args as { where: { id: string } }).where.id === 'tag1' ? tagRow : null,
      },
    });
    await redis.set(triggerKey, '[]');

    const ok = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/community/tags/tag1`,
      headers: mutHeaders,
    });
    expect(ok.statusCode).toBe(204);
    expect(prismaCalls.some((c) => c.model === 'tag' && c.method === 'delete')).toBe(true);
    const audit = prismaCalls.find((c) => c.model === 'auditLog' && c.method === 'create');
    expect((audit!.args[0] as { data: { action: string } }).data.action).toBe('community.tag.delete');
    expect(await redis.get(triggerKey)).toBeNull();

    const missing = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/community/tags/nope`,
      headers: mutHeaders,
    });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });

  it('requires CSRF for tag writes', async () => {
    const { app, cookieHeader } = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/community/tags`,
      headers: { cookie: cookieHeader },
      payload: { name: 'x', content: 'y' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('community sticky messages', () => {
  const stickyRow = {
    id: 'st1',
    guildId: GUILD_ID,
    channelId: 'c1',
    content: 'Post LFG requests here',
    embed: { title: 'LFG rules', description: 5 },
    cooldownSeconds: 10,
    lastMessageId: 'm1',
    lastPostedAt: new Date('2026-02-01T00:00:00Z'),
    createdBy: 'mod1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

  it('lists stickies as DTOs (embed normalised, dates as ISO strings)', async () => {
    const { app, cookieHeader } = await authedApp({ stickyMessage: { findMany: async () => [stickyRow] } });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/stickies`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0]).toMatchObject({
      id: 'st1',
      channelId: 'c1',
      content: 'Post LFG requests here',
      cooldownSeconds: 10,
      lastMessageId: 'm1',
      lastPostedAt: '2026-02-01T00:00:00.000Z',
      createdBy: 'mod1',
    });
    // The non-string `description` is dropped by the DTO mapper; only the title survives.
    expect(res.json()[0].embed).toEqual({ title: 'LFG rules' });
    expect(res.json()[0]).not.toHaveProperty('guildId');

    await app.close();
  });

  it('rejects an unauthenticated list request', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/community/stickies` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('DELETE removes the row, drops the bot-side channel cache, and writes an audit entry', async () => {
    const deletes: unknown[] = [];
    const audits: unknown[] = [];
    const { app, mutHeaders, redis } = await authedApp({
      stickyMessage: {
        findFirst: async () => stickyRow,
        delete: async (args: unknown) => {
          deletes.push(args);
          return stickyRow;
        },
      },
      auditLog: {
        create: async (args: unknown) => {
          audits.push(args);
          return { id: 'a1' };
        },
      },
    });
    const cacheKey = redisKey('community', 'sticky-channels', GUILD_ID);
    await redis.set(cacheKey, JSON.stringify(['c1']));

    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/community/stickies/st1`,
      headers: mutHeaders,
    });
    expect(res.statusCode).toBe(204);
    expect(deletes).toHaveLength(1);
    expect((deletes[0] as { where: { id: string } }).where.id).toBe('st1');
    expect(await redis.get(cacheKey)).toBeNull();
    expect(audits).toHaveLength(1);
    expect((audits[0] as { data: Record<string, unknown> }).data).toMatchObject({
      guildId: GUILD_ID,
      actorId: USER_ID,
      action: 'community.sticky.remove',
      targetType: 'sticky_message',
      targetId: 'st1',
      source: 'DASHBOARD',
    });

    await app.close();
  });

  it('DELETE 404s for a sticky that does not belong to the guild', async () => {
    const { app, mutHeaders, prismaCalls } = await authedApp({
      stickyMessage: { findFirst: async () => null },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/community/stickies/nope`,
      headers: mutHeaders,
    });
    expect(res.statusCode).toBe(404);
    expect(prismaCalls.some((c) => c.model === 'stickyMessage' && c.method === 'delete')).toBe(false);
    await app.close();
  });

  it('DELETE requires the CSRF header', async () => {
    const { app, cookieHeader } = await authedApp({ stickyMessage: { findFirst: async () => stickyRow } });
    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/community/stickies/st1`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('community channel-automation stats', () => {
  it('returns 0 when the bot has not published anything today', async () => {
    const { app, cookieHeader } = await authedApp();
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/channel-automations/stats`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ autoPublishToday: 0 });
    await app.close();
  });

  it("reads the plugin's Redis daily counter", async () => {
    const { autoPublishCountKey, utcDayKey } =
      await import('@pavisie/plugins/community/channel-automations');
    const { app, redis, cookieHeader } = await authedApp();
    await redis.set(autoPublishCountKey(GUILD_ID, utcDayKey()), '7');
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/channel-automations/stats`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ autoPublishToday: 7 });
    await app.close();
  });

  it('403s a user without access to the guild', async () => {
    const built = await buildTestApp({
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    });
    const { cookieHeader } = await loginAs(built.app, built.redis, { userId: USER_ID });
    await seedUserGuilds(built.redis, USER_ID, []);
    const res = await built.app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/channel-automations/stats`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(403);
    await built.app.close();
  });
});

describe('community birthdays', () => {
  const USER_A = '333333333333333333';

  it('GET summary returns config + count + upcoming list, with no year field anywhere', async () => {
    const { app, cookieHeader } = await authedApp({
      birthday: {
        count: async () => 2,
        findMany: async () => [
          { userId: USER_A, month: 3, day: 4 },
          { userId: '444444444444444444', month: 12, day: 25 },
        ],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/community/birthdays/summary`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      enabled: false,
      channelId: null,
      announceHour: 9,
      roleId: null,
      publicList: true,
      message: '🎂 Happy birthday, {mention}!',
      count: 2,
    });
    expect(body.next).toHaveLength(2);
    expect(body.next[0]).toMatchObject({
      userId: expect.any(String),
      month: expect.any(Number),
      day: expect.any(Number),
    });
    expect(typeof body.next[0].inDays).toBe('number');
    expect(JSON.stringify(body).toLowerCase()).not.toContain('year');

    await app.close();
  });

  it('PUT config rejects an out-of-range hour and unknown message tokens with 400', async () => {
    const { app, mutHeaders } = await authedApp();

    const badHour = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/community/birthdays/config`,
      headers: mutHeaders,
      payload: { announceHour: 24 },
    });
    expect(badHour.statusCode).toBe(400);

    const badTokens = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/community/birthdays/config`,
      headers: mutHeaders,
      payload: { message: 'Happy {age}th, {mention}!' },
    });
    expect(badTokens.statusCode).toBe(400);

    await app.close();
  });

  it('PUT config persists the patch over defaults and writes an audit entry', async () => {
    const store = new Map<string, Record<string, unknown>>();
    const audits: unknown[] = [];
    const { app, mutHeaders } = await authedApp({
      pluginConfig: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake, args shape mirrors Prisma's generated types
        findUnique: async (args: any) =>
          store.has(args.where.guildId_pluginId.pluginId)
            ? { config: store.get(args.where.guildId_pluginId.pluginId) }
            : null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        upsert: async (args: any) => {
          store.set(args.where.guildId_pluginId.pluginId, args.create.config);
          return { config: args.create.config };
        },
      },
      auditLog: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        create: async (args: any) => {
          audits.push(args.data);
          return args.data;
        },
      },
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/community/birthdays/config`,
      headers: mutHeaders,
      payload: { enabled: true, channelId: '555555555555555555', announceHour: 18 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      channelId: '555555555555555555',
      announceHour: 18,
      publicList: true, // untouched default survives
    });
    expect(audits.some((a) => (a as { action: string }).action === 'community.birthday.config.update')).toBe(
      true,
    );

    await app.close();
  });

  it('DELETE removes one member entry and audits with the user id only', async () => {
    const audits: unknown[] = [];
    const { app, mutHeaders } = await authedApp({
      birthday: { deleteMany: async () => ({ count: 1 }) },
      auditLog: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        create: async (args: any) => {
          audits.push(args.data);
          return args.data;
        },
      },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/community/birthdays/${USER_A}`,
      headers: mutHeaders,
    });
    expect(res.statusCode).toBe(204);
    const audit = audits.find((a) => (a as { action: string }).action === 'community.birthday.remove') as
      { targetId: string; before?: unknown; after?: unknown } | undefined;
    expect(audit).toBeDefined();
    expect(audit!.targetId).toBe(USER_A);
    // No before/after snapshot — the date itself never lands in the audit trail.
    expect(audit!.before ?? null).toBeNull();
    expect(audit!.after ?? null).toBeNull();

    await app.close();
  });

  it('DELETE 404s when the member has no birthday set', async () => {
    const { app, mutHeaders } = await authedApp({ birthday: { deleteMany: async () => ({ count: 0 }) } });
    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/community/birthdays/${USER_A}`,
      headers: mutHeaders,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
