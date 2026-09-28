import { createHmac } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '@pavisie/core';
import { buildApp } from '../src/app';
import type { ZodFastifyInstance } from '../src/lib/http';
import { createFakeQueues } from './helpers/build-test-app';
import { buildTwitchExtFakePrisma, type TwitchExtFakePrismaOptions } from './helpers/twitch-ext-fakes';

// `GuildConfigStore`'s Redis cache (`cfg:<guildId>:economy` / `plugin:<guildId>:economy`, TTL 300s) is keyed
// by guildId, and `ioredis-mock` instances constructed with the same (default) options share one underlying
// in-memory store process-wide (see the identical caveat in `apps/api/src/app.ts`'s `overlaySubscriber` doc
// comment) — so a FIXED guildId reused across many `it()` blocks in this file would let one test's cached
// enable/config state leak into a later test that expects different state, even though each test builds its
// own fresh fake Prisma. A fresh guildId per test sidesteps that entirely.
let GUILD_ID = '700000000000000001';
let guildIdCounter = 0;
beforeEach(() => {
  guildIdCounter += 1;
  GUILD_ID = `70000000${String(guildIdCounter).padStart(10, '0')}`;
});

const CHANNEL_ID = '900000000001'; // Twitch numeric broadcaster user id
const OPAQUE_USER_ID = 'AU_opaque_viewer_1';
const VIEWER_USER_ID = '900000000002'; // Twitch numeric viewer user id

const SECRET_BASE64 = Buffer.from('twitch-ext-test-secret-bytes').toString('base64');
const EXT_CLIENT_ID = 'ext-client-id-test';
const EXT_ORIGIN = `https://${EXT_CLIENT_ID}.ext-twitch.tv`;

const ORIGINAL_EXT_CLIENT_ID = env.TWITCH_EXTENSION_CLIENT_ID;
const ORIGINAL_EXT_SECRET = env.TWITCH_EXTENSION_SECRET;

function configureExtensionEnv(): void {
  env.TWITCH_EXTENSION_CLIENT_ID = EXT_CLIENT_ID;
  env.TWITCH_EXTENSION_SECRET = SECRET_BASE64;
}

afterEach(() => {
  env.TWITCH_EXTENSION_CLIENT_ID = ORIGINAL_EXT_CLIENT_ID;
  env.TWITCH_EXTENSION_SECRET = ORIGINAL_EXT_SECRET;
});

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

interface TokenClaims {
  channelId?: string;
  opaqueUserId?: string;
  userId?: string;
  role?: string;
  expSecFromNow?: number;
}

/** Builds a real, validly-signed Twitch extension JWT against `SECRET_BASE64`. */
function signToken(claims: TokenClaims = {}): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    exp: nowSec + (claims.expSecFromNow ?? 300),
    channel_id: claims.channelId ?? CHANNEL_ID,
    opaque_user_id: claims.opaqueUserId ?? OPAQUE_USER_ID,
    role: claims.role ?? 'viewer',
  };
  if (claims.userId) payload.user_id = claims.userId;

  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', Buffer.from(SECRET_BASE64, 'base64')).update(`${headerB64}.${payloadB64}`).digest();
  return `${headerB64}.${payloadB64}.${b64url(sig)}`;
}

interface TestAppHandles {
  app: ZodFastifyInstance;
  fakePrisma: ReturnType<typeof buildTwitchExtFakePrisma>;
  logs: string[];
}

/** Builds a real `buildApp()` instance backed by the `/twitch-ext`-specific stateful Prisma fake (needs a real
 * `$transaction`, unlike the generic stub `buildTestApp` uses elsewhere — see helpers/twitch-ext-fakes.ts). */
async function buildTwitchExtTestApp(prismaOptions: TwitchExtFakePrismaOptions = {}): Promise<TestAppHandles> {
  const fakePrisma = buildTwitchExtFakePrisma(prismaOptions);
  const redis = new RedisMock() as unknown as Redis;
  const overlaySubscriber = new RedisMock() as unknown as Redis;
  const queues = createFakeQueues();

  const logs: string[] = [];
  const logger = pino({ level: 'trace' }, { write: (msg: string) => logs.push(msg) });

  const app = await buildApp({ prisma: fakePrisma.prisma, redis, queues, overlaySubscriber, logger });
  await app.ready();
  return { app, fakePrisma, logs };
}

