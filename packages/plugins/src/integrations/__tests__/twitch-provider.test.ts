import RedisMock from 'ioredis-mock';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationConnection } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';

// Regression coverage for the production bug where `pollTwitchJob` (poll.ts) selects every CONNECTED/ERROR
// `provider: TWITCH` connection — including twitch **chat-bot** connections, which the chat link OAuth callback
// stamps `config.kind === 'chat'` onto (see `isTwitchChatConnection` in `../providers/twitch.ts` and the
// equivalent `isChatKindConnection` in `apps/api/src/routes/integrations.ts`). Those rows have no alert
// `target`, so `ensureTwitchEventSub` used to call Helix with an empty `login`, get a 400, and mark the
// connection errored — every 2 minutes, forever. Same static-import trick as `twitch-chat-helix.test.ts`/
// `instagram.test.ts`: no top-level import of the provider module, so `process.env` can be seeded first.
let twitchProvider: typeof import('../providers/twitch').twitchProvider;
let ensureTwitchEventSub: typeof import('../providers/twitch').ensureTwitchEventSub;

beforeAll(async () => {
  ({ twitchProvider, ensureTwitchEventSub } = await import('../providers/twitch'));
});

const originalFetch = globalThis.fetch;
const CHANNEL_ID = '123456789012345678';

// ioredis-mock instances share one process-wide in-memory data store by default (see media/__tests__/queue.test.ts) —
// without this, `getTwitchAppToken`'s Redis-cached app token from an earlier test in this file would make a
// later test's "token fetch happened" assertion silently false instead of actually exercising the fetch call.
beforeEach(async () => {
  await new RedisMock().flushall();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Full env needed to reach the EventSub branch of `twitchProvider.poll` (webhook delivery configured) — the
 * branch that used to 400 against Helix for chat-kind/empty-target connections. */
function makeEventSubEnv(overrides: Record<string, unknown> = {}) {
  return {
    TWITCH_CLIENT_ID: 'client-id',
    TWITCH_CLIENT_SECRET: 'client-secret',
    TWITCH_EVENTSUB_SECRET: 'eventsub-secret',
    PUBLIC_WEBHOOK_BASE_URL: 'https://api.pavisie.com',
    ...overrides,
  } as unknown as PluginContext['env'];
}

function makeConnection(config: Record<string, unknown>): IntegrationConnection {
  return {
    id: 'conn-1',
    guildId: 'guild-1',
    provider: 'TWITCH',
    label: null,
    status: 'CONNECTED',
    config,
    externalAccountId: null,
    externalAccountName: null,
    lastSyncAt: null,
    lastError: null,
    connectedBy: 'user-1',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as IntegrationConnection;
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
}

function usersResponse(): Response {
  return new Response(
    JSON.stringify({ data: [{ id: 'broadcaster-1', login: 'somestreamer', display_name: 'SomeStreamer' }] }),
    { status: 200 },
  );
}

function eventSubCreateResponse(): Response {
  return new Response(JSON.stringify({ data: [{ id: 'eventsub-1' }] }), { status: 202 });
}

/** Routes fetch calls by URL to the three Helix/Twitch endpoints this flow can hit, and records every URL
 * requested so tests can assert exactly which calls did (and did not) happen. */
function makeFetchMock() {
  const urls: string[] = [];
  const fn = vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    if (url.startsWith('https://id.twitch.tv/oauth2/token')) return tokenResponse();
    if (url.includes('/helix/users')) return usersResponse();
    if (url.includes('/helix/eventsub/subscriptions')) return eventSubCreateResponse();
    throw new Error(`twitch-provider.test: unexpected fetch to ${url}`);
  });
  return { fn: fn as unknown as typeof fetch, urls };
}

describe('twitchProvider.poll', () => {
  it('skips a chat-kind connection entirely — no Helix call, no error marked', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEventSubEnv() } });
    const { fn, urls } = makeFetchMock();
    globalThis.fetch = fn;

    // `config.kind === 'chat'` is exactly what the twitch-chat OAuth callback stamps onto a chat-bot
    // connection — it has no `target`/`channelId` alert config at all.
    await twitchProvider.poll!(ctx, makeConnection({ kind: 'chat' }));

    expect(urls).toEqual([]); // never even asked for an app token
    expect(prismaCalls).toHaveLength(0); // no markConnectionError, no markConnectionSynced
  });

  it('skips an alert connection with an empty target — no Helix user/stream lookup, no error marked', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEventSubEnv() } });
    const { fn, urls } = makeFetchMock();
    globalThis.fetch = fn;

    // A real alert connection shape, just never finished being configured with a target.
    await twitchProvider.poll!(ctx, makeConnection({ channelId: CHANNEL_ID }));

    // The app token fetch still happens (it comes before the target check), but Helix is never asked to
    // resolve a broadcaster or create a subscription for an empty login.
    expect(urls.some((u) => u.includes('/helix/users'))).toBe(false);
    expect(urls.some((u) => u.includes('/helix/eventsub'))).toBe(false);

    const errorCalls = prismaCalls.filter(
      (c) =>
        c.model === 'integrationConnection' &&
        c.method === 'update' &&
        (c.args[0] as { data?: { status?: string } })?.data?.status === 'ERROR',
    );
    expect(errorCalls).toHaveLength(0);
  });

  it('still performs the Helix user lookup and EventSub create for a normal, targeted alert connection', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEventSubEnv() } });
    const { fn, urls } = makeFetchMock();
    globalThis.fetch = fn;

    await twitchProvider.poll!(ctx, makeConnection({ target: 'somestreamer', channelId: CHANNEL_ID }));

    expect(urls.some((u) => u.startsWith('https://id.twitch.tv/oauth2/token'))).toBe(true);
    expect(urls.some((u) => u.includes('/helix/users?login=somestreamer'))).toBe(true);
    expect(urls.some((u) => u.includes('/helix/eventsub/subscriptions'))).toBe(true);

    // Persisted eventSubId/externalAccountId/externalAccountName exactly as `ensureTwitchEventSub` always has.
    const persistCall = prismaCalls.find(
      (c) =>
        c.model === 'integrationConnection' &&
        c.method === 'update' &&
        (c.args[0] as { data?: { externalAccountId?: string } })?.data?.externalAccountId === 'broadcaster-1',
    );
    expect(persistCall).toBeDefined();
    const data = (persistCall!.args[0] as { data: Record<string, unknown> }).data;
    expect(data.externalAccountName).toBe('SomeStreamer');
    expect((data.config as Record<string, unknown>).eventSubId).toBe('eventsub-1');

    const errorCalls = prismaCalls.filter(
      (c) =>
        c.model === 'integrationConnection' &&
        c.method === 'update' &&
        (c.args[0] as { data?: { status?: string } })?.data?.status === 'ERROR',
    );
    expect(errorCalls).toHaveLength(0);
  });
});

describe('ensureTwitchEventSub', () => {
  it('returns before calling Helix when the connection has no target, without marking an error', async () => {
    const { ctx, prismaCalls } = createTestContext({ overrides: { env: makeEventSubEnv() } });
    const { fn, urls } = makeFetchMock();
    globalThis.fetch = fn;

    await ensureTwitchEventSub(ctx, makeConnection({ channelId: CHANNEL_ID }));

    expect(urls.some((u) => u.includes('/helix/users'))).toBe(false);
    expect(prismaCalls).toHaveLength(0); // no markConnectionError call at all
  });
});
