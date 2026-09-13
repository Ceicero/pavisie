import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// See `twitch-chat-helix.test.ts`/`delivery.test.ts` for why this file has no static imports of its own:
// `@pavisie/core`'s `env` is computed once, at that module's first import, from `process.env` —
// `ENCRYPTION_KEY` must be set first. This file drives the real `broadcaster-token.ts` refresh path (rather
// than mocking it) so the 401-triggers-one-forced-refresh test below exercises the actual reauth wiring,
// mirroring how `twitch-chat-helix.test.ts` tests the bot-identity equivalent.
let encryptSecret: typeof import('@pavisie/core').encryptSecret;
let createTestContext: typeof import('../../sdk/testing').createTestContext;
let createRewardRedemptionSubscription: typeof import('../twitch-chat/helix').createRewardRedemptionSubscription;
let listCustomRewards: typeof import('../twitch-chat/helix').listCustomRewards;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
  process.env.TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? 'test-client-id';
  process.env.TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? 'test-client-secret';
  ({ encryptSecret } = await import('@pavisie/core'));
  ({ createTestContext } = await import('../../sdk/testing'));
  ({ createRewardRedemptionSubscription, listCustomRewards } = await import('../twitch-chat/helix'));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture stands in for the full Prisma model.
function makeChannel(overrides: Record<string, unknown> = {}): any {
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
  };
}

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-1',
    connectionId: 'connection-1',
    accessTokenEnc: encryptSecret('broadcaster-access-token'),
    refreshTokenEnc: encryptSecret('broadcaster-refresh-token'),
    tokenType: 'bearer',
    scopes: ['channel:read:redemptions'],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h out, not expiring soon
    rotatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('createRewardRedemptionSubscription', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs the correct subscription shape, with NO reward_id, authenticated with the broadcaster token', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ data: [{ id: 'sub-123' }] }), { status: 202 });
    }) as unknown as typeof fetch;

    const token = makeToken();
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => token } },
    });

    const result = await createRewardRedemptionSubscription(ctx, 'session-abc', makeChannel());

    expect(result).toEqual({ ok: true, subscriptionId: 'sub-123' });
    expect(capturedUrl).toContain('/eventsub/subscriptions');

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer broadcaster-access-token');
    expect(headers['Client-Id']).toBe('test-client-id');

    const body = JSON.parse(String(capturedInit?.body)) as {
      type: string;
      version: string;
      condition: Record<string, unknown>;
      transport: Record<string, unknown>;
    };
    expect(body.type).toBe('channel.channel_points_custom_reward_redemption.add');
    expect(body.version).toBe('1');
    expect(body.condition).toEqual({ broadcaster_user_id: 'broadcaster-1' });
    expect(body.condition).not.toHaveProperty('reward_id'); // binding fact 3: filtered locally, never per-reward
    expect(body.transport).toEqual({ method: 'websocket', session_id: 'session-abc' });
  });

  it('returns ok:false with the broadcaster-unavailable message when there is no usable broadcaster token', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => null } },
    });

    const result = await createRewardRedemptionSubscription(ctx, 'session-abc', makeChannel());

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a non-ok Helix response to status + the Twitch-provided error message', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'missing scope' }), { status: 403 })) as unknown as typeof fetch;

    const token = makeToken();
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => token } },
    });

    const result = await createRewardRedemptionSubscription(ctx, 'session-abc', makeChannel());

    expect(result).toEqual({ ok: false, status: 403, error: 'missing scope' });
  });

  it('forces exactly one broadcaster-token refresh and retries once on a 401, then succeeds', async () => {
    const token = makeToken();
    const tokenUpdates: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('id.twitch.tv')) {
        return new Response(
          JSON.stringify({ access_token: 'refreshed-token', refresh_token: 'refreshed-refresh', expires_in: 14400 }),
          { status: 200 },
        );
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth === 'Bearer broadcaster-access-token') {
        return new Response(null, { status: 401 }); // the cached (pre-401) token — reject it
      }
      return new Response(JSON.stringify({ data: [{ id: 'sub-456' }] }), { status: 202 });
    }) as unknown as typeof fetch;

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
        integrationConnection: { update: async () => ({}) },
      },
    });

    const result = await createRewardRedemptionSubscription(ctx, 'session-abc', makeChannel());

    expect(result).toEqual({ ok: true, subscriptionId: 'sub-456' });
    expect(tokenUpdates).toHaveLength(1); // exactly one forced refresh happened
  });
});

describe('listCustomRewards', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('GETs custom rewards for the broadcaster and returns id+title pairs', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({ data: [{ id: 'reward-1', title: 'Hydrate!' }, { id: 'reward-2', title: 'Do a flip' }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const token = makeToken();
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => token } },
    });

    const result = await listCustomRewards(ctx, makeChannel());

    expect(result).toEqual({
      ok: true,
      value: [
        { id: 'reward-1', title: 'Hydrate!' },
        { id: 'reward-2', title: 'Do a flip' },
      ],
    });
    expect(capturedUrl).toContain('/channel_points/custom_rewards');
    expect(capturedUrl).toContain('broadcaster_id=broadcaster-1');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer broadcaster-access-token');
  });

  it('returns ok:false when there is no usable broadcaster token', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => null } },
    });

    const result = await listCustomRewards(ctx, makeChannel());

    expect(result).toEqual({ ok: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok:false when the Helix request fails', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    const token = makeToken();
    const { ctx } = createTestContext({
      prismaOverrides: { oAuthToken: { findUnique: async () => token } },
    });

    const result = await listCustomRewards(ctx, makeChannel());

    expect(result).toEqual({ ok: false });
  });
});
