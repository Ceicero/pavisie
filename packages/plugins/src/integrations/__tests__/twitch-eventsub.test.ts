import RedisMock from 'ioredis-mock';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationConnection } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';

// Same static-import trick as `twitch-provider.test.ts`: no top-level import of the provider module.
let twitchProvider: typeof import('../providers/twitch').twitchProvider;
let ensureTwitchEventSub: typeof import('../providers/twitch').ensureTwitchEventSub;
let cleanupOrphanedTwitchEventSubs: typeof import('../providers/twitch').cleanupOrphanedTwitchEventSubs;
let normalizeTwitchLogin: typeof import('../providers/twitch').normalizeTwitchLogin;
let lookupTwitchUser: typeof import('../providers/twitch').lookupTwitchUser;
let resetTwitchEventSubState: typeof import('../providers/twitch').resetTwitchEventSubState;
let twitchEventSubCleanupJob: typeof import('../jobs/twitch-eventsub-cleanup').twitchEventSubCleanupJob;

beforeAll(async () => {
  ({
    twitchProvider,
    ensureTwitchEventSub,
    cleanupOrphanedTwitchEventSubs,
    normalizeTwitchLogin,
    lookupTwitchUser,
    resetTwitchEventSubState,
  } = await import('../providers/twitch'));
  ({ twitchEventSubCleanupJob } = await import('../jobs/twitch-eventsub-cleanup'));
});

const originalFetch = globalThis.fetch;
const CHANNEL_ID = '123456789012345678';
const NEW_CALLBACK = 'https://api.pavisie.com/webhooks/twitch';
const OLD_CALLBACK = 'https://api.entrophybot.com/webhooks/twitch';

beforeEach(async () => {
  await new RedisMock().flushall();
  resetTwitchEventSubState();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    TWITCH_CLIENT_ID: 'client-id',
    TWITCH_CLIENT_SECRET: 'client-secret',
    TWITCH_EVENTSUB_SECRET: 'eventsub-secret',
    PUBLIC_WEBHOOK_BASE_URL: 'https://api.pavisie.com',
    ...overrides,
  } as unknown as PluginContext['env'];
}

function makeConnection(overrides: Record<string, unknown> = {}): IntegrationConnection {
  return {
    id: 'conn-1',
    guildId: 'guild-1',
    provider: 'TWITCH',
    label: null,
    status: 'CONNECTED',
    config: { target: 'somestreamer', channelId: CHANNEL_ID },
    externalAccountId: null,
    externalAccountName: null,
    lastSyncAt: null,
    lastError: null,
    connectedBy: 'user-1',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as IntegrationConnection;
}

interface FakeSub {
  id: string;
  status: string;
  type: string;
  condition: { broadcaster_user_id: string };
  transport: { method: 'webhook' | 'websocket'; callback?: string; session_id?: string };
}

function webhookSub(id: string, broadcaster: string, callback: string, status = 'enabled'): FakeSub {
  return {
    id,
    status,
    type: 'stream.online',
    condition: { broadcaster_user_id: broadcaster },
    transport: { method: 'webhook', callback },
  };
}
function websocketSub(id: string, broadcaster: string): FakeSub {
  return {
    id,
    status: 'enabled',
    type: 'stream.online',
    condition: { broadcaster_user_id: broadcaster },
    transport: { method: 'websocket', session_id: 'sess-1' },
  };
}

interface HelixFake {
  subs: FakeSub[];
  users: Record<string, { id: string; login: string; display_name: string }>;
  createStatus: number;
  listStatus: number;
  userStatus: number;
  requests: { method: string; url: string; body?: unknown }[];
}

/** A tiny in-memory Helix: token, users (single or multi-login), and the EventSub list/create/delete endpoints. */
function installHelix(initial: Partial<HelixFake> = {}) {
  const state: HelixFake = {
    subs: [],
    users: { somestreamer: { id: 'b-1', login: 'somestreamer', display_name: 'SomeStreamer' } },
    createStatus: 202,
    listStatus: 200,
    userStatus: 200,
    requests: [],
    ...initial,
  };
  let nextId = 1;
  globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    state.requests.push({ method, url: url.toString(), body });

    if (url.host === 'id.twitch.tv') {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.pathname === '/helix/users') {
      if (state.userStatus !== 200) return new Response('{}', { status: state.userStatus });
      const logins = url.searchParams.getAll('login');
      const data = logins.flatMap((l) => (state.users[l.toLowerCase()] ? [state.users[l.toLowerCase()]!] : []));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    if (url.pathname === '/helix/eventsub/subscriptions') {
      if (method === 'GET') {
        if (state.listStatus !== 200) return new Response('{}', { status: state.listStatus });
        return new Response(JSON.stringify({ data: state.subs, pagination: {} }), { status: 200 });
      }
      if (method === 'POST') {
        if (state.createStatus !== 202) return new Response('{}', { status: state.createStatus });
        const payload = body as { condition: { broadcaster_user_id: string }; transport: { callback: string } };
        const sub = webhookSub(
          `new-sub-${nextId++}`,
          payload.condition.broadcaster_user_id,
          payload.transport.callback,
          'webhook_callback_verification_pending',
        );
        state.subs.push(sub);
        return new Response(JSON.stringify({ data: [sub] }), { status: 202 });
      }
      if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        state.subs = state.subs.filter((s) => s.id !== id);
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`twitch-eventsub.test: unexpected ${method} ${url.toString()}`);
  }) as unknown as typeof fetch;
  return state;
}