/** A guild whose economy plugin is enabled + `twitchEnabled`, linked to `CHANNEL_ID`. Deterministic daily
 * amount (min=max=100, no streak bonus) so `/daily` tests don't need to special-case a random range. */
function enabledGuildPrismaOptions(overrides: Partial<TwitchExtFakePrismaOptions> = {}): TwitchExtFakePrismaOptions {
  return {
    channels: [{ id: 'chan-1', guildId: GUILD_ID, broadcasterUserId: CHANNEL_ID, enabled: true }],
    pluginStates: { [`${GUILD_ID}:economy`]: true },
    pluginConfigs: {
      [`${GUILD_ID}:economy`]: {
        currencyName: 'Agis',
        currencySymbol: '♦️',
        twitchEnabled: true,
        dailyMinAmount: 100,
        dailyMaxAmount: 100,
        streakBonusPerDay: 0,
        streakBonusMax: 0,
      },
    },
    ...overrides,
  };
}

describe('GET /twitch-ext/summary', () => {
  beforeEach(() => configureExtensionEnv());

  it('503s "Extension not configured" when the extension env vars are unset', async () => {
    env.TWITCH_EXTENSION_CLIENT_ID = undefined;
    env.TWITCH_EXTENSION_SECRET = undefined;
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());

    const res = await app.inject({
      method: 'GET',
      url: '/twitch-ext/summary',
      headers: { authorization: `Bearer ${signToken()}` },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('extension_not_configured');
    await app.close();
  });

  it('401s with no Authorization header', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const res = await app.inject({ method: 'GET', url: '/twitch-ext/summary' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('401s with a garbage bearer token', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const res = await app.inject({
      method: 'GET',
      url: '/twitch-ext/summary',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    });
    expect(res.statusCode).toBe(401);
    // No detail leakage: a generic message only, never the verifier's internal reject reason.
    expect(res.json().error.message).not.toMatch(/malformed|signature|expired|alg/i);
    await app.close();
  });

  it('401s a token signed with the wrong secret', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const wrongSecret = Buffer.from('a-different-secret').toString('base64');
    const headerB64 = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payloadB64 = b64url(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, channel_id: CHANNEL_ID, opaque_user_id: OPAQUE_USER_ID, role: 'viewer' }),
    );
    const sig = createHmac('sha256', Buffer.from(wrongSecret, 'base64')).update(`${headerB64}.${payloadB64}`).digest();
    const badToken = `${headerB64}.${payloadB64}.${b64url(sig)}`;

    const res = await app.inject({ method: 'GET', url: '/twitch-ext/summary', headers: { authorization: `Bearer ${badToken}` } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns { enabled: false } for a channel with no linked guild', async () => {
    const { app } = await buildTwitchExtTestApp({ channels: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/twitch-ext/summary',
      headers: { authorization: `Bearer ${signToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
    await app.close();
  });

  it('returns { enabled: false } when the economy plugin is disabled for the linked guild', async () => {
    const options = enabledGuildPrismaOptions({ pluginStates: { [`${GUILD_ID}:economy`]: false } });
    const { app } = await buildTwitchExtTestApp(options);
    const res = await app.inject({ method: 'GET', url: '/twitch-ext/summary', headers: { authorization: `Bearer ${signToken()}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
    await app.close();
  });

  it('returns { enabled: false } when the economy plugin is enabled but twitchEnabled is false', async () => {
    const options = enabledGuildPrismaOptions();
    options.pluginConfigs![`${GUILD_ID}:economy`] = { ...options.pluginConfigs![`${GUILD_ID}:economy`], twitchEnabled: false };
    const { app } = await buildTwitchExtTestApp(options);
    const res = await app.inject({ method: 'GET', url: '/twitch-ext/summary', headers: { authorization: `Bearer ${signToken()}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
    await app.close();
  });

  it('without shared identity: no wallet in the response, no wallet ever created, leaderboard still present', async () => {
    const { app, fakePrisma } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());

    const res = await app.inject({ method: 'GET', url: '/twitch-ext/summary', headers: { authorization: `Bearer ${signToken()}` } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.identityShared).toBe(false);
    expect(body.wallet).toBeUndefined();
    expect(body.currencyName).toBe('Agis');
    expect(Array.isArray(body.leaderboard)).toBe(true);

    // The whole point: viewing the panel must never create an EconomyAccount row.
    expect(fakePrisma.getAccount(`acct-${GUILD_ID}-TWITCH-${OPAQUE_USER_ID}`)).toBeUndefined();
    expect([...(fakePrisma as unknown as { getTransactions: () => unknown[] }).getTransactions()]).toHaveLength(0);
    await app.close();
  });

  it('with shared identity: returns the real wallet balance/streak, and the leaderboard', async () => {
    const options = enabledGuildPrismaOptions({
      seedAccounts: [
        {
          id: 'acct-existing',
          guildId: GUILD_ID,
          platform: 'TWITCH',
          userId: VIEWER_USER_ID,
          displayName: 'CoolViewer',
          balance: 4200n,
          lastDailyAt: null,
        },
      ],
    });
    const { app } = await buildTwitchExtTestApp(options);

    const token = signToken({ userId: VIEWER_USER_ID });
    const res = await app.inject({ method: 'GET', url: '/twitch-ext/summary', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identityShared).toBe(true);
    expect(body.wallet).toEqual({ balance: '4200', dailyAvailableAt: null, streak: 0 });
    await app.close();
  });

  it('leaderboard reflects lifetime TWITCH earnings, top entries first', async () => {
    const options = enabledGuildPrismaOptions({
      seedAccounts: [
        { id: 'a1', guildId: GUILD_ID, platform: 'TWITCH', userId: 'v1', displayName: 'Top', balance: 500n, lastDailyAt: null },
        { id: 'a2', guildId: GUILD_ID, platform: 'TWITCH', userId: 'v2', displayName: 'Second', balance: 100n, lastDailyAt: null },
      ],
      seedTransactions: [
        { id: 't1', guildId: GUILD_ID, platform: 'TWITCH', accountId: 'a1', toUserId: 'v1', amount: 500n, type: 'daily', createdAt: new Date() },
        { id: 't2', guildId: GUILD_ID, platform: 'TWITCH', accountId: 'a2', toUserId: 'v2', amount: 100n, type: 'twitch_chat_earn', createdAt: new Date() },
      ],
    });
    const { app } = await buildTwitchExtTestApp(options);
    const res = await app.inject({ method: 'GET', url: '/twitch-ext/summary', headers: { authorization: `Bearer ${signToken()}` } });

    expect(res.json().leaderboard).toEqual([
      { displayName: 'Top', earned: '500' },
      { displayName: 'Second', earned: '100' },
    ]);
    await app.close();
  });
});

describe('POST /twitch-ext/daily', () => {
  beforeEach(() => configureExtensionEnv());

  it('503s when the extension env vars are unset', async () => {
    env.TWITCH_EXTENSION_CLIENT_ID = undefined;
    env.TWITCH_EXTENSION_SECRET = undefined;
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const res = await app.inject({ method: 'POST', url: '/twitch-ext/daily', headers: { authorization: `Bearer ${signToken()}` } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('403s with identity_not_shared when the JWT carries no user_id', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const res = await app.inject({ method: 'POST', url: '/twitch-ext/daily', headers: { authorization: `Bearer ${signToken()}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('identity_not_shared');
    await app.close();
  });

  it('returns { ok: false } for a channel with no linked/enabled guild, even with identity shared', async () => {
    const { app } = await buildTwitchExtTestApp({ channels: [] });
    const token = signToken({ userId: VIEWER_USER_ID });
    const res = await app.inject({ method: 'POST', url: '/twitch-ext/daily', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false });
    await app.close();
  });

  it('claims successfully (deterministic amount via fixed min=max config) and reflects the new balance on a follow-up summary', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const token = signToken({ userId: VIEWER_USER_ID });

    const claimRes = await app.inject({ method: 'POST', url: '/twitch-ext/daily', headers: { authorization: `Bearer ${token}` } });
    expect(claimRes.statusCode).toBe(200);
    expect(claimRes.json()).toEqual({ ok: true, amount: '100', streak: 1 });

    const summaryRes = await app.inject({ method: 'GET', url: '/twitch-ext/summary', headers: { authorization: `Bearer ${token}` } });
    expect(summaryRes.json().wallet.balance).toBe('100');
    await app.close();
  });

  it('a second claim within the cooldown window is rejected with a retryAfterMs > 0', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const token = signToken({ userId: VIEWER_USER_ID });

    const first = await app.inject({ method: 'POST', url: '/twitch-ext/daily', headers: { authorization: `Bearer ${token}` } });
    expect(first.json().ok).toBe(true);

    const second = await app.inject({ method: 'POST', url: '/twitch-ext/daily', headers: { authorization: `Bearer ${token}` } });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.ok).toBe(false);
    expect(body.retryAfterMs).toBeGreaterThan(0);
    await app.close();
  });

  it('is not blocked by CSRF protection despite being a mutating (POST) route with no session/CSRF header', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const token = signToken({ userId: VIEWER_USER_ID });

    const res = await app.inject({ method: 'POST', url: '/twitch-ext/daily', headers: { authorization: `Bearer ${token}` } });

    // Never the CSRF-layer's rejection shape (permission_denied / "Missing or invalid CSRF token").
    expect(res.statusCode).not.toBe(403 as number);
    if (res.statusCode >= 400) {
      expect(res.json().error.code).not.toBe('permission_denied');
    }
    await app.close();
  });
});

describe('/twitch-ext CORS', () => {
  beforeEach(() => configureExtensionEnv());

  it('reflects the extension origin on /twitch-ext/summary, with no Allow-Credentials header', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const res = await app.inject({
      method: 'GET',
      url: '/twitch-ext/summary',
      headers: { authorization: `Bearer ${signToken()}`, origin: EXT_ORIGIN },
    });
    expect(res.headers['access-control-allow-origin']).toBe(EXT_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    await app.close();
  });

  it('answers an OPTIONS preflight for /twitch-ext/daily with the extension origin reflected', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/twitch-ext/daily',
      headers: {
        origin: EXT_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(EXT_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    await app.close();
  });

  it('does NOT reflect an unrelated origin on /twitch-ext routes', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const res = await app.inject({
      method: 'GET',
      url: '/twitch-ext/summary',
      headers: { authorization: `Bearer ${signToken()}`, origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('does NOT set the extension-origin CORS header on a non-/twitch-ext route', async () => {
    const { app } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: EXT_ORIGIN } });
    expect(res.headers['access-control-allow-origin']).not.toBe(EXT_ORIGIN);
    await app.close();
  });
});

describe('/twitch-ext logging never includes the token or secret', () => {
  beforeEach(() => configureExtensionEnv());

  it('an invalid bearer token never appears in any log line, and neither does the configured secret', async () => {
    const { app, logs } = await buildTwitchExtTestApp(enabledGuildPrismaOptions());
    const distinctiveMarker = 'MARKER_SHOULD_NEVER_BE_LOGGED_abc123xyz';
    const fakeToken = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(JSON.stringify({ marker: distinctiveMarker }))}.${b64url(distinctiveMarker)}`;

    await app.inject({ method: 'GET', url: '/twitch-ext/summary', headers: { authorization: `Bearer ${fakeToken}` } });
    await app.close();

    const joined = logs.join('\n');
    expect(joined).not.toContain(distinctiveMarker);
    expect(joined).not.toContain(fakeToken);
    expect(joined).not.toContain(SECRET_BASE64);
  });
});
