import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import RedisMock from 'ioredis-mock';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { TwitchChatManager } from '../twitch-chat/manager';
import type { WebSocketConstructorLike, WebSocketLike } from '../twitch-chat/socket';
import { getBridgeDropCount, pruneBridgeDropCount } from '../twitch-chat/bridge-metrics';
import { pruneBridgeSendBucket } from '../twitch-chat/bridge-ratelimit';
import { EXCLUDED_CHAT_BOT_LOGINS, earnCooldownKey, earnDailyBudgetKey } from '../twitch-chat/economy-earn';

// `vi.mock` (and `vi.hoisted`) calls are hoisted by Vitest above every import in this file, however far below
// them they're written — so `manager.ts`'s own `import ... from './helix'` resolves to this mock, and any
// outer variable the factory closes over must itself come from `vi.hoisted` (a plain `const` here would still
// be in its temporal dead zone when the factory actually runs). See `twitch-chat-timers.test.ts` for the same
// pattern.
const mocks = vi.hoisted(() => ({
  getBotIdentityRow: vi.fn(),
  createChatSubscription: vi.fn(),
  deleteEventSubSubscription: vi.fn(),
  sendChatMessage: vi.fn(),
  getStream: vi.fn(),
  getChannelInfo: vi.fn(),
  getUserByLogin: vi.fn(),
  pruneSendThrottle: vi.fn(),
}));

vi.mock('../twitch-chat/helix', () => mocks);

// The channel-economy ledger is mocked (its own unit tests live in `channel-economy/__tests__`): the economy tests
// below pin WHICH ledger call the manager makes for a channel's own currency, and under which gates. Same hoisting
// rationale as `mocks` above.
const ledgerMocks = vi.hoisted(() => ({
  getOrCreateChannelWallet: vi.fn(),
  claimChannelDaily: vi.fn(),
  giveChannel: vi.fn(),
  creditChannel: vi.fn(),
  getChannelEarnedLeaderboard: vi.fn(),
}));
vi.mock('../../channel-economy/ledger', () => ledgerMocks);

// Discord <-> Twitch chat bridge mocks — same hoisting rationale as `mocks` above.
const bridgeWebhookMocks = vi.hoisted(() => ({
  checkBridgeChannelAccess: vi.fn(),
  ensureBridgeWebhook: vi.fn(),
  clearBridgeWebhook: vi.fn(),
}));
vi.mock('../twitch-chat/bridge-webhook', () => ({
  ...bridgeWebhookMocks,
  UNKNOWN_WEBHOOK_ERROR_CODE: 10015,
}));

/** `manager.ts` constructs `new WebhookClient(...)` directly as a lazy fallback for the Twitch->Discord relay
 * send (outside `bridge-webhook.ts`, which is fully mocked above) — mocked here, preserving every other
 * `discord.js` export via `importOriginal`, so `relayTwitchToDiscordIfBridged` tests can assert on the send
 * without a live webhook. `ctorCalls` records every `new WebhookClient(...)` invocation (id/token used), which
 * is exactly what the webhook-client caching tests assert on: a shared cached client should mean this stays at
 * 1 across several relayed messages, and only grows when the cache is legitimately invalidated. */
const webhookClientMocks = vi.hoisted(() => ({ send: vi.fn(), ctorCalls: [] as { id: string; token: string }[] }));
vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  return {
    ...actual,
    WebhookClient: class {
      id: string;
      token: string;
      constructor(opts: { id: string; token: string }) {
        webhookClientMocks.ctorCalls.push(opts);
        this.id = opts.id;
        this.token = opts.token;
      }
      send(...args: unknown[]) {
        return webhookClientMocks.send(...args);
      }
    },
  };
});

/** `manager.ts`'s `relayTwitchToDiscordIfBridged` calls the real `decryptSecret` on `bridgeWebhookTokenEnc` —
 * mocked here (preserving every other `@pavisie/core` export via `importOriginal`) so bridge tests don't need a
 * real `ENCRYPTION_KEY`/`encryptSecret` round trip; the stored "encrypted" value in tests is just a plain
 * placeholder string this stub strips a prefix from. */
const coreMocks = vi.hoisted(() => ({ decryptSecret: vi.fn((enc: string) => enc.replace(/^enc:/, '')) }));
vi.mock('@pavisie/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pavisie/core')>();
  return { ...actual, decryptSecret: coreMocks.decryptSecret };
});

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readyState = 1;
  closeCalls: unknown[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closeCalls.push(true);
  }

  emit(messageType: string, payload: unknown): void {
    this.onmessage?.({
      data: JSON.stringify({
        metadata: { message_id: '1', message_type: messageType, message_timestamp: new Date().toISOString() },
        payload,
      }),
    });
  }
}

const FakeWebSocketCtor = FakeWebSocket as unknown as WebSocketConstructorLike;

/** Drains the microtask queue enough times for a fire-and-forget `void this.reconcile(ctx)` chain (a handful of
 * `await`s deep — including its own bot-identity re-check, the desired-channel-set computation, and the create/
 * update calls per channel — none of them real timers) to fully settle before assertions run. */
async function flush(times = 60): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function makeEnv(overrides: Partial<{ TWITCH_CLIENT_ID: string; TWITCH_CLIENT_SECRET: string }> = {}) {
  return {
    TWITCH_CLIENT_ID: 'client-id',
    TWITCH_CLIENT_SECRET: 'client-secret',
    ...overrides,
  } as unknown as PluginContext['env'];
}

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } as unknown as PluginContext['logger'];
}

function makeChannelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'channel-a',
    guildId: 'guild-1',
    broadcasterUserId: 'b-1',
    broadcasterLogin: 'somestreamer',
    enabled: true,
    status: 'PENDING',
    lastError: null,
    lastConnectedAt: null,
    commandPrefix: '!',
    connectionId: null,
    bridgeDiscordChannelId: null,
    bridgeDiscordToTwitch: false,
    bridgeTwitchToDiscord: false,
    bridgeWebhookId: null,
    bridgeWebhookTokenEnc: null,
    bridgeLastError: null,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A minimal fake discord.js `Guild` — just enough for `resolveTextChannel` (real implementation, not mocked)
 * to resolve a sendable text channel, and for `ctx.client.guilds.cache` lookups in `runBridgeReconcile`/
 * `announceBridgeIfNeeded`. */
