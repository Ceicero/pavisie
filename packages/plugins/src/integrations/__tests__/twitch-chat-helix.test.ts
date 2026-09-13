import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// See `delivery.test.ts` for why this file has no static imports of its own: `@pavisie/core`'s `env` is
// computed once, at that module's first import, from `process.env` — `ENCRYPTION_KEY` must be set first.
let encryptSecret: typeof import('@pavisie/core').encryptSecret;
let decryptSecret: typeof import('@pavisie/core').decryptSecret;
let redisKey: typeof import('@pavisie/core').redisKey;
let createTestContext: typeof import('../../sdk/testing').createTestContext;
let getBotAccessToken: typeof import('../twitch-chat/helix').getBotAccessToken;
let sendChatMessage: typeof import('../twitch-chat/helix').sendChatMessage;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
  process.env.TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? 'test-client-id';
  process.env.TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? 'test-client-secret';
  ({ encryptSecret, decryptSecret, redisKey } = await import('@pavisie/core'));
  ({ createTestContext } = await import('../../sdk/testing'));
  ({ getBotAccessToken, sendChatMessage } = await import('../twitch-chat/helix'));
});

function makeIdentity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'identity-1',
    botUserId: 'bot-1',
    botLogin: 'pavisiebot',
    accessTokenEnc: encryptSecret('old-access-token'),
    refreshTokenEnc: encryptSecret('old-refresh-token'),
    scopes: ['user:read:chat', 'user:write:chat', 'user:bot'],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h out, not expiring soon
    status: 'CONNECTED' as const,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('getBotAccessToken', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns null when no TwitchBotIdentity row exists', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: { twitchBotIdentity: { findFirst: async () => null } },
    });
    expect(await getBotAccessToken(ctx)).toBeNull();
  });

  it('returns null when the identity is already in an ERROR state', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = createTestContext({
      prismaOverrides: { twitchBotIdentity: { findFirst: async () => makeIdentity({ status: 'ERROR' }) } },
    });
    expect(await getBotAccessToken(ctx)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the decrypted token without refreshing when not expiring soon', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = createTestContext({
      prismaOverrides: { twitchBotIdentity: { findFirst: async () => makeIdentity() } },
    });

    const token = await getBotAccessToken(ctx);
    expect(token).toEqual({ accessToken: 'old-access-token', botUserId: 'bot-1', botLogin: 'pavisiebot' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes when expiring within the window, persisting Twitch-rotated tokens', async () => {
    const updates: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 14400 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const identity = makeIdentity({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) }); // 5m out — within the 10m window
    const { ctx } = createTestContext({
      prismaOverrides: {
        twitchBotIdentity: {
          findFirst: async () => identity,
          update: async (args: unknown) => {
            const data = (args as { data: Record<string, unknown> }).data;
            updates.push(data);
            return { ...identity, ...data };
          },
        },
      },
    });

    const token = await getBotAccessToken(ctx);

    expect(token?.accessToken).toBe('new-access-token');
    expect(updates).toHaveLength(1);
    expect(decryptSecret(updates[0].accessTokenEnc as string)).toBe('new-access-token');
    // Twitch rotates the refresh token on every use — the NEW one must be stored, never the old one.
    expect(decryptSecret(updates[0].refreshTokenEnc as string)).toBe('new-refresh-token');
    expect(updates[0].status).toBe('CONNECTED');
  });

  it('marks the identity ERROR (with lastError) when the refresh request fails with a terminal status (400/401/403)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;

    const updates: Record<string, unknown>[] = [];
    const identity = makeIdentity({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
    const { ctx } = createTestContext({
      prismaOverrides: {
        twitchBotIdentity: {
          findFirst: async () => identity,
          update: async (args: unknown) => {
            updates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
      },
    });

    const token = await getBotAccessToken(ctx);

    expect(token).toBeNull();
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe('ERROR');
    expect(updates[0].lastError).toBeTruthy();
  });

  it('marks the identity ERROR when the stored refresh token cannot be decrypted (a corrupt secret can never succeed on retry)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const updates: Record<string, unknown>[] = [];
    const identity = makeIdentity({
      refreshTokenEnc: 'not-a-valid-encrypted-value',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    const { ctx } = createTestContext({
      prismaOverrides: {
        twitchBotIdentity: {
          findFirst: async () => identity,
          update: async (args: unknown) => {
            updates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
      },
    });

    const token = await getBotAccessToken(ctx);

    expect(token).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); // never even reached the token endpoint
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe('ERROR');
  });

  it('leaves the identity row untouched (no ERROR) and returns null when the refresh fails with a transient status (5xx) — the next tick retries', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

    const updates: Record<string, unknown>[] = [];
    const identity = makeIdentity({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
    const { ctx } = createTestContext({
      prismaOverrides: {
        twitchBotIdentity: {
          findFirst: async () => identity,
          update: async (args: unknown) => {
            updates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
      },
    });

    const token = await getBotAccessToken(ctx);

    expect(token).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('leaves the identity row untouched and returns null when the refresh request throws (network error) — the next tick retries', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const updates: Record<string, unknown>[] = [];
    const identity = makeIdentity({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
    const { ctx } = createTestContext({
      prismaOverrides: {
        twitchBotIdentity: {
          findFirst: async () => identity,
          update: async (args: unknown) => {
            updates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
      },
    });

    const token = await getBotAccessToken(ctx);

    expect(token).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('serializes refresh under a Redis lock: a concurrent caller uses the still-valid token instead of racing it', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const identity = makeIdentity({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
    const { ctx, redis } = createTestContext({
      prismaOverrides: { twitchBotIdentity: { findFirst: async () => identity } },
    });

    // Simulate another process already holding the refresh lock.
    const lockKey = redisKey('integrations', 'twitchchat', 'refreshlock');
    await redis.set(lockKey, 'someone-else', 'PX', 15_000, 'NX');

    const token = await getBotAccessToken(ctx);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(token?.accessToken).toBe('old-access-token');
  });
});

describe('sendChatMessage', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends via Helix with the bot identity as sender', async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const { ctx } = createTestContext({
      prismaOverrides: { twitchBotIdentity: { findFirst: async () => makeIdentity() } },
    });

    const uniqueBroadcaster = `broadcaster-${Date.now()}-a`;
    const result = await sendChatMessage(ctx, uniqueBroadcaster, 'hello chat');

    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain('/chat/messages');
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body).toEqual({ broadcaster_id: uniqueBroadcaster, sender_id: 'bot-1', message: 'hello chat' });
  });

  it('throttles a second send to the same broadcaster within one second', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { ctx } = createTestContext({
      prismaOverrides: { twitchBotIdentity: { findFirst: async () => makeIdentity() } },
    });

    const broadcasterId = `broadcaster-${Date.now()}-b`;
    const first = await sendChatMessage(ctx, broadcasterId, 'one');
    const second = await sendChatMessage(ctx, broadcasterId, 'two');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toBe('throttled');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throttle sends to different broadcasters', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { ctx } = createTestContext({
      prismaOverrides: { twitchBotIdentity: { findFirst: async () => makeIdentity() } },
    });

    const suffix = Date.now();
    const first = await sendChatMessage(ctx, `broadcaster-${suffix}-c1`, 'one');
    const second = await sendChatMessage(ctx, `broadcaster-${suffix}-c2`, 'two');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns ok:false without sending when no bot identity is configured', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { ctx } = createTestContext({
      prismaOverrides: { twitchBotIdentity: { findFirst: async () => null } },
    });

    const result = await sendChatMessage(ctx, `broadcaster-${Date.now()}-d`, 'hello');
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a 401 from Helix forces one refresh and retries the call once', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.useRealTimers();
    // `ioredis-mock`'s in-memory store is shared across instances within the process, and `getBotAccessToken`'s
    // own "serializes refresh under a Redis lock" test above deliberately leaves that fixed lock key held for
    // 15s — clear it so that leftover lock can't make *this* describe's own forced refresh look like a losing
    // race and silently skip refreshing.
    await createTestContext().redis.del(redisKey('integrations', 'twitchchat', 'refreshlock')).catch(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('retries the request once with a freshly refreshed token, and succeeds', async () => {
    // Not expiring soon — the ONLY thing that should trigger a refresh here is the 401 from Helix itself.
    const identity = makeIdentity({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    const updates: Record<string, unknown>[] = [];

    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('id.twitch.tv')) {
        return new Response(
          JSON.stringify({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 14400 }),
          { status: 200 },
        );
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth === 'Bearer old-access-token') {
        return new Response(null, { status: 401 }); // the cached (pre-401) token — reject it
      }
      return new Response(null, { status: 200 }); // the freshly refreshed token — accept it
    }) as unknown as typeof fetch;

    const { ctx } = createTestContext({
      prismaOverrides: {
        twitchBotIdentity: {
          findFirst: async () => identity,
          update: async (args: unknown) => {
            const data = (args as { data: Record<string, unknown> }).data;
            updates.push(data);
            Object.assign(identity, data);
            return identity;
          },
        },
      },
    });

    const result = await sendChatMessage(ctx, `broadcaster-${Date.now()}-reauth-ok`, 'hi');

    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1); // exactly one forced refresh happened
  });

  it('gives up (as today) if the forced refresh itself fails', async () => {
    const identity = makeIdentity({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) });

    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('id.twitch.tv')) return new Response(null, { status: 503 }); // refresh itself fails, transiently
      return new Response(null, { status: 401 }); // Helix keeps 401ing no matter what
    }) as unknown as typeof fetch;

    const { ctx } = createTestContext({
      prismaOverrides: {
        twitchBotIdentity: { findFirst: async () => identity, update: async () => identity },
      },
    });

    const result = await sendChatMessage(ctx, `broadcaster-${Date.now()}-reauth-fail`, 'hi');

    expect(result.ok).toBe(false);
  });
});