const deletes = (h: HelixFake) => h.requests.filter((r) => r.method === 'DELETE');
const creates = (h: HelixFake) => h.requests.filter((r) => r.method === 'POST' && r.url.includes('eventsub'));
const lists = (h: HelixFake) =>
  h.requests.filter((r) => r.method === 'GET' && r.url.includes('/helix/eventsub/subscriptions'));
const deletedIds = (h: HelixFake) => deletes(h).map((r) => new URL(r.url).searchParams.get('id'));

describe('normalizeTwitchLogin', () => {
  it('lowercases, strips @ and accepts twitch.tv URLs', () => {
    expect(normalizeTwitchLogin('Shroud')).toBe('shroud');
    expect(normalizeTwitchLogin('  @Some_Streamer  ')).toBe('some_streamer');
    expect(normalizeTwitchLogin('https://www.twitch.tv/Shroud/')).toBe('shroud');
    expect(normalizeTwitchLogin('twitch.tv/shroud')).toBe('shroud');
  });

  it('rejects anything that cannot be a Twitch login', () => {
    for (const bad of ['', '   ', 'has space', 'bad-name', 'x'.repeat(26), 'https://youtube.com/shroud', 'a/b']) {
      expect(normalizeTwitchLogin(bad)).toBeNull();
    }
  });
});

describe('lookupTwitchUser', () => {
  it('reports found / not_found / error distinctly', async () => {
    const { ctx } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix();
    expect(await lookupTwitchUser(ctx, 'SomeStreamer')).toEqual({
      status: 'found',
      id: 'b-1',
      login: 'somestreamer',
      displayName: 'SomeStreamer',
    });
    expect(await lookupTwitchUser(ctx, 'ghost')).toEqual({ status: 'not_found' });
    helix.userStatus = 503;
    expect(await lookupTwitchUser(ctx, 'somestreamer')).toEqual({ status: 'error' });
  });

  it('is an error (not "not found") when Twitch is not configured', async () => {
    const { ctx } = createTestContext({ overrides: { env: makeEnv({ TWITCH_CLIENT_ID: undefined }) } });
    installHelix();
    expect(await lookupTwitchUser(ctx, 'somestreamer')).toEqual({ status: 'error' });
  });
});

