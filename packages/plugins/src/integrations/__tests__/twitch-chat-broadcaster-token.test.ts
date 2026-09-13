import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// See `twitch-chat-helix.test.ts`/`delivery.test.ts` for why this file has no static imports of its own:
// `@pavisie/core`'s `env` is computed once, at that module's first import, from `process.env` —
// `ENCRYPTION_KEY` must be set first.
let encryptSecret: typeof import('@pavisie/core').encryptSecret;
let decryptSecret: typeof import('@pavisie/core').decryptSecret;
let redisKey: typeof import('@pavisie/core').redisKey;
let createTestContext: typeof import('../../sdk/testing').createTestContext;
let getBroadcasterAccessToken: typeof import('../twitch-chat/broadcaster-token').getBroadcasterAccessToken;
let forceRefreshBroadcasterAccessToken: typeof import('../twitch-chat/broadcaster-token').forceRefreshBroadcasterAccessToken;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
  process.env.TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? 'test-client-id';
  process.env.TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? 'test-client-secret';
  ({ encryptSecret, decryptSecret, redisKey } = await import('@pavisie/core'));
  ({ createTestContext } = await import('../../sdk/testing'));
  ({ getBroadcasterAccessToken, forceRefreshBroadcasterAccessToken } = await import('../twitch-chat/broadcaster-token'));
});

// Minimal `TwitchChatChannel` fixture — broadcaster-token.ts only reads `connectionId` and `broadcasterUserId`
// off it, but it's typed against the full Prisma model.
function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'channel-1',
    guildId: 'guild-1',
    broadcasterUserId: 'broadcaster-1',
    broadcasterLogin: 'broadcasterlogin',
    enabled: true,
    status: 'CONNECTED',
    lastError: null,
    lastConnectedAt: null,
    commandPrefix: '!',
    connectionId: 'connection-1',
    overlayTokenEnc: null,
    rewardsEnabled: false,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture stands in for the full Prisma model.
  } as any;
}

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-1',
    connectionId: 'connection-1',
    accessTokenEnc: encryptSecret('old-access-token'),
    refreshTokenEnc: encryptSecret('old-refresh-token'),
    tokenType: 'bearer',
    scopes: ['channel:read:redemptions'],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h out, not expiring soon
    rotatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('getBroadcasterAccessToken', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns null when the channel has no connectionId (never linked, or unlinked)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = createTestContext();

    expect(await getBroadcasterAccessToken(ctx, makeChannel({ connectionId: null }))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when no OAuthToken row exists for the connection', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => null } },
    });
    expect(await getBroadcasterAccessToken(ctx, makeChannel())).toBeNull();
  });

  it('returns null when the stored token lacks the channel:read:redemptions scope', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const token = makeToken({ scopes: ['channel:bot'] }); // has the chat scope, not the redemptions one
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => token } },
    });

    expect(await getBroadcasterAccessToken(ctx, makeChannel())).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); // never even reached for a scope-missing token
  });

  it('returns the decrypted token without refreshing when not expiring soon', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const token = makeToken();
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => token } },
    });

    const result = await getBroadcasterAccessToken(ctx, makeChannel());

    expect(result).toEqual({ accessToken: 'old-access-token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes when expiring within the window, persisting the Twitch-rotated refresh token', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 14400 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const token = makeToken({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) }); // 5m out — within the 10m window
    const tokenUpdates: Record<string, unknown>[] = [];
    const connectionUpdates: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        oAuthToken: {
          findUnique: async () => token,
          update: async (args: unknown) => {
            const data = (args as { data: Record<string, unknown> }).data;
            tokenUpdates.push(data);
            return { ...token, ...data };
          },
        },
        integrationConnection: {
          update: async (args: unknown) => {
            connectionUpdates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
      },
    });

    const result = await getBroadcasterAccessToken(ctx, makeChannel({ connectionId: token.connectionId }));

    expect(result?.accessToken).toBe('new-access-token');
    expect(tokenUpdates).toHaveLength(1);
    expect(decryptSecret(tokenUpdates[0].accessTokenEnc as string)).toBe('new-access-token');
    // Twitch rotates the refresh token on every use — the NEW one must be stored, never the old one.
    expect(decryptSecret(tokenUpdates[0].refreshTokenEnc as string)).toBe('new-refresh-token');
    // A successful refresh also clears any prior ERROR on the connection.
    expect(connectionUpdates).toEqual([{ status: 'CONNECTED', lastError: null }]);
  });

  it('marks the IntegrationConnection ERROR (with lastError) on a terminal refresh failure (401)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;

    const token = makeToken({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
    const connectionUpdates: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        oAuthToken: { findUnique: async () => token },
        integrationConnection: {
          update: async (args: unknown) => {
            connectionUpdates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
      },
    });

    const result = await getBroadcasterAccessToken(ctx, makeChannel({ connectionId: token.connectionId }));

    expect(result).toBeNull();
    expect(connectionUpdates).toHaveLength(1);
    expect(connectionUpdates[0].status).toBe('ERROR');
    expect(connectionUpdates[0].lastError).toBeTruthy();
  });

  it('leaves the connection untouched (no ERROR) on a transient refresh failure (503) — the next tick retries', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

    const token = makeToken({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
    const connectionUpdates: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        oAuthToken: { findUnique: async () => token },
        integrationConnection: {
          update: async (args: unknown) => {
            connectionUpdates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
      },
    });

    const result = await getBroadcasterAccessToken(ctx, makeChannel({ connectionId: token.connectionId }));

    expect(result).toBeNull();
    expect(connectionUpdates).toHaveLength(0);
  });

  it('leaves the connection untouched and returns null when the refresh request throws (network error)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const token = makeToken({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
    const connectionUpdates: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        oAuthToken: { findUnique: async () => token },
        integrationConnection: {
          update: async (args: unknown) => {
            connectionUpdates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
      },
    });

    const result = await getBroadcasterAccessToken(ctx, makeChannel({ connectionId: token.connectionId }));

    expect(result).toBeNull();
    expect(connectionUpdates).toHaveLength(0);
  });

  it('marks the connection ERROR when there is no stored refresh token to use (can never succeed on retry)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const token = makeToken({ refreshTokenEnc: null, expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
    const connectionUpdates: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        oAuthToken: { findUnique: async () => token },
        integrationConnection: {
          update: async (args: unknown) => {
            connectionUpdates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
      },
    });

    const result = await getBroadcasterAccessToken(ctx, makeChannel({ connectionId: token.connectionId }));

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectionUpdates[0]?.status).toBe('ERROR');
  });

  it('serializes refresh under a per-connection Redis lock: a concurrent caller uses the still-valid token instead of racing it', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const token = makeToken({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
    const { ctx, redis } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => token } },
    });

    // Simulate another process already holding this connection's refresh lock.
    const lockKey = redisKey('integrations', 'twitchchat', 'broadcasterrefreshlock', token.connectionId);
    await redis.set(lockKey, 'someone-else', 'PX', 15_000, 'NX');

    const result = await getBroadcasterAccessToken(ctx, makeChannel({ connectionId: token.connectionId }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result?.accessToken).toBe('old-access-token');
  });
});

