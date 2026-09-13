import { describe, expect, it } from 'vitest';
import type { PrismaStubOverrides } from '@pavisie/plugins/sdk/testing';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '666666666666666666';
const USER_ID = '777777777777777777';

function guildOverrides() {
  return { guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) } };
}

function integrationConnectionOverrides() {
  const rows = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  const overrides = {
    integrationConnection: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake, args shape mirrors Prisma's generated types
      create: async (args: any) => {
        const id = `conn${nextId++}`;
        const row = {
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSyncAt: null,
          lastError: null,
          externalAccountId: null,
          externalAccountName: null,
          deletedAt: null,
          ...args.data,
        };
        rows.set(id, row);
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async (args: any) => {
        const where = args?.where ?? {};
        let list = [...rows.values()];
        if (where.guildId !== undefined) list = list.filter((r) => r.guildId === where.guildId);
        if (where.deletedAt !== undefined) list = list.filter((r) => r.deletedAt === where.deletedAt);
        const providerFilter = where.provider;
        if (providerFilter) {
          if (typeof providerFilter === 'string') list = list.filter((r) => r.provider === providerFilter);
          else if (providerFilter.in) list = list.filter((r) => providerFilter.in.includes(r.provider));
        }
        // The one JSON path filter shape routes/integrations.ts still uses: `{ path: [...], equals: value }`
        // (`chatConnectionIds`). Alert-watch rows are NOT filtered in SQL — that check is a *presence* test,
        // whose Postgres semantics this stub could not faithfully model anyway, so the route partitions those
        // in JS instead (see `isAlertWatchConnection`). The `not` branch below is kept only so this stub stays
        // honest about the difference if a future filter needs it.
        if (where.config?.path) {
          const { path } = where.config as { path: string[]; equals?: unknown };
          const isPresenceCheck = 'not' in where.config;
          list = list.filter((r) => {
            let val: unknown = r.config;
            for (const key of path) val = (val as Record<string, unknown> | undefined)?.[key];
            if (isPresenceCheck) return val !== undefined;
            return val === (where.config as { equals?: unknown }).equals;
          });
        }
        if (where.id?.notIn) {
          const excluded: string[] = where.id.notIn;
          list = list.filter((r) => !excluded.includes(r.id as string));
        }
        return list;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async (args: any) =>
        [...rows.values()].find(
          (r) =>
            r.id === args.where.id &&
            r.guildId === args.where.guildId &&
            (args.where.deletedAt === undefined || r.deletedAt === args.where.deletedAt),
        ) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async (args: any) => {
        const existing = rows.get(args.where.id)!;
        const updated = { ...existing, ...args.data };
        rows.set(args.where.id, updated);
        return updated;
      },
    },
    ...guildOverrides(),
  };
  return { overrides, rows };
}

function webhookEndpointOverrides() {
  const rows = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  return {
    webhookEndpoint: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (args: any) => {
        const id = `hook${nextId++}`;
        const row = {
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          failureCount: 0,
          lastDeliveryAt: null,
          enabled: true,
          channelId: null,
          url: null,
          deletedAt: null,
          ...args.data,
        };
        rows.set(id, row);
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async (args: any) =>
        [...rows.values()].filter(
          (r) =>
            r.guildId === args?.where?.guildId &&
            r.direction === args?.where?.direction &&
            r.deletedAt === null,
        ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async (args: any) =>
        [...rows.values()].find((r) => r.id === args.where.id && r.guildId === args.where.guildId) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async (args: any) => {
        const existing = rows.get(args.where.id)!;
        const updated = { ...existing, ...args.data };
        rows.set(args.where.id, updated);
        return updated;
      },
    },
    ...guildOverrides(),
  };
}

async function setupAuthedApp(overrides: PrismaStubOverrides) {
  const { app, redis, ...rest } = await buildTestApp(overrides);
  const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  return { app, redis, cookieHeader, csrfToken: session.csrfToken, ...rest };
}

describe('GET /guilds/:guildId/integrations/providers', () => {
  it('returns availability for all 8 providers', async () => {
    const { app, cookieHeader } = await setupAuthedApp(guildOverrides());
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/providers`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; available: boolean }[];
    expect(body).toHaveLength(8);
    expect(body.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        'twitch',
        'youtube',
        'instagram',
        'reddit',
        'steam',
        'google_calendar',
        'microsoft_calendar',
        'generic_webhook',
      ]),
    );
    // GitHub, Notion and Stripe were removed as offered providers 2026-09-02 — pin their absence, not just the
    // count, so a future addition can't silently restore one of them under this same total.
    expect(body.map((p) => p.id)).not.toEqual(expect.arrayContaining(['github', 'notion', 'stripe']));
    await app.close();
  });
});

describe('alert connections', () => {
  it('creates, lists, and deletes an alert watch', async () => {
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(integrationConnectionOverrides().overrides);

    const create = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/alerts`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { provider: 'twitch', target: 'shroud', channelId: '888888888888888888' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; target: string };
    expect(created.target).toBe('shroud');

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/alerts`,
      headers: { cookie: cookieHeader },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/alerts/${created.id}`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(del.statusCode).toBe(204);

    const listAfter = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/alerts`,
      headers: { cookie: cookieHeader },
    });
    expect(listAfter.json()).toHaveLength(0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Chat-kind connections (`config.kind === 'chat'`, created by the twitch-chat OAuth callback — see
// `oauth-integrations.ts`) must never surface as a generic connection or an alert watch, and must be
// undeletable via either of those routes — they belong entirely to `routes/twitch-chat.ts`.
// ---------------------------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture row, mirrors the `create()` defaults above
function connectionRow(overrides: Record<string, unknown>): any {
  return {
    status: 'CONNECTED',
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSyncAt: null,
    lastError: null,
    externalAccountId: null,
    externalAccountName: null,
    deletedAt: null,
    label: null,
    connectedBy: USER_ID,
    ...overrides,
  };
}

describe('chat-kind connections are hidden from the generic/alert routes', () => {
  it('excludes a chat-kind connection from the generic connections list, both with and without a `kind` key on other rows', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set(
      'conn-chat',
      connectionRow({ id: 'conn-chat', guildId: GUILD_ID, provider: 'TWITCH', config: { kind: 'chat' } }),
    );
    // A normal connection with the *same* provider (TWITCH) whose `config` never had a `kind` key at all (the
    // common case) — proves the exclusion is keyed on `config.kind`, not `provider`, and that this shape is
    // exactly what a naive `NOT`-negated JSON-path filter would wrongly exclude too (see `chatConnectionIds`'s
    // doc comment in routes/integrations.ts).
    rows.set(
      'conn-normal',
      connectionRow({ id: 'conn-normal', guildId: GUILD_ID, provider: 'TWITCH', config: {} }),
    );
    const { app, cookieHeader } = await setupAuthedApp(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string }[];
    expect(body.map((c) => c.id)).toEqual(['conn-normal']);
    await app.close();
  });

  it('excludes a chat-kind connection from the alerts list while a real Twitch alert watch still shows', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set(
      'conn-chat',
      connectionRow({ id: 'conn-chat', guildId: GUILD_ID, provider: 'TWITCH', config: { kind: 'chat' } }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(overrides);

    const create = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/alerts`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { provider: 'twitch', target: 'shroud', channelId: '888888888888888888' },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/alerts`,
      headers: { cookie: cookieHeader },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { id: string; target: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.target).toBe('shroud');
    await app.close();
  });

  it('404s deleting a chat-kind connection via the alerts route, leaving it untouched', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set(
      'conn-chat',
      connectionRow({ id: 'conn-chat', guildId: GUILD_ID, provider: 'TWITCH', config: { kind: 'chat' } }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(overrides);

    const res = await app.inject({
      method: 'DELETE',
      url: `/guilds/${GUILD_ID}/integrations/alerts/conn-chat`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(res.statusCode).toBe(404);
    expect(rows.get('conn-chat')?.status).toBe('CONNECTED');
    expect(rows.get('conn-chat')?.deletedAt).toBeNull();
    await app.close();
  });

  it('404s the generic disconnect route for a chat-kind connection, but still disconnects a normal one', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set(
      'conn-chat',
      connectionRow({ id: 'conn-chat', guildId: GUILD_ID, provider: 'TWITCH', config: { kind: 'chat' } }),
    );
    rows.set(
      'conn-normal',
      connectionRow({ id: 'conn-normal', guildId: GUILD_ID, provider: 'GITHUB', config: {}, status: 'CONNECTED' }),
    );
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(overrides);

    const chatRes = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/conn-chat/disconnect`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(chatRes.statusCode).toBe(404);
    expect(rows.get('conn-chat')?.status).toBe('CONNECTED');

    const normalRes = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/conn-normal/disconnect`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(normalRes.statusCode).toBe(200);
    expect(rows.get('conn-normal')?.status).toBe('DISCONNECTED');
    await app.close();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Alert-watch rows (`config.channelId` set — see `POST .../integrations/alerts`) must also be hidden from
// `GET /:guildId/integrations` (defect 1: before this fix, every alert watch also rendered as a "connected
// account" on the Providers card, with a Disconnect button that used the wrong deletion path and left a
// zombie row behind — see `genericConnections`'s doc comment in routes/integrations.ts).
// ---------------------------------------------------------------------------------------------------------

describe('alert-watch rows are hidden from GET /:guildId/integrations (defect 1 regression)', () => {
  it('excludes an alert-watch row while still returning a generic OAuth row and a webhook-provider row', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set(
      'conn-alert',
      connectionRow({
        id: 'conn-alert',
        guildId: GUILD_ID,
        provider: 'TWITCH',
        config: { target: 'shroud', channelId: '888888888888888888', roleId: null, template: null },
      }),
    );
    // A generic OAuth-connected Twitch account (the multi-account-integrations "connect" flow) — has none of
    // an alert watch's fields, must still show up.
    rows.set(
      'conn-oauth',
      connectionRow({ id: 'conn-oauth', guildId: GUILD_ID, provider: 'TWITCH', config: {} }),
    );
    // A webhook-established connection (e.g. GitHub) — same `config: {}` shape as the generic OAuth row, must
    // also still show up.
    rows.set(
      'conn-webhook',
      connectionRow({ id: 'conn-webhook', guildId: GUILD_ID, provider: 'GITHUB', config: {} }),
    );
    const { app, cookieHeader } = await setupAuthedApp(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string }[];
    expect(body.map((c) => c.id).sort()).toEqual(['conn-oauth', 'conn-webhook']);
    await app.close();
  });

  it('returns an empty array, not an error, for a guild with only alert watches', async () => {
    const { overrides, rows } = integrationConnectionOverrides();
    rows.set(
      'conn-alert',
      connectionRow({
        id: 'conn-alert',
        guildId: GUILD_ID,
        provider: 'TWITCH',
        config: { target: 'shroud', channelId: '888888888888888888', roleId: null, template: null },
      }),
    );
    const { app, cookieHeader } = await setupAuthedApp(overrides);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });
});

describe('outbound webhooks', () => {
  it('rejects a private-IP URL at creation (SSRF)', async () => {
    const { app, cookieHeader, csrfToken } = await setupAuthedApp(webhookEndpointOverrides());
    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/outbound`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { name: 'internal', url: 'https://127.0.0.1/hook', events: ['moderation.caseCreated'] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('creates an outbound webhook, lists it, and queues a test delivery', async () => {
    const { app, cookieHeader, csrfToken, queues } = await setupAuthedApp(webhookEndpointOverrides());

    const create = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/outbound`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: {
        name: 'my hook',
        url: 'https://example.com/hook',
        events: ['moderation.caseCreated', 'ticket.opened'],
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; secret: string };
    expect(created.secret).toBeTruthy();

    const list = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/integrations/outbound`,
      headers: { cookie: cookieHeader },
    });
    expect(list.json()).toHaveLength(1);

    const test = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/integrations/outbound/${created.id}/test`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });
    expect(test.statusCode).toBe(200);
    expect(
      queues.calls.some(
        (c) => c.queue === 'bot-actions' && (c.data as { type: string }).type === 'integrations.testWebhook',
      ),
    ).toBe(true);

    await app.close();
  });
});