describe('ensureTwitchEventSub', () => {
  it('creates a subscription at the current callback when none exists, and stores its id', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix();

    const result = await ensureTwitchEventSub(ctx, makeConnection());

    expect(result).toBe('subscribed');
    expect(lists(helix)).toHaveLength(1);
    expect(new URL(lists(helix)[0]!.url).searchParams.get('type')).toBe('stream.online');
    expect(creates(helix)).toHaveLength(1);
    const body = creates(helix)[0]!.body as { transport: { method: string; callback: string; secret: string } };
    expect(body.transport).toMatchObject({ method: 'webhook', callback: NEW_CALLBACK });
    const update = prismaCalls.find((c) => c.model === 'integrationConnection' && c.method === 'update');
    const data = (update!.args[0] as { data: { config: Record<string, unknown>; externalAccountId: string } }).data;
    expect(data.config.eventSubId).toBe('new-sub-1');
    expect(data.externalAccountId).toBe('b-1');
  });

  it('keeps a healthy subscription that already points at the current callback — no delete, no create', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix({ subs: [webhookSub('good-1', 'b-1', NEW_CALLBACK)] });

    expect(await ensureTwitchEventSub(ctx, makeConnection())).toBe('subscribed');

    expect(creates(helix)).toHaveLength(0);
    expect(deletes(helix)).toHaveLength(0);
    const update = prismaCalls.find((c) => c.model === 'integrationConnection' && c.method === 'update');
    expect(((update!.args[0] as { data: { config: Record<string, unknown> } }).data.config).eventSubId).toBe('good-1');
  });

  it('writes nothing when the good subscription is already recorded on the connection', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEnv() } });
    installHelix({ subs: [webhookSub('good-1', 'b-1', NEW_CALLBACK)] });
    const connection = makeConnection({
      config: { target: 'somestreamer', channelId: CHANNEL_ID, eventSubId: 'good-1' },
      externalAccountId: 'b-1',
      externalAccountName: 'SomeStreamer',
    });

    expect(await ensureTwitchEventSub(ctx, connection)).toBe('subscribed');
    expect(prismaCalls.filter((c) => c.method === 'update')).toHaveLength(0);
  });

  it('replaces a subscription that still points at the OLD callback domain', async () => {
    const { ctx } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix({ subs: [webhookSub('old-1', 'b-1', OLD_CALLBACK)] });

    expect(await ensureTwitchEventSub(ctx, makeConnection())).toBe('subscribed');

    expect(deletedIds(helix)).toEqual(['old-1']);
    expect(creates(helix)).toHaveLength(1);
    expect(helix.subs.map((s) => s.transport.callback)).toEqual([NEW_CALLBACK]);
  });

  it.each(['webhook_callback_verification_failed', 'authorization_revoked', 'notification_failures_exceeded'])(
    'replaces a subscription with the right callback but a dead status (%s)',
    async (status) => {
      const { ctx } = createTestContext({ overrides: { env: makeEnv() } });
      const helix = installHelix({ subs: [webhookSub('dead-1', 'b-1', NEW_CALLBACK, status)] });

      expect(await ensureTwitchEventSub(ctx, makeConnection())).toBe('subscribed');

      expect(deletedIds(helix)).toEqual(['dead-1']);
      expect(creates(helix)).toHaveLength(1);
    },
  );

  it('leaves a just-created subscription alone while its callback verification is still pending', async () => {
    const { ctx } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix({
      subs: [webhookSub('pending-1', 'b-1', NEW_CALLBACK, 'webhook_callback_verification_pending')],
    });

    expect(await ensureTwitchEventSub(ctx, makeConnection())).toBe('subscribed');
    expect(deletes(helix)).toHaveLength(0);
    expect(creates(helix)).toHaveLength(0);
  });

  it('deletes a stale duplicate even when a good subscription exists, and keeps the good one', async () => {
    const { ctx } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix({
      subs: [webhookSub('old-1', 'b-1', OLD_CALLBACK), webhookSub('good-1', 'b-1', NEW_CALLBACK)],
    });

    await ensureTwitchEventSub(ctx, makeConnection());

    expect(deletedIds(helix)).toEqual(['old-1']);
    expect(creates(helix)).toHaveLength(0);
  });

  it('never touches WebSocket subscriptions or other broadcasters', async () => {
    const { ctx } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix({
      subs: [websocketSub('ws-1', 'b-1'), webhookSub('other-1', 'b-999', OLD_CALLBACK)],
    });

    expect(await ensureTwitchEventSub(ctx, makeConnection())).toBe('subscribed');

    expect(deletes(helix)).toHaveLength(0);
    expect(creates(helix)).toHaveLength(1);
    expect(helix.subs.map((s) => s.id)).toEqual(expect.arrayContaining(['ws-1', 'other-1']));
  });

  it('treats a 409 on create as success (Twitch already has that exact subscription)', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEnv() } });
    installHelix({ createStatus: 409 });

    expect(await ensureTwitchEventSub(ctx, makeConnection())).toBe('subscribed');
    expect(prismaCalls.filter((c) => c.method === 'update')).toHaveLength(0); // no ERROR marked
  });

  it('falls back to a plain create when the subscription list cannot be read', async () => {
    const { ctx } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix({ listStatus: 500, subs: [webhookSub('old-1', 'b-1', OLD_CALLBACK)] });

    expect(await ensureTwitchEventSub(ctx, makeConnection())).toBe('subscribed');
    expect(deletes(helix)).toHaveLength(0); // never deletes blind
    expect(creates(helix)).toHaveLength(1);
  });

  it('lists once per run and shares it across connections (and picks up its own creates)', async () => {
    const { ctx } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix();

    await ensureTwitchEventSub(ctx, makeConnection({ id: 'conn-a' }));
    await ensureTwitchEventSub(ctx, makeConnection({ id: 'conn-b' })); // same broadcaster, another guild

    expect(lists(helix)).toHaveLength(1);
    expect(creates(helix)).toHaveLength(1); // second connection sees the first one's fresh subscription
  });

  it('`fresh` bypasses the cached list', async () => {
    const { ctx } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix({ subs: [webhookSub('good-1', 'b-1', NEW_CALLBACK)] });

    await ensureTwitchEventSub(ctx, makeConnection());
    await ensureTwitchEventSub(ctx, makeConnection(), { fresh: true });

    expect(lists(helix)).toHaveLength(2);
  });

  it('marks the connection ERROR with a clear message when the Twitch user does not exist', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEnv() } });
    const helix = installHelix();

    const result = await ensureTwitchEventSub(
      ctx,
      makeConnection({ config: { target: 'ghost', channelId: CHANNEL_ID } }),
    );

    expect(result).toBe('failed');
    expect(creates(helix)).toHaveLength(0);
    const err = prismaCalls.find((c) => c.method === 'update');
    expect((err!.args[0] as { data: { status: string; lastError: string } }).data).toMatchObject({
      status: 'ERROR',
      lastError: 'Twitch user "ghost" not found.',
    });
  });

  it('does not accuse the user of not existing when Twitch itself failed the lookup', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEnv() } });
    installHelix({ userStatus: 503 });

    expect(await ensureTwitchEventSub(ctx, makeConnection())).toBe('failed');
    expect(prismaCalls.filter((c) => c.method === 'update')).toHaveLength(0);
  });

  it('marks ERROR when Twitch rejects the create with a 4xx, but not for a transient 5xx', async () => {
    const rejected = createTestContext({ overrides: { env: makeEnv() } });
    installHelix({ createStatus: 400 });
    expect(await ensureTwitchEventSub(rejected.ctx, makeConnection())).toBe('failed');
    expect(
      rejected.prismaCalls.some(
        (c) => c.method === 'update' && (c.args[0] as { data: { status?: string } }).data.status === 'ERROR',
      ),
    ).toBe(true);

    resetTwitchEventSubState();
    const transient = createTestContext({ overrides: { env: makeEnv() } });
    installHelix({ createStatus: 503 });
    expect(await ensureTwitchEventSub(transient.ctx, makeConnection())).toBe('failed');
    expect(transient.prismaCalls.filter((c) => c.method === 'update')).toHaveLength(0);
  });

  it('is skipped (no Helix at all) when webhook delivery is not configured', async () => {
    const { ctx } = createTestContext({
      overrides: { env: makeEnv({ PUBLIC_WEBHOOK_BASE_URL: undefined, API_BASE_URL: undefined }) },
    });
    const helix = installHelix();
    expect(await ensureTwitchEventSub(ctx, makeConnection())).toBe('skipped');
    expect(helix.requests).toHaveLength(0);
  });

  it('accepts a trailing slash on the public base url without changing the callback', async () => {
    const { ctx } = createTestContext({
      overrides: { env: makeEnv({ PUBLIC_WEBHOOK_BASE_URL: 'https://api.pavisie.com/' }) },
    });
    const helix = installHelix({ subs: [webhookSub('good-1', 'b-1', NEW_CALLBACK)] });
    await ensureTwitchEventSub(ctx, makeConnection());
    expect(creates(helix)).toHaveLength(0);
    expect(deletes(helix)).toHaveLength(0);
  });
});

