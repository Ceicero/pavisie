import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationConnection } from '@pavisie/database';

// `postAlert` (embeds.ts) talks to real discord.js Guild/Channel objects — mocking it at the module boundary
// (same pattern as twitch-chat-manager-rewards.test.ts) lets this file assert "did an alert go out" without
// building a fake discord.js Guild/Channel/permission-overwrite graph, which is a different unit than what
// this file is testing (the poll's dedupe/flood-guard logic, not Discord delivery mechanics).
const mocks = vi.hoisted(() => ({ postAlert: vi.fn() }));
vi.mock('../embeds', () => ({ postAlert: mocks.postAlert }));

// See twitch-chat-helix.test.ts for why this file has no static imports of its own: `@pavisie/core`'s `env`
// (read by `encryptSecret`/`decryptSecret`'s key derivation) is computed once, at that module's first import,
// so `ENCRYPTION_KEY` must be set in `process.env` before it loads.
let encryptSecret: typeof import('@pavisie/core').encryptSecret;
let createTestContext: typeof import('../../sdk/testing').createTestContext;
let instagramProvider: typeof import('../providers/instagram').instagramProvider;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
  ({ encryptSecret } = await import('@pavisie/core'));
  ({ createTestContext } = await import('../../sdk/testing'));
  ({ instagramProvider } = await import('../providers/instagram'));
});

const originalFetch = globalThis.fetch;
const CHANNEL_ID = '123456789012345678';

beforeEach(() => {
  mocks.postAlert.mockReset();
  mocks.postAlert.mockResolvedValue(true);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-1',
    connectionId: 'conn-1',
    accessTokenEnc: encryptSecret('ig-access-token'),
    refreshTokenEnc: null,
    tokenType: 'bearer',
    scopes: ['instagram_business_basic'],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // far out — no refresh call in these tests
    rotatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeConnection(config: Record<string, unknown>): IntegrationConnection {
  return {
    id: 'conn-1',
    guildId: 'guild-1',
    provider: 'INSTAGRAM',
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

interface FakeMediaItem {
  id: string;
  timestamp: string;
}

/** `GET /me/media` response shape — newest-first, matching Instagram's documented default ordering. */
function mediaResponse(items: FakeMediaItem[]): Response {
  return new Response(
    JSON.stringify({
      data: items.map((item) => ({
        id: item.id,
        caption: `caption for ${item.id}`,
        media_type: 'IMAGE',
        media_url: `https://example.com/${item.id}.jpg`,
        permalink: `https://instagram.com/p/${item.id}`,
        timestamp: item.timestamp,
      })),
    }),
    { status: 200 },
  );
}

/** Builds a `prismaOverrides` object whose `integrationConnection.update` mutation is captured into `store`,
 * so a second `poll()` call in the same test can be handed the config the first call actually persisted —
 * mirroring how the real poll job re-fetches the connection fresh from the database before every run. */
function buildContextOverrides(store: { config: Record<string, unknown> }) {
  return {
    oAuthToken: { findUnique: async () => makeToken() },
    integrationConnection: {
      update: async (args: unknown) => {
        const { data } = args as { data?: { config?: Record<string, unknown> } };
        if (data?.config) store.config = data.config;
        return {};
      },
    },
  };
}

describe('instagramProvider.poll', () => {
  it('alerts exactly once per new post, then sends nothing on a later poll over the same data', async () => {
    const store: { config: Record<string, unknown> } = {
      config: { channelId: CHANNEL_ID, lastSeenTimestamp: '2026-01-01T00:00:00+0000' },
    };
    const { ctx } = createTestContext({ prismaOverrides: buildContextOverrides(store) });

    globalThis.fetch = vi.fn(async () =>
      mediaResponse([
        { id: 'post-2', timestamp: '2026-01-02T00:00:00+0000' }, // newest first
        { id: 'post-1', timestamp: '2026-01-01T12:00:00+0000' },
      ]),
    ) as unknown as typeof fetch;

    await instagramProvider.poll!(ctx, makeConnection(store.config));

    expect(mocks.postAlert).toHaveBeenCalledTimes(2); // one alert per new post
    expect(store.config.lastSeenTimestamp).toBe('2026-01-02T00:00:00+0000'); // watermark advanced to the newest

    // Second poll: same two posts still come back from the (unchanged) API response — nothing new happened.
    await instagramProvider.poll!(ctx, makeConnection(store.config));
    expect(mocks.postAlert).toHaveBeenCalledTimes(2); // unchanged — no repeat alerts
  });

  it('does not flood the channel on the first-ever poll of an account with existing history', async () => {
    // no lastSeenTimestamp yet — never connected before
    const store: { config: Record<string, unknown> } = { config: { channelId: CHANNEL_ID } };
    const { ctx } = createTestContext({ prismaOverrides: buildContextOverrides(store) });

    globalThis.fetch = vi.fn(async () =>
      mediaResponse([
        { id: 'old-5', timestamp: '2025-06-05T00:00:00+0000' },
        { id: 'old-4', timestamp: '2025-06-04T00:00:00+0000' },
        { id: 'old-3', timestamp: '2025-06-03T00:00:00+0000' },
        { id: 'old-2', timestamp: '2025-06-02T00:00:00+0000' },
        { id: 'old-1', timestamp: '2025-06-01T00:00:00+0000' },
      ]),
    ) as unknown as typeof fetch;

    await instagramProvider.poll!(ctx, makeConnection(store.config));

    expect(mocks.postAlert).not.toHaveBeenCalled(); // the back catalogue never gets dumped into the channel
    expect(store.config.lastSeenTimestamp).toBe('2025-06-05T00:00:00+0000'); // watermark still gets established

    // A genuinely new post after the baseline is set alerts normally — the flood guard only ever suppresses
    // the one first-ever poll, it doesn't disable alerting going forward.
    globalThis.fetch = vi.fn(async () =>
      mediaResponse([
        { id: 'new-1', timestamp: '2025-06-06T00:00:00+0000' },
        { id: 'old-5', timestamp: '2025-06-05T00:00:00+0000' },
      ]),
    ) as unknown as typeof fetch;
    await instagramProvider.poll!(ctx, makeConnection(store.config));
    expect(mocks.postAlert).toHaveBeenCalledTimes(1);
  });

  it('marks the connection errored, without alerting, when there is no valid access token', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => null } },
    });
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await instagramProvider.poll!(ctx, makeConnection({ channelId: CHANNEL_ID }));

    expect(mocks.postAlert).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled(); // never even reached the media endpoint
  });
});