function makeGuild(overrides: Record<string, unknown> = {}) {
  const sendMock = vi.fn().mockResolvedValue({});
  const fakeChannel = {
    id: 'discord-chan-1',
    isTextBased: () => true,
    type: 0,
    send: sendMock,
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = {
    id: 'guild-1',
    channels: { fetch: vi.fn().mockResolvedValue(fakeChannel) },
    members: { me: { id: 'bot-member-1' } },
    ...overrides,
  };
  return { guild, fakeChannel, sendMock };
}

function makeCommandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'command-1',
    channelId: 'channel-a',
    guildId: 'guild-1',
    name: 'hello',
    response: 'Hi {user}!',
    cooldownSeconds: 5,
    minLevel: 'EVERYONE',
    enabled: true,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function notificationFrame(overrides: Record<string, unknown> = {}) {
  return {
    subscription: { id: 'sub-b-1', type: 'channel.chat.message', version: '1', status: 'enabled' },
    event: {
      broadcaster_user_id: 'b-1',
      chatter_user_id: 'viewer-1',
      chatter_user_login: 'viewerone',
      chatter_user_name: 'ViewerOne',
      message: { text: '!hello' },
      badges: [],
      ...overrides,
    },
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.clearAllMocks();
  mocks.getBotIdentityRow.mockResolvedValue({ botUserId: 'bot-1', botLogin: 'pavisiebot' });
  mocks.createChatSubscription.mockImplementation(async (_ctx: unknown, _sessionId: string, broadcasterUserId: string) => ({
    ok: true,
    subscriptionId: `sub-${broadcasterUserId}`,
  }));
  mocks.deleteEventSubSubscription.mockResolvedValue(true);
  mocks.sendChatMessage.mockResolvedValue({ ok: true });
  mocks.getStream.mockResolvedValue({ ok: true, value: null });
  mocks.getChannelInfo.mockResolvedValue({ ok: true, value: null });
  mocks.getUserByLogin.mockResolvedValue({ ok: true, value: null });

  bridgeWebhookMocks.checkBridgeChannelAccess.mockResolvedValue({ ok: true });
  bridgeWebhookMocks.ensureBridgeWebhook.mockResolvedValue({ ok: true, client: { send: vi.fn() } });
  bridgeWebhookMocks.clearBridgeWebhook.mockResolvedValue(undefined);
  webhookClientMocks.send.mockReset();
  webhookClientMocks.send.mockResolvedValue({});
  webhookClientMocks.ctorCalls.length = 0;
  coreMocks.decryptSecret.mockClear();
  // The Twitch -> Discord relay's per-channel send-rate token bucket (`bridge-ratelimit.ts`) and drop counter
  // (`bridge-metrics.ts`) are real, unmocked module-level singletons keyed by `TwitchChatChannel.id` — reset the
  // id every bridge test in this file actually uses so each test starts with a full bucket and a zeroed drop
  // count, independent of what earlier tests did on the same channel id.
  pruneBridgeSendBucket('channel-a');
  pruneBridgeDropCount('channel-a');
});

describe('TwitchChatManager idle states', () => {
  it('idles with a reason when TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET are not configured', async () => {
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv({ TWITCH_CLIENT_ID: undefined, TWITCH_CLIENT_SECRET: undefined }) },
    });

    await manager.start(ctx);

    const status = manager.status();
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/TWITCH_CLIENT_ID/);
    expect(mocks.getBotIdentityRow).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('idles with a reason when no TwitchBotIdentity row exists yet', async () => {
    mocks.getBotIdentityRow.mockResolvedValue(null);
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({ overrides: { env: makeEnv() } });

    await manager.start(ctx);

    const status = manager.status();
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/Twitch bot account/i);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('reconcile() retries tryConnect on every tick, so completing owner setup later needs no restart', async () => {
    mocks.getBotIdentityRow.mockResolvedValue(null);
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => [makeChannelRow()], update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    expect(manager.status().enabled).toBe(false);

    // Owner finishes the connect flow later; no restart happens, just the next `twitch-chat-tick`.
    mocks.getBotIdentityRow.mockResolvedValue({ botUserId: 'bot-1', botLogin: 'pavisiebot' });
    await manager.reconcile(ctx);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not open a socket when env + bot identity are configured but no channels are linked yet', async () => {
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: { twitchChatChannel: { findMany: async () => [] } },
    });

    await manager.start(ctx);

    const status = manager.status();
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/no linked twitch channels/i);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('connects once a channel is linked on a later reconcile tick (idle -> connect), no restart needed', async () => {
    let channels: unknown[] = [];
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => channels, update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(manager.status().enabled).toBe(false);

    channels = [makeChannelRow()];
    await manager.reconcile(ctx);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('TwitchChatManager reconcile (subscription diffing)', () => {
  it('subscribes only channels whose guild has the integrations plugin enabled, and updates the row to CONNECTED', async () => {
    const channelEnabledGuild = makeChannelRow({ id: 'channel-a', guildId: 'guild-1', broadcasterUserId: 'b-1' });
    const channelDisabledGuild = makeChannelRow({ id: 'channel-b', guildId: 'guild-2', broadcasterUserId: 'b-2' });
    const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];

    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: {
        env: makeEnv(),
        isEnabled: async (guildId: string) => guildId === 'guild-1',
      },
      prismaOverrides: {
        twitchChatChannel: {
          findMany: async () => [channelEnabledGuild, channelDisabledGuild],
          update: async (args: unknown) => {
            updates.push(args as (typeof updates)[number]);
            return {};
          },
        },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();

    expect(mocks.createChatSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.createChatSubscription).toHaveBeenCalledWith(ctx, 'sess-1', 'b-1');
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);

    const connectedUpdate = updates.find((u) => u.where.id === 'channel-a');
    expect(connectedUpdate?.data.status).toBe('CONNECTED');
  });

  it('removes a stale subscription once its channel is no longer desired (disabled/removed/guild disabled), without disturbing other channels', async () => {
    const channel = makeChannelRow({ id: 'channel-a', broadcasterUserId: 'b-1' });
    const otherChannel = makeChannelRow({ id: 'channel-b', broadcasterUserId: 'b-2' });
    let channels = [channel, otherChannel];
    const updates: Record<string, unknown>[] = [];

    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: {
          findMany: async () => channels,
          update: async (args: unknown) => {
            updates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();
    expect(manager.connectedChannelIds().sort()).toEqual(['channel-a', 'channel-b']);

    channels = [otherChannel]; // channel-a disabled/deleted/guild disabled — no longer in the desired set
    await manager.reconcile(ctx);

    expect(mocks.deleteEventSubSubscription).toHaveBeenCalledWith(ctx, 'sub-b-1');
    expect(manager.connectedChannelIds()).toEqual(['channel-b']);
    // channel-b is still desired — the socket must stay up and connected, not go idle.
    expect(manager.status().connected).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('closes the socket and returns to idle when the last linked channel is removed while connected', async () => {
    const channel = makeChannelRow();
    let channels: unknown[] = [channel];

    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => channels, update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);

    channels = []; // the only linked channel is disabled/deleted/guild disabled
    await manager.reconcile(ctx);

    expect(mocks.deleteEventSubSubscription).toHaveBeenCalledWith(ctx, 'sub-b-1');
    expect(manager.connectedChannelIds()).toEqual([]);
    const status = manager.status();
    expect(status.connected).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/no linked twitch channels/i);
    // Closed cleanly (suppressed onClosed) — no backoff/reconnect was scheduled.
    expect(ws.closeCalls).toHaveLength(1);

    // A further tick with still-zero channels must not open a new socket (no reconnect loop).
    await manager.reconcile(ctx);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('caps subscriptions at 150 channels (each channel now costs up to two of the 300 EventSub subscriptions) and warns about the excess', async () => {
    const rows = Array.from({ length: 155 }, (_, i) =>
      makeChannelRow({ id: `channel-${i}`, broadcasterUserId: `b-${i}` }),
    );
    const logger = makeLogger();

    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv(), logger },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => rows, update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
        twitchChatReward: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    // 150 channels x several sequential `await`s each in the reconcile loop — needs many more microtask ticks
    // than the single-channel tests above.
    await flush(5000);

    expect(manager.connectedChannelIds()).toHaveLength(150);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('TwitchChatManager reconcile reentrancy', () => {
  it('coalesces overlapping reconcile() calls so a channel is only ever subscribed once', async () => {
    const channelA = makeChannelRow({ id: 'channel-a', broadcasterUserId: 'b-1' });
    let channels = [channelA];

    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => channels, update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);
    mocks.createChatSubscription.mockClear();

    // A second channel becomes desired, and its subscription-create is made to hang so two overlapping
    // reconcile() calls below are guaranteed to race each other mid-flight, the way a minute tick and a
    // post-welcome/reconcileNow nudge could in production.
    const channelB = makeChannelRow({ id: 'channel-b', broadcasterUserId: 'b-2' });
    channels = [channelA, channelB];
    let resolveCreate: (v: unknown) => void = () => undefined;
    mocks.createChatSubscription.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const p1 = manager.reconcile(ctx);
    const p2 = manager.reconcile(ctx); // overlapping call — must coalesce, not race p1's in-flight create
    await flush(50); // let pass 1 advance up to (and block on) the createChatSubscription call
    resolveCreate({ ok: true, subscriptionId: 'sub-b-2' });
    await Promise.all([p1, p2]);
    await flush();

    expect(mocks.createChatSubscription).toHaveBeenCalledTimes(1);
    expect(manager.connectedChannelIds().sort()).toEqual(['channel-a', 'channel-b']);
  });
});

describe('TwitchChatManager tryConnect guards', () => {
  it("stop() during a mid-await tryConnect leaves no socket once the awaited identity fetch resolves", async () => {
    let resolveIdentity: (v: unknown) => void = () => undefined;
    mocks.getBotIdentityRow.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIdentity = resolve;
        }),
    );

    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: { twitchChatChannel: { findMany: async () => [makeChannelRow()] } },
    });

    const startPromise = manager.start(ctx);
    await manager.stop();
    resolveIdentity({ botUserId: 'bot-1', botLogin: 'pavisiebot' });
    await startPromise;
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  describe('with a pending backoff timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('a reconcile() tick during a pending backoff timer does not open a second socket early', async () => {
      const channel = makeChannelRow();
      const manager = new TwitchChatManager(FakeWebSocketCtor);
      const { ctx } = createTestContext({
        overrides: { env: makeEnv() },
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
          twitchChatCommand: { findMany: async () => [] },
        },
      });

      await manager.start(ctx);
      const ws1 = FakeWebSocket.instances[0];
      ws1.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
      await flush();

      ws1.onclose?.({ code: 1006, reason: 'abnormal closure' }); // schedules a backoff reconnect
      expect(FakeWebSocket.instances).toHaveLength(1);

      await manager.reconcile(ctx); // must not race ahead of the pending backoff timer
      expect(FakeWebSocket.instances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2500);
      await flush();
      expect(FakeWebSocket.instances).toHaveLength(2); // the backoff timer itself eventually reconnects
    });
  });
});

describe('TwitchChatManager re-checks the bot identity every reconcile tick', () => {
  it('goes idle and closes the socket once the bot identity is deleted while connected', async () => {
    const channel = makeChannelRow();
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();
    expect(manager.status().connected).toBe(true);

    mocks.getBotIdentityRow.mockResolvedValue(null); // owner ran DELETE /owner/twitch-bot
    await manager.reconcile(ctx);

    const status = manager.status();
    expect(status.connected).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/twitch bot account/i);
    expect(manager.connectedChannelIds()).toEqual([]);
    expect(ws.closeCalls).toHaveLength(1); // closed cleanly, no reconnect scheduled
  });

  it('goes idle and closes the socket once the bot identity turns ERROR while connected', async () => {
    const channel = makeChannelRow();
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();
    expect(manager.status().connected).toBe(true);

    // A terminal token-refresh failure elsewhere marked the identity row ERROR.
    mocks.getBotIdentityRow.mockResolvedValue({ botUserId: 'bot-1', botLogin: 'pavisiebot', status: 'ERROR' });
    await manager.reconcile(ctx);

    const status = manager.status();
    expect(status.connected).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/re-auth/i);
    expect(ws.closeCalls).toHaveLength(1);
  });
});