describe('twitchProvider.poll — failed ensure keeps the ERROR', () => {
  it('does not mark the connection synced (which would wipe the error) when the Twitch user is not found', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEnv() } });
    installHelix();

    await twitchProvider.poll!(ctx, makeConnection({ config: { target: 'ghost', channelId: CHANNEL_ID } }));

    const statuses = prismaCalls
      .filter((c) => c.method === 'update')
      .map((c) => (c.args[0] as { data: { status?: string } }).data.status);
    expect(statuses).toEqual(['ERROR']);
  });

  it('marks it synced after a successful ensure', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEnv() } });
    installHelix({ subs: [webhookSub('good-1', 'b-1', NEW_CALLBACK)] });

    await twitchProvider.poll!(ctx, makeConnection());

    const statuses = prismaCalls
      .filter((c) => c.method === 'update')
      .map((c) => (c.args[0] as { data: { status?: string } }).data.status);
    expect(statuses).toContain('CONNECTED');
  });
});

describe('cleanupOrphanedTwitchEventSubs', () => {
  function ctxWithConnections(rows: Partial<IntegrationConnection>[], envOverrides: Record<string, unknown> = {}) {
    return createTestContext({
      overrides: { env: makeEnv(envOverrides) },
      prismaOverrides: {
        integrationConnection: { findMany: async () => rows.map((r) => makeConnection(r as Record<string, unknown>)) },
      },
    });
  }

  it('deletes webhook subscriptions whose broadcaster has no active alert, keeps the watched ones', async () => {
    const { ctx } = ctxWithConnections([{ externalAccountId: 'b-1' }]);
    const helix = installHelix({
      subs: [
        webhookSub('watched', 'b-1', NEW_CALLBACK),
        webhookSub('orphan-old-domain', 'b-2', OLD_CALLBACK),
        webhookSub('orphan-new-domain', 'b-3', NEW_CALLBACK, 'webhook_callback_verification_failed'),
      ],
    });

    const result = await cleanupOrphanedTwitchEventSubs(ctx);

    expect(result).toEqual({ checked: 3, deleted: 2 });
    expect(deletedIds(helix).sort()).toEqual(['orphan-new-domain', 'orphan-old-domain']);
    expect(helix.subs.map((s) => s.id)).toEqual(['watched']);
  });

  it('never deletes WebSocket-transport subscriptions (the chat bot uses those), watched or not', async () => {
    const { ctx } = ctxWithConnections([]);
    const helix = installHelix({
      subs: [websocketSub('ws-orphan', 'b-77'), webhookSub('webhook-orphan', 'b-78', OLD_CALLBACK)],
    });

    const result = await cleanupOrphanedTwitchEventSubs(ctx);

    expect(result.deleted).toBe(1);
    expect(deletedIds(helix)).toEqual(['webhook-orphan']);
    expect(helix.subs.map((s) => s.id)).toEqual(['ws-orphan']);
  });

  it('ignores webhook subscriptions that do not point at our /webhooks/twitch receiver', async () => {
    const { ctx } = ctxWithConnections([]);
    const helix = installHelix({
      subs: [webhookSub('foreign', 'b-5', 'https://example.com/some/other/hook'), webhookSub('junk', 'b-6', 'not a url')],
    });

    expect(await cleanupOrphanedTwitchEventSubs(ctx)).toEqual({ checked: 0, deleted: 0 });
    expect(deletes(helix)).toHaveLength(0);
  });

  it('does not count chat-kind, no-target (legacy OAuth), soft-deleted or disconnected connections as active', async () => {
    const { ctx } = ctxWithConnections([
      { id: 'chat', config: { kind: 'chat' }, externalAccountId: 'b-1' },
      { id: 'legacy-oauth', config: {}, externalAccountId: 'b-2' },
      { id: 'deleted', externalAccountId: 'b-3', deletedAt: new Date() },
      { id: 'disconnected', externalAccountId: 'b-4', status: 'DISCONNECTED' } as never,
      { id: 'real', externalAccountId: 'b-5' },
    ]);
    const helix = installHelix({
      subs: ['b-1', 'b-2', 'b-3', 'b-4', 'b-5'].map((b) => webhookSub(`sub-${b}`, b, NEW_CALLBACK)),
    });

    await cleanupOrphanedTwitchEventSubs(ctx);

    expect(deletedIds(helix).sort()).toEqual(['sub-b-1', 'sub-b-2', 'sub-b-3', 'sub-b-4']);
    expect(helix.subs.map((s) => s.id)).toEqual(['sub-b-5']);
  });

  it('resolves a connection with no recorded broadcaster id by its login, so its subscription survives', async () => {
    const { ctx } = ctxWithConnections([{ externalAccountId: null, config: { target: 'SomeStreamer', channelId: CHANNEL_ID } }]);
    const helix = installHelix({
      subs: [webhookSub('mine', 'b-1', NEW_CALLBACK), webhookSub('orphan', 'b-2', NEW_CALLBACK)],
    });

    await cleanupOrphanedTwitchEventSubs(ctx);

    expect(deletedIds(helix)).toEqual(['orphan']);
  });

  it('deletes nothing when the subscription list cannot be read', async () => {
    const { ctx } = ctxWithConnections([]);
    const helix = installHelix({ listStatus: 500, subs: [webhookSub('orphan', 'b-2', OLD_CALLBACK)] });

    const result = await cleanupOrphanedTwitchEventSubs(ctx);

    expect(result.skipped).toBe('subscription list unavailable');
    expect(deletes(helix)).toHaveLength(0);
  });

  it('deletes nothing when a login cannot be resolved (it might be the watched broadcaster)', async () => {
    const { ctx } = ctxWithConnections([{ externalAccountId: null }]);
    const helix = installHelix({ userStatus: 500, subs: [webhookSub('maybe-mine', 'b-1', NEW_CALLBACK)] });

    const result = await cleanupOrphanedTwitchEventSubs(ctx);

    expect(result.skipped).toBe('login lookup failed');
    expect(deletes(helix)).toHaveLength(0);
  });

  it('does nothing when Twitch is not configured', async () => {
    const { ctx } = ctxWithConnections([], { TWITCH_CLIENT_ID: undefined });
    const helix = installHelix();
    expect((await cleanupOrphanedTwitchEventSubs(ctx)).skipped).toBe('twitch not configured');
    expect(helix.requests).toHaveLength(0);
  });
});

describe('twitchEventSubCleanupJob', () => {
  it('is a repeatable job that skips silently without Twitch credentials', async () => {
    expect(twitchEventSubCleanupJob.repeat).toBeDefined();
    const { ctx } = createTestContext({ overrides: { env: makeEnv({ TWITCH_CLIENT_SECRET: undefined }) } });
    const helix = installHelix();
    await twitchEventSubCleanupJob.processor(ctx, undefined as never);
    expect(helix.requests).toHaveLength(0);
  });

  it('runs the cleanup when configured', async () => {
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: { integrationConnection: { findMany: async () => [] } },
    });
    const helix = installHelix({ subs: [webhookSub('orphan', 'b-2', OLD_CALLBACK)] });
    await twitchEventSubCleanupJob.processor(ctx, undefined as never);
    expect(deletedIds(helix)).toEqual(['orphan']);
  });
});
