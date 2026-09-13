import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { TwitchChatManager } from '../twitch-chat/manager';
import type { WebSocketConstructorLike, WebSocketLike } from '../twitch-chat/socket';

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
  pruneSendThrottle: vi.fn(),
}));

vi.mock('../twitch-chat/helix', () => mocks);

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
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
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