describe('TwitchChatManager session_reconnect', () => {
  it('follows the reconnect_url without recreating subscriptions, and retires the old socket', async () => {
    const channel = makeChannelRow();
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws1 = FakeWebSocket.instances[0];
    ws1.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();
    expect(mocks.createChatSubscription).toHaveBeenCalledTimes(1);

    ws1.emit('session_reconnect', {
      session: { id: 'sess-1', status: 'reconnecting', keepalive_timeout_seconds: null, reconnect_url: 'wss://example/ws?id=2' },
    });
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = FakeWebSocket.instances[1];
    expect(ws2.url).toBe('wss://example/ws?id=2');

    ws2.emit('session_welcome', { session: { id: 'sess-2', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();

    // Subscriptions carried over automatically — no second create call.
    expect(mocks.createChatSubscription).toHaveBeenCalledTimes(1);
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);
    expect(manager.status().sessionId).toBe('sess-2');
    expect(ws1.closeCalls).toHaveLength(1); // the old socket was retired once the new one welcomed
  });
});

describe('TwitchChatManager socket death + backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects after backoff and fully resubscribes (subscriptions die with the old session)', async () => {
    const channel = makeChannelRow();
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws1 = FakeWebSocket.instances[0];
    ws1.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();
    expect(mocks.createChatSubscription).toHaveBeenCalledTimes(1);

    // The socket dies unexpectedly (server/network) — not a graceful session_reconnect.
    ws1.onclose?.({ code: 1006, reason: 'abnormal closure' });
    expect(manager.status().connected).toBe(false);

    // Backoff starts at 1s (+ up to 1s jitter); 2.5s comfortably covers it.
    await vi.advanceTimersByTimeAsync(2500);
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = FakeWebSocket.instances[1];
    ws2.emit('session_welcome', { session: { id: 'sess-3', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();

    expect(mocks.createChatSubscription).toHaveBeenCalledTimes(2); // fully resubscribed, not carried over
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);
  });
});

describe('TwitchChatManager revocation', () => {
  it('marks the channel ERROR and stops tracking it', async () => {
    const channel = makeChannelRow();
    const updates: Record<string, unknown>[] = [];
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: {
          findMany: async () => [channel],
          update: async (args: unknown) => {
            updates.push((args as { data: Record<string, unknown> }).data);
            return {};
          },
        },
        twitchChatCommand: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();

    ws.emit('revocation', { subscription: { id: 'sub-b-1', type: 'channel.chat.message', status: 'authorization_revoked' } });
    await flush();

    expect(manager.connectedChannelIds()).toEqual([]);
    const errorUpdate = updates.find((u) => u.status === 'ERROR');
    expect(errorUpdate?.lastError).toMatch(/revoked/i);
  });
});

describe('TwitchChatManager chat message handling', () => {
  async function setupWithOneChannel() {
    const channel = makeChannelRow();
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [makeCommandRow()] },
      },
    });
    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', { session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } });
    await flush();
    return { manager, ctx, ws };
  }

  it('replies to a matching command by sending via Helix', async () => {
    const { ws, ctx } = await setupWithOneChannel();

    ws.emit('notification', notificationFrame({ message: { text: '!hello' } }));
    await flush();

    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', 'Hi ViewerOne!');
  });

  it('a thrown error while computing a reply never kills the manager — later messages still work', async () => {
    const { ws } = await setupWithOneChannel();

    mocks.getStream.mockRejectedValueOnce(new Error('Helix is down'));
    ws.emit('notification', notificationFrame({ message: { text: '!uptime' } }));
    await flush();

    // The manager is still alive and processes the next message normally.
    ws.emit('notification', notificationFrame({ message: { text: '!hello' } }));
    await flush();

    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(expect.anything(), 'b-1', 'Hi ViewerOne!');
  });

  it('never replies to a message from the bot itself', async () => {
    const { ws } = await setupWithOneChannel();

    ws.emit(
      'notification',
      notificationFrame({ chatter_user_id: 'bot-1', chatter_user_name: 'pavisiebot', message: { text: '!hello' } }),
    );
    await flush();

    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Discord <-> Twitch chat bridge (opt-in, off by default per direction)
// ---------------------------------------------------------------------------------------------------------

/** Connects one channel (chat subscription live) whose row can then be mutated in place via `setChannel` —
 * `findMany`/`findUnique`/`update` all close over the same `let channel` so a test's PATCH-equivalent write is
 * immediately visible to the next `reconcile()` tick's `computeDesiredChannels`/cache-refresh reads. */
async function setupConnectedChannel(channelOverrides: Record<string, unknown> = {}) {
  let channel: Record<string, unknown> = makeChannelRow(channelOverrides);
  const updates: Record<string, unknown>[] = [];
  const { guild, fakeChannel, sendMock } = makeGuild({ id: channel.guildId });

  const manager = new TwitchChatManager(FakeWebSocketCtor);
  const { ctx } = createTestContext({
    overrides: {
      env: makeEnv(),
      client: {
        guilds: { cache: new Map([[channel.guildId, guild]]), fetch: vi.fn() },
      } as unknown as PluginContext['client'],
    },
    prismaOverrides: {
      twitchChatChannel: {
        findMany: async () => [channel],
        findUnique: async () => channel,
        update: async (args: unknown) => {
          const data = (args as { data: Record<string, unknown> }).data;
          updates.push(data);
          channel = { ...channel, ...data };
          return channel;
        },
      },
      twitchChatCommand: { findMany: async () => [] },
      twitchChatReward: { findMany: async () => [] },
    },
  });

  await manager.start(ctx);
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.emit('session_welcome', {
    session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null },
  });
  await flush();

  return {
    manager,
    ctx,
    ws,
    guild,
    fakeChannel,
    sendMock,
    updates,
    getChannel: () => channel,
    setChannel: (next: Record<string, unknown>) => {
      channel = next;
    },
  };
}

/** Connects a channel with the Twitch -> Discord relay direction already fully provisioned (webhook credential
 * stored) — shared by `relayTwitchToDiscordIfBridged` tests and the rate-limiting tests below them, both of
 * which exercise the relay via an incoming chat notification. */
function setupBridgedChatChannel(overrides: Record<string, unknown> = {}) {
  return setupConnectedChannel({
    bridgeDiscordChannelId: 'discord-chan-1',
    bridgeTwitchToDiscord: true,
    bridgeWebhookId: 'wh-1',
    bridgeWebhookTokenEnc: 'enc:tok-1',
    commandPrefix: '!',
    ...overrides,
  });
}

describe('TwitchChatManager Discord <-> Twitch chat bridge', () => {
  describe('runBridgeReconcile', () => {
    it('creates the bridge webhook once bridgeTwitchToDiscord turns on and no webhook exists yet', async () => {
      const { manager, ctx } = await setupConnectedChannel({
        bridgeDiscordChannelId: 'discord-chan-1',
        bridgeTwitchToDiscord: true,
      });
      bridgeWebhookMocks.ensureBridgeWebhook.mockClear();

      await manager.reconcile(ctx);

      expect(bridgeWebhookMocks.ensureBridgeWebhook).toHaveBeenCalledTimes(1);
      const call = bridgeWebhookMocks.ensureBridgeWebhook.mock.calls[0] as unknown[];
      expect(call[2]).toMatchObject({ id: 'channel-a' });
    });

    it('does not try to recreate a webhook that already has stored credentials', async () => {
      const { manager, ctx } = await setupConnectedChannel({
        bridgeDiscordChannelId: 'discord-chan-1',
        bridgeTwitchToDiscord: true,
        bridgeWebhookId: 'wh-1',
        bridgeWebhookTokenEnc: 'enc:tok-1',
      });
      bridgeWebhookMocks.ensureBridgeWebhook.mockClear();

      await manager.reconcile(ctx);

      expect(bridgeWebhookMocks.ensureBridgeWebhook).not.toHaveBeenCalled();
    });

    it('sets bridgeLastError on a Discord access-check failure, and clears it once access recovers', async () => {
      const { manager, ctx, getChannel } = await setupConnectedChannel({
        bridgeDiscordChannelId: 'discord-chan-1',
        bridgeDiscordToTwitch: true,
      });
      bridgeWebhookMocks.checkBridgeChannelAccess.mockResolvedValueOnce({
        ok: false,
        error: 'Pavisie needs View Channel, Send Messages, and Manage Webhooks in the bridge Discord channel.',
      });

      await manager.reconcile(ctx);
      expect(getChannel().bridgeLastError).toMatch(/Manage Webhooks/);

      bridgeWebhookMocks.checkBridgeChannelAccess.mockResolvedValue({ ok: true });
      await manager.reconcile(ctx);
      expect(getChannel().bridgeLastError).toBeNull();
    });

    it('leaves the announce-once map and drop counter alone the moment the bridge is fully off', async () => {
      const { manager, ctx } = await setupConnectedChannel({ bridgeDiscordChannelId: null });
      bridgeWebhookMocks.checkBridgeChannelAccess.mockClear();

      await manager.reconcile(ctx);

      // No channel id configured — bridge reconcile bails out before ever checking Discord access.
      expect(bridgeWebhookMocks.checkBridgeChannelAccess).not.toHaveBeenCalled();
    });
  });

  describe('announce-once behavior', () => {
    it('announces once per direction on enable, not again while staying on, and again after an off/on cycle', async () => {
      const { manager, ctx, sendMock, getChannel, setChannel } = await setupConnectedChannel({
        bridgeDiscordChannelId: 'discord-chan-1',
      });

      setChannel({ ...getChannel(), bridgeDiscordToTwitch: true });
      await manager.reconcile(ctx);
      expect(sendMock).toHaveBeenCalledTimes(1); // Discord-side announcement
      expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1); // Twitch-side announcement

      await manager.reconcile(ctx); // stays on — must not re-announce
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);

      setChannel({ ...getChannel(), bridgeDiscordToTwitch: false });
      await manager.reconcile(ctx);
      setChannel({ ...getChannel(), bridgeDiscordToTwitch: true });
      await manager.reconcile(ctx); // turned back on — announces again

      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(mocks.sendChatMessage).toHaveBeenCalledTimes(2);
    });

    it('announces each direction independently', async () => {
      const { manager, ctx, sendMock, getChannel, setChannel } = await setupConnectedChannel({
        bridgeDiscordChannelId: 'discord-chan-1',
      });

      setChannel({ ...getChannel(), bridgeTwitchToDiscord: true });
      await manager.reconcile(ctx);
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);

      setChannel({ ...getChannel(), bridgeDiscordToTwitch: true });
      await manager.reconcile(ctx);
      // The already-announced direction doesn't re-fire; only the newly-enabled direction adds one more of each.
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(mocks.sendChatMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('relayTwitchToDiscordIfBridged (exercised via an incoming chat notification)', () => {

    it('relays a Twitch chat message to the Discord bridge webhook', async () => {
      const { ws } = await setupBridgedChatChannel();

      ws.emit('notification', notificationFrame({ message: { text: 'gg well played' } }));
      await flush();

      expect(webhookClientMocks.send).toHaveBeenCalledTimes(1);
      const [payload] = webhookClientMocks.send.mock.calls[0] as [Record<string, unknown>];
      expect(payload.username).toBe('ViewerOne (Twitch)');
      expect(payload.content).toBe('gg well played');
      expect(payload.allowedMentions).toEqual({ parse: [] });
    });

    it('suppresses link-preview embeds on the relayed send', async () => {
      const { ws } = await setupBridgedChatChannel();

      ws.emit('notification', notificationFrame({ message: { text: 'check this out https://example.com' } }));
      await flush();

      expect(webhookClientMocks.send).toHaveBeenCalledTimes(1);
      const [payload] = webhookClientMocks.send.mock.calls[0] as [Record<string, unknown>];
      expect(payload.flags).toBe(MessageFlags.SuppressEmbeds);
    });

    it('reuses the same cached WebhookClient instance across multiple relayed messages for the same channel', async () => {
      const { ws } = await setupBridgedChatChannel();

      ws.emit('notification', notificationFrame({ message: { text: 'message one' } }));
      await flush();
      ws.emit('notification', notificationFrame({ message: { text: 'message two' } }));
      await flush();
      ws.emit('notification', notificationFrame({ message: { text: 'message three' } }));
      await flush();

      expect(webhookClientMocks.send).toHaveBeenCalledTimes(3);
      // Only one `new WebhookClient(...)` was ever constructed — the other two messages reused the cached one.
      expect(webhookClientMocks.ctorCalls).toHaveLength(1);
    });

    it('replaces the cached client once the channel bridge webhook credential changes (channel-change reconcile)', async () => {
      const { manager, ctx, ws, getChannel, setChannel } = await setupBridgedChatChannel();

      ws.emit('notification', notificationFrame({ message: { text: 'before the change' } }));
      await flush();
      expect(webhookClientMocks.send).toHaveBeenCalledTimes(1);
      expect(webhookClientMocks.ctorCalls).toHaveLength(1);

      // Simulate the bridge Discord channel changing: the API route/slash command immediately nulls the stored
      // webhook credential, then nudges reconcile — which here provisions a brand-new webhook via
      // `ensureBridgeWebhook` (mocked) and must drop the stale cached client rather than keep reusing it.
      const newSend = vi.fn().mockResolvedValue({});
      bridgeWebhookMocks.ensureBridgeWebhook.mockResolvedValueOnce({ ok: true, client: { send: newSend } });
      setChannel({ ...getChannel(), bridgeWebhookId: null, bridgeWebhookTokenEnc: null });
      await manager.reconcile(ctx);
      // `ensureBridgeWebhook` is mocked, so (unlike the real implementation) it doesn't itself persist the new
      // credential to the row — reflect what the real implementation would have written so the row is
      // "provisioned" again for the next reconcile's cache refresh and for `relayTwitchToDiscordIfBridged`'s own
      // provisioned-check.
      setChannel({ ...getChannel(), bridgeWebhookId: 'wh-2', bridgeWebhookTokenEnc: 'enc:tok-2' });
      await manager.reconcile(ctx); // refreshes the channel cache with the now-provisioned row

      ws.emit('notification', notificationFrame({ message: { text: 'after the change' } }));
      await flush();

      // The second message went through the freshly-cached client, not the stale one, and no NEW
      // `new WebhookClient(...)` was constructed either (the replacement came from `ensureBridgeWebhook`).
      expect(newSend).toHaveBeenCalledTimes(1);
      expect(webhookClientMocks.send).toHaveBeenCalledTimes(1); // unchanged — the old client never saw a 2nd send
      expect(webhookClientMocks.ctorCalls).toHaveLength(1);
    });

    it('self-ignores a message from the bot identity itself (safety rule 1)', async () => {
      const { ws } = await setupBridgedChatChannel();

      ws.emit(
        'notification',
        notificationFrame({
          chatter_user_id: 'bot-1',
          chatter_user_name: 'pavisiebot',
          message: { text: '[Discord] Someone: hi' },
        }),
      );
      await flush();

      expect(webhookClientMocks.send).not.toHaveBeenCalled();
    });

    it('skips a message that starts with the channel command prefix (safety rule 3)', async () => {
      const { ws } = await setupBridgedChatChannel();

      ws.emit('notification', notificationFrame({ message: { text: '!hello' } }));
      await flush();

      expect(webhookClientMocks.send).not.toHaveBeenCalled();
    });

    it('does nothing when the bridge webhook has not been provisioned yet', async () => {
      const { ws } = await setupConnectedChannel({
        bridgeDiscordChannelId: 'discord-chan-1',
        bridgeTwitchToDiscord: true,
      });

      ws.emit('notification', notificationFrame({ message: { text: 'hi there' } }));
      await flush();

      expect(webhookClientMocks.send).not.toHaveBeenCalled();
    });

    it('clears the stored webhook credential on an Unknown Webhook (10015) failure, so the next reconcile recreates it', async () => {
      webhookClientMocks.send.mockRejectedValueOnce(Object.assign(new Error('Unknown Webhook'), { code: 10015 }));
      const { ws } = await setupBridgedChatChannel();

      ws.emit('notification', notificationFrame({ message: { text: 'hi there' } }));
      await flush();

      expect(bridgeWebhookMocks.clearBridgeWebhook).toHaveBeenCalledWith(expect.anything(), 'channel-a');
    });
  });

  describe('relayTwitchToDiscordIfBridged rate limiting (bridge-ratelimit.ts)', () => {
    it('drops relayed messages once the per-channel token bucket is exhausted, and counts the drop', async () => {
      const { ws } = await setupBridgedChatChannel();
      expect(getBridgeDropCount('channel-a')).toBe(0);

      // MAX_BURST_TOKENS is 5 — sent back-to-back with no real time elapsed between them (no meaningful refill),
      // the first 5 should go through and every message beyond that should be dropped rather than sent.
      for (let i = 0; i < 7; i++) {
        ws.emit('notification', notificationFrame({ message: { text: `burst message ${i}` } }));
        await flush();
      }

      expect(webhookClientMocks.send).toHaveBeenCalledTimes(5);
      expect(getBridgeDropCount('channel-a')).toBe(2);
    });

    it('does not spend a token (or record a drop) for a message excluded by an earlier safety rule', async () => {
      const { ws } = await setupBridgedChatChannel();

      // A command-prefixed message is excluded before the token bucket is ever consulted (safety rule 3) — it
      // must not eat into the budget available to real relayable messages.
      for (let i = 0; i < 10; i++) {
        ws.emit('notification', notificationFrame({ message: { text: '!not-relayed' } }));
        await flush();
      }
      expect(webhookClientMocks.send).not.toHaveBeenCalled();
      expect(getBridgeDropCount('channel-a')).toBe(0);

      ws.emit('notification', notificationFrame({ message: { text: 'this one is relayed' } }));
      await flush();
      expect(webhookClientMocks.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('regression: both directions off relays nothing', () => {
    it('does not relay in either direction, and does not announce, even with a bridge Discord channel configured', async () => {
      const { manager, ctx, ws, sendMock } = await setupConnectedChannel({
        bridgeDiscordChannelId: 'discord-chan-1',
        bridgeDiscordToTwitch: false,
        bridgeTwitchToDiscord: false,
      });

      await manager.reconcile(ctx);
      expect(sendMock).not.toHaveBeenCalled();
      expect(bridgeWebhookMocks.ensureBridgeWebhook).not.toHaveBeenCalled();

      ws.emit('notification', notificationFrame({ message: { text: 'hello there' } }));
      await flush();
      expect(webhookClientMocks.send).not.toHaveBeenCalled();
    });
  });

  describe('privacy: the bridge relay never logs message text or chatter identity', () => {
    it('no logger call contains the sentinel message text', async () => {
      const SENTINEL_TEXT = 'sentinel-bridge-relay-text-should-never-be-logged';
      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as unknown as PluginContext['logger'];
      webhookClientMocks.send.mockRejectedValueOnce(Object.assign(new Error('fail'), { code: 10015 }));

      const { ctx, ws } = await setupConnectedChannel({
        bridgeDiscordChannelId: 'discord-chan-1',
        bridgeTwitchToDiscord: true,
        bridgeWebhookId: 'wh-1',
        bridgeWebhookTokenEnc: 'enc:tok-1',
      });
      // Swap in the spy logger after setup so the setup's own reconcile pass doesn't pollute assertions below.
      (ctx as { logger: unknown }).logger = logger;

      ws.emit('notification', notificationFrame({ message: { text: SENTINEL_TEXT } }));
      await flush();

      expect(bridgeWebhookMocks.clearBridgeWebhook).toHaveBeenCalled();
      for (const fn of [logger.warn, logger.error, logger.info, logger.debug]) {
        for (const call of (fn as unknown as ReturnType<typeof vi.fn>).mock.calls) {
          expect(JSON.stringify(call)).not.toContain(SENTINEL_TEXT);
        }
      }
    });

    it('no logger call contains the sentinel text for a message dropped by the rate-limit bucket', async () => {
      const SENTINEL_TEXT = 'sentinel-bridge-ratelimit-text-should-never-be-logged';
      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as unknown as PluginContext['logger'];

      const { ctx, ws } = await setupConnectedChannel({
        bridgeDiscordChannelId: 'discord-chan-1',
        bridgeTwitchToDiscord: true,
        bridgeWebhookId: 'wh-1',
        bridgeWebhookTokenEnc: 'enc:tok-1',
      });
      (ctx as { logger: unknown }).logger = logger;

      // Exhaust the bucket (MAX_BURST_TOKENS = 5), then one more to force a drop.
      for (let i = 0; i < 6; i++) {
        ws.emit('notification', notificationFrame({ message: { text: `${SENTINEL_TEXT}-${i}` } }));
        await flush();
      }

      expect(getBridgeDropCount('channel-a')).toBeGreaterThan(0);
      for (const fn of [logger.warn, logger.error, logger.info, logger.debug]) {
        for (const call of (fn as unknown as ReturnType<typeof vi.fn>).mock.calls) {
          expect(JSON.stringify(call)).not.toContain(SENTINEL_TEXT);
        }
      }
    });

    it('no logger call contains the chatter display name or the neutralized webhook username, even on a relay failure', async () => {
      const SENTINEL_NAME = 'DiscordSentinelViewer';
      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as unknown as PluginContext['logger'];
      webhookClientMocks.send.mockRejectedValueOnce(Object.assign(new Error('fail'), { code: 10015 }));

      const { ctx, ws } = await setupConnectedChannel({
        bridgeDiscordChannelId: 'discord-chan-1',
        bridgeTwitchToDiscord: true,
        bridgeWebhookId: 'wh-1',
        bridgeWebhookTokenEnc: 'enc:tok-1',
      });
      (ctx as { logger: unknown }).logger = logger;

      ws.emit(
        'notification',
        notificationFrame({ chatter_user_name: SENTINEL_NAME, message: { text: 'hi there' } }),
      );
      await flush();

      expect(bridgeWebhookMocks.clearBridgeWebhook).toHaveBeenCalled();
      for (const fn of [logger.warn, logger.error, logger.info, logger.debug]) {
        for (const call of (fn as unknown as ReturnType<typeof vi.fn>).mock.calls) {
          const serialized = JSON.stringify(call);
          expect(serialized).not.toContain(SENTINEL_NAME);
          expect(serialized.toLowerCase()).not.toContain('discordsentinelviewer'.toLowerCase());
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Economy: Twitch chat commands (!balance/!bal/!daily/!give/!top) and chat earning (ARCHITECTURE.md §18b/§19a/§19e).
// The currency is the CHANNEL's own (`ChannelEconomy`), read straight from the channel row — no Discord server, no
// guild-scoped economy plugin enablement or config involved. The ledger itself is mocked (its own tests live in
// `channel-economy/__tests__`); these tests pin WHICH ledger call the manager makes and under which gates.
// ---------------------------------------------------------------------------------------------------------

/** A `ChannelEconomy` row. `null` in `setupEconomyChannel` means "this channel has no currency". */
function makeEconomyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'economy-1',
    platform: 'TWITCH',
    channelUserId: 'b-1',
    enabled: true,
    currencyName: 'Agis',
    currencySymbol: '♦️',
    dailyMinAmount: 50,
    dailyMaxAmount: 150,
    streakBonusPerDay: 10,
    streakBonusMax: 200,
    giveMinAmount: 1,
    giveMaxAmount: 100000,
    earnEnabled: false,
    earnPerMessage: 5,
    earnCooldownSeconds: 60,
    earnDailyCap: 200,
    ...overrides,
  };
}

const ECONOMY_KEY = { economyId: 'economy-1', viewerUserId: 'viewer-1' };

/** Same shape as the file's own `setupWithOneChannel`, plus the channel's `ChannelEconomy` row (default: an
 * enabled one; pass `null` for "no currency") and an `isEnabled` override so the `integrations` plugin's own
 * guild enablement can be controlled independently. `findEconomy` lets a test observe/fail the row lookup. */
async function setupEconomyChannel(
  opts: {
    economy?: Record<string, unknown> | null;
    findEconomy?: () => Promise<unknown>;
    isEnabled?: PluginContext['isEnabled'];
    channelOverrides?: Record<string, unknown>;
    commands?: unknown[];
    logger?: PluginContext['logger'];
  } = {},
) {
  const channel = makeChannelRow(opts.channelOverrides);
  const economyRow = opts.economy === undefined ? makeEconomyRow() : opts.economy;
  const findEconomy = vi.fn(opts.findEconomy ?? (async () => economyRow));
  const manager = new TwitchChatManager(FakeWebSocketCtor);
  const { ctx } = createTestContext({
    overrides: {
      env: makeEnv(),
      isEnabled: opts.isEnabled ?? (async () => true),
      ...(opts.logger ? { logger: opts.logger } : {}),
    },
    prismaOverrides: {
      twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
      twitchChatCommand: { findMany: async () => opts.commands ?? [] },
      channelEconomy: { findUnique: findEconomy },
    },
  });

  await manager.start(ctx);
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.emit('session_welcome', {
    session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null },
  });
  await flush();
  return { manager, ctx, ws, channel, findEconomy };
}

function resetLedgerMocks() {
  ledgerMocks.getOrCreateChannelWallet.mockResolvedValue({ balance: 100n });
  ledgerMocks.claimChannelDaily.mockResolvedValue({ ok: true, amount: 10n, streak: 1 });
  ledgerMocks.giveChannel.mockResolvedValue({ ok: true });
  ledgerMocks.creditChannel.mockResolvedValue({ ok: true, newBalance: 0n });
  ledgerMocks.getChannelEarnedLeaderboard.mockResolvedValue([]);
}

describe('TwitchChatManager economy commands', () => {
  // ioredis-mock shares one process-wide in-memory store by default (see ai/__tests__/budget.test.ts) — the
  // economy earning tests below write real cooldown/daily-cap keys through `ctx.redis`, so start each test
  // clean regardless of what an earlier test in this file left behind.
  beforeEach(async () => {
    await new RedisMock().flushall();
    resetLedgerMocks();
  });

  it("routes !balance to the channel's wallet in the channel's own currency, never the engine", async () => {
    ledgerMocks.getOrCreateChannelWallet.mockResolvedValue({ balance: 1234n });
    const { ws, ctx } = await setupEconomyChannel({ economy: makeEconomyRow({ currencySymbol: '💎' }) });

    ws.emit('notification', notificationFrame({ message: { text: '!balance' } }));
    await flush();

    expect(ledgerMocks.getOrCreateChannelWallet).toHaveBeenCalledWith(expect.anything(), ECONOMY_KEY, 'ViewerOne');
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', '@ViewerOne, you have 1,234 💎');
  });

  it('an existing enabled custom command with a reserved name wins over the economy command', async () => {
    const { ws, ctx, findEconomy } = await setupEconomyChannel({
      commands: [makeCommandRow({ name: 'balance', response: 'Custom balance reply for {user}' })],
    });

    ws.emit('notification', notificationFrame({ message: { text: '!balance' } }));
    await flush();

    expect(ledgerMocks.getOrCreateChannelWallet).not.toHaveBeenCalled();
    expect(findEconomy).not.toHaveBeenCalled();
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', 'Custom balance reply for ViewerOne');
  });

  it('does nothing when the channel has no currency at all', async () => {
    const { ws } = await setupEconomyChannel({ economy: null });

    ws.emit('notification', notificationFrame({ message: { text: '!balance' } }));
    await flush();

    expect(ledgerMocks.getOrCreateChannelWallet).not.toHaveBeenCalled();
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it("does nothing when the channel's currency is switched off", async () => {
    const { ws } = await setupEconomyChannel({ economy: makeEconomyRow({ enabled: false }) });

    ws.emit('notification', notificationFrame({ message: { text: '!balance' } }));
    await flush();

    expect(ledgerMocks.getOrCreateChannelWallet).not.toHaveBeenCalled();
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it("no longer depends on the guild's economy plugin: works even when `economy` is disabled for the linked guild", async () => {
    const { ws, ctx } = await setupEconomyChannel({
      isEnabled: async (_guildId: string, pluginId?: string) => pluginId !== 'economy',
    });

    ws.emit('notification', notificationFrame({ message: { text: '!balance' } }));
    await flush();

    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', '@ViewerOne, you have 100 ♦️');
  });

  it('commands work when the currency is on and earning is off', async () => {
    const { ws, ctx } = await setupEconomyChannel({ economy: makeEconomyRow({ earnEnabled: false }) });

    ws.emit('notification', notificationFrame({ message: { text: '!top' } }));
    await flush();

    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', 'No one has earned anything from Twitch chat yet.');
  });

  it('!give resolves the login via Helix and gives inside the channel economy with its own bounds', async () => {
    mocks.getUserByLogin.mockResolvedValueOnce({
      ok: true,
      value: { id: 'target-twitch-id', login: 'someone', displayName: 'Someone' },
    });
    const { ws, ctx } = await setupEconomyChannel({ economy: makeEconomyRow({ giveMinAmount: 2, giveMaxAmount: 500 }) });

    ws.emit('notification', notificationFrame({ message: { text: '!give someone 25' } }));
    await flush();

    expect(ledgerMocks.giveChannel).toHaveBeenCalledWith(
      expect.anything(),
      'economy-1',
      'viewer-1',
      'target-twitch-id',
      25,
      { giveMinAmount: 2, giveMaxAmount: 500 },
      { botUserId: 'bot-1', fromDisplayName: 'ViewerOne', toDisplayName: 'Someone' },
    );
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', '@ViewerOne, gave 25 ♦️ to Someone.');
  });

  it('!daily uses the channel economy daily/streak settings', async () => {
    const { ws, ctx } = await setupEconomyChannel({
      economy: makeEconomyRow({ dailyMinAmount: 1, dailyMaxAmount: 2, streakBonusPerDay: 3, streakBonusMax: 4 }),
    });

    ws.emit('notification', notificationFrame({ message: { text: '!daily' } }));
    await flush();

    expect(ledgerMocks.claimChannelDaily).toHaveBeenCalledWith(
      expect.anything(),
      ECONOMY_KEY,
      { dailyMinAmount: 1, dailyMaxAmount: 2, streakBonusPerDay: 3, streakBonusMax: 4 },
      expect.any(Date),
      expect.any(Function),
      'ViewerOne',
    );
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', '@ViewerOne, you claimed 10 ♦️! Streak: 1 day(s).');
  });

  it('an unhandled/unrecognized message never posts a marker or internal string into chat', async () => {
    const { ws, ctx } = await setupEconomyChannel();

    for (const text of ['!nope', '!balancex', 'balance no prefix', '!give', '!GIVE someone 5']) {
      ws.emit('notification', notificationFrame({ message: { text } }));
    }
    await flush();

    for (const call of mocks.sendChatMessage.mock.calls) {
      const sentText = call[2] as string | undefined;
      expect(sentText ?? '').not.toContain('__economy');
      void ctx;
    }
  });

  it('is silent, not an error, on the per-viewer cooldown (no duplicate reply within 10s)', async () => {
    const { ws, ctx } = await setupEconomyChannel();

    ws.emit('notification', notificationFrame({ message: { text: '!balance' } }));
    await flush();
    ws.emit('notification', notificationFrame({ message: { text: '!balance' } }));
    await flush();

    expect(ledgerMocks.getOrCreateChannelWallet).toHaveBeenCalledTimes(1);
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    void ctx;
  });

  it('reads the channel currency once per cache window, not once per command', async () => {
    const { ws, findEconomy } = await setupEconomyChannel();

    for (let i = 0; i < 4; i++) {
      ws.emit(
        'notification',
        notificationFrame({ chatter_user_id: `viewer-${i}`, chatter_user_name: `Viewer${i}`, message: { text: '!balance' } }),
      );
      await flush();
    }

    expect(ledgerMocks.getOrCreateChannelWallet).toHaveBeenCalledTimes(4);
    expect(findEconomy).toHaveBeenCalledTimes(1);
  });

  it("a streamer's settings change is picked up once the cache window has passed", async () => {
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow);
    try {
      let enabled = true;
      const { ws, findEconomy } = await setupEconomyChannel({
        findEconomy: async () => makeEconomyRow({ enabled }),
      });

      ws.emit('notification', notificationFrame({ chatter_user_id: 'v-a', message: { text: '!balance' } }));
      await flush();
      expect(ledgerMocks.getOrCreateChannelWallet).toHaveBeenCalledTimes(1);

      enabled = false; // the streamer switches the currency off on the dashboard
      nowSpy.mockReturnValue(realNow + 5_000);
      ws.emit('notification', notificationFrame({ chatter_user_id: 'v-b', message: { text: '!balance' } }));
      await flush();
      expect(ledgerMocks.getOrCreateChannelWallet).toHaveBeenCalledTimes(2); // still cached (within the window)

      nowSpy.mockReturnValue(realNow + 60_000);
      ws.emit('notification', notificationFrame({ chatter_user_id: 'v-c', message: { text: '!balance' } }));
      await flush();
      expect(ledgerMocks.getOrCreateChannelWallet).toHaveBeenCalledTimes(2); // re-read: now off, no reply
      expect(findEconomy).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('no logger call contains chat text or the chatter display name on a normal economy command', async () => {
    const SENTINEL_TEXT = 'sentinel-give-text-should-never-log';
    const SENTINEL_NAME = 'SentinelEconomyViewer';
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as PluginContext['logger'];
    const { ws } = await setupEconomyChannel({ logger });

    ws.emit(
      'notification',
      notificationFrame({ chatter_user_name: SENTINEL_NAME, message: { text: `!balance ${SENTINEL_TEXT}` } }),
    );
    await flush();

    for (const fn of [logger.warn, logger.error, logger.info, logger.debug]) {
      for (const call of (fn as unknown as ReturnType<typeof vi.fn>).mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(SENTINEL_TEXT);
        expect(serialized).not.toContain(SENTINEL_NAME);
      }
    }
  });

  it('an economy handling failure is logged without chat text/display name and the manager stays alive', async () => {
    const SENTINEL_TEXT = 'sentinel-should-not-appear-in-logs';
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as PluginContext['logger'];
    const { ws, ctx } = await setupEconomyChannel({
      findEconomy: async () => {
        throw new Error('boom');
      },
      logger,
      commands: [makeCommandRow()],
    });

    ws.emit('notification', notificationFrame({ message: { text: `!balance ${SENTINEL_TEXT}` } }));
    await flush();

    // The manager is still alive — a later, unrelated custom command still works.
    ws.emit('notification', notificationFrame({ message: { text: '!hello' } }));
    await flush();
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', 'Hi ViewerOne!');
    expect(logger.warn).toHaveBeenCalled();

    for (const fn of [logger.warn, logger.error, logger.info, logger.debug]) {
      for (const call of (fn as unknown as ReturnType<typeof vi.fn>).mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL_TEXT);
        expect(JSON.stringify(call)).not.toContain('ViewerOne');
      }
    }
  });
});

describe('TwitchChatManager economy chat earning', () => {
  beforeEach(async () => {
    await new RedisMock().flushall();
    resetLedgerMocks();
  });

  const EARNING = () => makeEconomyRow({ earnEnabled: true });

  it('credits nothing when the channel is not live', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: null }); // offline
    const { ws } = await setupEconomyChannel({ economy: EARNING() });

    ws.emit('notification', notificationFrame({ message: { text: 'just chatting, not a command' } }));
    await flush();

    expect(ledgerMocks.creditChannel).not.toHaveBeenCalled();
  });

  it('credits nothing for a message from the bot itself', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws } = await setupEconomyChannel({ economy: EARNING() });

    ws.emit(
      'notification',
      notificationFrame({ chatter_user_id: 'bot-1', chatter_user_name: 'pavisiebot', message: { text: 'hello chat' } }),
    );
    await flush();

    expect(ledgerMocks.creditChannel).not.toHaveBeenCalled();
  });

  it('credits nothing for a command-attempt message, even an unrecognized one', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws } = await setupEconomyChannel({ economy: EARNING() });

    ws.emit('notification', notificationFrame({ message: { text: '!totally-unknown-command' } }));
    await flush();

    expect(ledgerMocks.creditChannel).not.toHaveBeenCalled();
  });

  it('credits nothing for the broadcaster chatting in their own channel (no self-farming)', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    // makeChannelRow()'s default broadcasterUserId is 'b-1' — send the chat message as that same user id.
    const { ws } = await setupEconomyChannel({ economy: EARNING() });

    ws.emit(
      'notification',
      notificationFrame({
        chatter_user_id: 'b-1',
        chatter_user_login: 'somestreamer',
        chatter_user_name: 'SomeStreamer',
        message: { text: 'chatting in my own stream' },
      }),
    );
    await flush();

    expect(ledgerMocks.creditChannel).not.toHaveBeenCalled();
  });

  it.each(EXCLUDED_CHAT_BOT_LOGINS)('credits nothing for the well-known chat bot login "%s" (any casing)', async (botLogin) => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws } = await setupEconomyChannel({ economy: EARNING() });

    ws.emit(
      'notification',
      notificationFrame({
        chatter_user_id: `bot-account-${botLogin}`,
        chatter_user_login: botLogin.toUpperCase(), // case-insensitivity
        chatter_user_name: botLogin,
        message: { text: 'automated timer message' },
      }),
    );
    await flush();

    expect(ledgerMocks.creditChannel).not.toHaveBeenCalled();
  });

  it('a normal viewer (not the broadcaster, not a listed bot) still earns', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws } = await setupEconomyChannel({ economy: makeEconomyRow({ earnEnabled: true, earnPerMessage: 5 }) });

    ws.emit(
      'notification',
      notificationFrame({
        chatter_user_id: 'viewer-42',
        chatter_user_login: 'a_regular_viewer',
        chatter_user_name: 'ARegularViewer',
        message: { text: 'hey everyone' },
      }),
    );
    await flush();

    expect(ledgerMocks.creditChannel).toHaveBeenCalledWith(
      expect.anything(),
      { economyId: 'economy-1', viewerUserId: 'viewer-42' },
      5,
      'twitch_chat_earn',
      { displayName: 'ARegularViewer' },
    );
  });

  it('credits nothing when earning is off, even though the currency itself is on', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws } = await setupEconomyChannel({ economy: makeEconomyRow({ enabled: true, earnEnabled: false }) });

    ws.emit('notification', notificationFrame({ message: { text: 'chatting away' } }));
    await flush();

    expect(ledgerMocks.creditChannel).not.toHaveBeenCalled();
  });

  it('credits nothing when the whole currency is switched off, even if earning is on', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws } = await setupEconomyChannel({ economy: makeEconomyRow({ enabled: false, earnEnabled: true }) });

    ws.emit('notification', notificationFrame({ message: { text: 'chatting away' } }));
    await flush();

    expect(ledgerMocks.creditChannel).not.toHaveBeenCalled();
    expect(mocks.getStream).not.toHaveBeenCalled();
  });

  it('credits nothing (and never asks Twitch if live) when the daily cap is 0', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws } = await setupEconomyChannel({ economy: makeEconomyRow({ earnEnabled: true, earnDailyCap: 0 }) });

    ws.emit('notification', notificationFrame({ message: { text: 'chatting away' } }));
    await flush();

    expect(ledgerMocks.creditChannel).not.toHaveBeenCalled();
    expect(mocks.getStream).not.toHaveBeenCalled();
  });

  it('credits a live, eligible, non-command chat message exactly once, silently (no chat reply)', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws, ctx } = await setupEconomyChannel({ economy: makeEconomyRow({ earnEnabled: true, earnPerMessage: 7 }) });

    ws.emit('notification', notificationFrame({ message: { text: 'gg well played' } }));
    await flush();

    expect(ledgerMocks.creditChannel).toHaveBeenCalledWith(expect.anything(), ECONOMY_KEY, 7, 'twitch_chat_earn', {
      displayName: 'ViewerOne',
    });
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    void ctx;
  });

  it("its cooldown and daily-budget Redis keys are scoped to the channel economy (not a guild)", async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws, ctx } = await setupEconomyChannel({ economy: makeEconomyRow({ earnEnabled: true, earnPerMessage: 5 }) });

    ws.emit('notification', notificationFrame({ message: { text: 'gg well played' } }));
    await flush();

    expect(await ctx.redis.get(earnCooldownKey('economy-1', 'viewer-1'))).toBe('1');
    expect(await ctx.redis.get(earnDailyBudgetKey('economy-1', 'viewer-1'))).toBe('5');
    // Nothing is written under the old guild-scoped names.
    expect(earnCooldownKey('economy-1', 'viewer-1')).not.toContain('guild-1');
    expect(await ctx.redis.keys('*guild-1*')).toEqual([]);
    expect(await ctx.redis.keys('*twitchearn*')).toEqual([]);
  });

  it('per-viewer earn cooldown (from the channel settings) blocks a second credit within the window', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws } = await setupEconomyChannel({ economy: makeEconomyRow({ earnEnabled: true, earnCooldownSeconds: 3600 }) });

    ws.emit('notification', notificationFrame({ message: { text: 'first message' } }));
    await flush();
    ws.emit('notification', notificationFrame({ message: { text: 'second message, still on cooldown' } }));
    await flush();

    expect(ledgerMocks.creditChannel).toHaveBeenCalledTimes(1);
  });

  it('liveness is cached: many messages across viewers in one minute cost exactly one getStream call', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { startedAt: new Date().toISOString() } }); // live
    const { ws, findEconomy } = await setupEconomyChannel({ economy: EARNING() });

    for (let i = 0; i < 5; i++) {
      ws.emit(
        'notification',
        notificationFrame({ chatter_user_id: `viewer-${i}`, chatter_user_name: `Viewer${i}`, message: { text: `message ${i}` } }),
      );
      await flush();
    }

    expect(mocks.getStream).toHaveBeenCalledTimes(1);
    expect(ledgerMocks.creditChannel).toHaveBeenCalledTimes(5);
    expect(findEconomy).toHaveBeenCalledTimes(1); // and the currency row is read once too, not per message
  });
});