describe('forceRefreshBroadcasterAccessToken', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    // `ioredis-mock`'s in-memory store is shared across instances within the process (see
    // `twitch-chat-helix.test.ts`'s equivalent note), and the "serializes refresh under a per-connection Redis
    // lock" test above deliberately leaves that fixed lock key held for 15s — clear it so that leftover lock
    // can't make this describe's own forced refresh look like a losing race and silently skip refreshing.
    const { ctx } = createTestContext();
    await ctx.redis.del(redisKey('integrations', 'twitchchat', 'broadcasterrefreshlock', 'connection-1')).catch(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('refreshes even when the token is not expiring soon (used after a Helix call itself returns 401)', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ access_token: 'forced-new-token', refresh_token: 'forced-new-refresh', expires_in: 14400 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const token = makeToken({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) }); // far from expiry
    const { ctx } = createTestContext({
      prismaOverrides: {
        oAuthToken: {
          findUnique: async () => token,
          update: async (args: unknown) => ({ ...token, ...(args as { data: Record<string, unknown> }).data }),
        },
        integrationConnection: { update: async () => ({}) },
      },
    });

    const result = await forceRefreshBroadcasterAccessToken(ctx, makeChannel({ connectionId: token.connectionId }));

    expect(result?.accessToken).toBe('forced-new-token');
  });

  it('returns null when the channel has no connectionId', async () => {
    const { ctx } = createTestContext();
    expect(await forceRefreshBroadcasterAccessToken(ctx, makeChannel({ connectionId: null }))).toBeNull();
  });

  it('returns null when the token lacks the redemptions scope', async () => {
    const token = makeToken({ scopes: [] });
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => token } },
    });
    expect(await forceRefreshBroadcasterAccessToken(ctx, makeChannel())).toBeNull();
  });
});
