import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AUTOMOD_RULES_CHANGED_CHANNEL } from '@pavisie/plugins/automod/rule-sync';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '111111111111111111';
const USER_ID = '222222222222222222';

interface FakeRule {
  id: string;
  guildId: string;
  name: string;
  type: string;
  enabled: boolean;
  dryRun: boolean;
  config: Record<string, unknown>;
  actions: Record<string, unknown>[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  exemptUserIds: string[];
  trustedDomains: string[];
  cooldownSeconds: number;
  priority: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Minimal stateful `automodRule`/`automodEvent` fake — mirrors the shape of the real Prisma delegate methods this route uses. */
function automodOverrides() {
  const rules = new Map<string, FakeRule>();
  const events = new Map<string, Record<string, unknown>>();

  return {
    store: { rules, events },
    overrides: {
      automodRule: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake, args shape mirrors Prisma's generated types
        findMany: async (args: any) => {
          return [...rules.values()].filter(
            (r) =>
              r.guildId === args?.where?.guildId &&
              (args?.where?.deletedAt === undefined || r.deletedAt === args.where.deletedAt),
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findFirst: async (args: any) => {
          const found = rules.get(args?.where?.id);
          if (!found) return null;
          if (args?.where?.guildId && found.guildId !== args.where.guildId) return null;
          if (args?.where?.deletedAt === null && found.deletedAt !== null) return null;
          return found;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: async (args: any) => {
          const row: FakeRule = {
            id: randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            ...args.data,
          };
          rules.set(row.id, row);
          return row;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: async (args: any) => {
          const existing = rules.get(args.where.id);
          if (!existing) throw new Error('not found');
          const updated = { ...existing, ...args.data, updatedAt: new Date() };
          rules.set(existing.id, updated);
          return updated;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateMany: async (args: any) => {
          let count = 0;
          for (const [id, r] of rules) {
            if (
              r.guildId === args.where.guildId &&
              (args.where.deletedAt === undefined || r.deletedAt === args.where.deletedAt)
            ) {
              rules.set(id, { ...r, ...args.data });
              count += 1;
            }
          }
          return { count };
        },
      },
      automodEvent: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany: async (args: any) => {
          let list = [...events.values()].filter((e) => e.guildId === args?.where?.guildId);
          if (args?.where?.reviewStatus)
            list = list.filter((e) => e.reviewStatus === args.where.reviewStatus);
          return list;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findFirst: async (args: any) => {
          const found = events.get(args?.where?.id);
          if (!found) return null;
          if (args?.where?.guildId && found.guildId !== args.where.guildId) return null;
          return found;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: async (args: any) => {
          const existing = events.get(args.where.id);
          if (!existing) throw new Error('not found');
          const updated = { ...existing, ...args.data };
          events.set(args.where.id as string, updated);
          return updated;
        },
      },
    },
  };
}

async function authedContext() {
  const { store, overrides } = automodOverrides();
  const { app, redis } = await buildTestApp({
    guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    ...overrides,
  });
  const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  const mutHeaders = {
    cookie: cookieHeader,
    origin: 'http://localhost:3000',
    'x-csrf-token': session.csrfToken,
  };
  return { app, cookieHeader, mutHeaders, store, redis };
}

describe('automod rules CRUD', () => {
  it('GET returns an empty list when no rules exist', async () => {
    const { app, cookieHeader } = await authedContext();
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('POST creates a rule validated against the shared schema', async () => {
    const { app, mutHeaders } = await authedContext();
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: mutHeaders,
      payload: {
        name: 'No spam',
        enabled: true,
        dryRun: true,
        config: { type: 'MESSAGE_FREQUENCY', maxMessages: 5, windowSeconds: 10 },
        actions: [{ type: 'warn' }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('No spam');
    expect(res.json().type).toBe('MESSAGE_FREQUENCY');
    await app.close();
  });

  it('POST rejects a rule with an invalid config for its declared type', async () => {
    const { app, mutHeaders } = await authedContext();
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: mutHeaders,
      payload: {
        name: 'Bad',
        config: { type: 'MESSAGE_FREQUENCY', maxMessages: 'not-a-number' },
        actions: [{ type: 'warn' }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST rejects a catastrophic regex pattern', async () => {
    const { app, mutHeaders } = await authedContext();
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: mutHeaders,
      payload: {
        name: 'Evil regex',
        config: { type: 'REGEX_FILTER', pattern: '(a+)+$', flags: 'i' },
        actions: [{ type: 'warn' }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PUT toggles dry-run for a single rule, and POST .../dry-run toggles every rule', async () => {
    const { app, mutHeaders, cookieHeader } = await authedContext();
    const created = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: mutHeaders,
      payload: { name: 'Rule', config: { type: 'CAPS' }, actions: [{ type: 'warn' }] },
    });
    const ruleId = created.json().id;

    const toggled = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules/${ruleId}/dry-run`,
      headers: mutHeaders,
      payload: { dryRun: false },
    });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().dryRun).toBe(false);

    const guildWide = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/dry-run`,
      headers: mutHeaders,
      payload: { dryRun: true },
    });
    expect(guildWide.statusCode).toBe(200);
    expect(guildWide.json().rulesAffected).toBe(1);

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: { cookie: cookieHeader },
    });
    expect(list.json()[0].dryRun).toBe(true);
    await app.close();
  });

  it('DELETE soft-deletes a rule (404s afterward from the list)', async () => {
    const { app, mutHeaders, cookieHeader } = await authedContext();
    const created = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: mutHeaders,
      payload: { name: 'Temp', config: { type: 'CAPS' }, actions: [{ type: 'ignore' }] },
    });
    const ruleId = created.json().id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/automod/rules/${ruleId}`,
      headers: mutHeaders,
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: { cookie: cookieHeader },
    });
    expect(list.json()).toEqual([]);
    await app.close();
  });

  it('404s deleting an unknown rule id', async () => {
    const { app, mutHeaders } = await authedContext();
    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/automod/rules/does-not-exist`,
      headers: mutHeaders,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /:guildId/automod/rules/:ruleId/test', () => {
  it('reports a match for text that trips the stored rule', async () => {
    const { app, mutHeaders } = await authedContext();
    const created = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: mutHeaders,
      payload: {
        name: 'Word filter',
        config: { type: 'WORD_FILTER', words: ['badword'] },
        actions: [{ type: 'warn' }],
      },
    });
    const ruleId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules/${ruleId}/test`,
      headers: mutHeaders,
      payload: { text: 'this message has badword in it' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().matched).toBe(true);
  });

  it('reports no match for clean text', async () => {
    const { app, mutHeaders } = await authedContext();
    const created = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: mutHeaders,
      payload: {
        name: 'Word filter',
        config: { type: 'WORD_FILTER', words: ['badword'] },
        actions: [{ type: 'warn' }],
      },
    });
    const ruleId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules/${ruleId}/test`,
      headers: mutHeaders,
      payload: { text: 'a perfectly clean message' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().matched).toBe(false);
  });

  it('404s for an unknown rule id', async () => {
    const { app, mutHeaders } = await authedContext();
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules/does-not-exist/test`,
      headers: mutHeaders,
      payload: { text: 'anything' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('automod events review', () => {
  it('PATCH marks an event reviewed and audits it', async () => {
    const { app, mutHeaders, store } = await authedContext();
    store.events.set('event1', {
      id: 'event1',
      guildId: GUILD_ID,
      ruleId: 'rule1',
      userId: 'u1',
      channelId: 'c1',
      matched: null,
      actionsTaken: ['warn'],
      dryRun: true,
      reviewStatus: 'PENDING',
      riskScore: null,
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/automod/events/event1/review`,
      headers: mutHeaders,
      payload: { reviewStatus: 'FALSE_POSITIVE' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reviewStatus).toBe('FALSE_POSITIVE');
  });

  it('404s reviewing an unknown event', async () => {
    const { app, mutHeaders } = await authedContext();
    const res = await app.inject({
      method: 'PATCH',
      url: `/guilds/${GUILD_ID}/automod/events/nope/review`,
      headers: mutHeaders,
      payload: { reviewStatus: 'CONFIRMED' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// The bot caches each guild's rules. Every route that writes a rule must announce the change on Redis, or a
// dashboard edit (including disabling or deleting a rule) keeps being ignored until the bot's cache expires.
describe('automod rule writes announce the change to the bot', () => {
  async function announcingContext() {
    const context = await authedContext();
    const announced: string[] = [];
    const publish = context.redis.publish.bind(context.redis);
    vi.spyOn(context.redis, 'publish').mockImplementation(((channel: string, message: string) => {
      if (channel === AUTOMOD_RULES_CHANGED_CHANNEL) {
        announced.push((JSON.parse(message) as { guildId: string }).guildId);
      }
      return publish(channel, message);
    }) as never);
    const createRule = async () => {
      const created = await context.app.inject({
        method: 'POST',
        url: `/guilds/${GUILD_ID}/automod/rules`,
        headers: context.mutHeaders,
        payload: { name: 'Rule', config: { type: 'CAPS' }, actions: [{ type: 'warn' }] },
      });
      return created.json().id as string;
    };
    return { ...context, announced, createRule };
  }

  it('announces a created rule', async () => {
    const { app, announced, createRule } = await announcingContext();
    await createRule();
    expect(announced).toEqual([GUILD_ID]);
    await app.close();
  });

  it('announces an edited rule', async () => {
    const { app, mutHeaders, announced, createRule } = await announcingContext();
    const ruleId = await createRule();
    announced.length = 0;

    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/automod/rules/${ruleId}`,
      headers: mutHeaders,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(announced).toEqual([GUILD_ID]);
    await app.close();
  });

  it('announces a deleted rule', async () => {
    const { app, mutHeaders, announced, createRule } = await announcingContext();
    const ruleId = await createRule();
    announced.length = 0;

    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/automod/rules/${ruleId}`,
      headers: mutHeaders,
    });

    expect(res.statusCode).toBe(204);
    expect(announced).toEqual([GUILD_ID]);
    await app.close();
  });

  it('announces a dry-run toggle, for one rule and for every rule', async () => {
    const { app, mutHeaders, announced, createRule } = await announcingContext();
    const ruleId = await createRule();
    announced.length = 0;

    await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules/${ruleId}/dry-run`,
      headers: mutHeaders,
      payload: { dryRun: false },
    });
    await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/dry-run`,
      headers: mutHeaders,
      payload: { dryRun: true },
    });

    expect(announced).toEqual([GUILD_ID, GUILD_ID]);
    await app.close();
  });

  it('announces nothing for reads, rejected writes, or unknown rules', async () => {
    const { app, mutHeaders, cookieHeader, announced } = await announcingContext();

    await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: { cookie: cookieHeader },
    });
    await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: mutHeaders,
      payload: { name: 'Bad', config: { type: 'CAPS', maxCapsPercent: 500 }, actions: [{ type: 'warn' }] },
    });
    await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/automod/rules/does-not-exist`,
      headers: mutHeaders,
    });

    expect(announced).toEqual([]);
    await app.close();
  });

  it('still saves the rule when Redis cannot publish', async () => {
    const { app, mutHeaders, redis } = await authedContext();
    vi.spyOn(redis, 'publish').mockRejectedValue(new Error('redis unavailable'));

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/automod/rules`,
      headers: mutHeaders,
      payload: { name: 'Rule', config: { type: 'CAPS' }, actions: [{ type: 'warn' }] },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
