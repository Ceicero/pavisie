import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { TwitchChatManager } from '../twitch-chat/manager';
import type { WebSocketConstructorLike, WebSocketLike } from '../twitch-chat/socket';

// On a deploy the bot can boot before the api's pre-deploy migration has finished, so the manager's very first
// database read fails ("column does not exist"). It must keep retrying on a capped backoff (5s -> 60s) instead of
// staying dead until a manual restart, and the minute reconcile tick must recover it independently.
const mocks = vi.hoisted(() => ({
  getBotIdentityRow: vi.fn(),
  createChatSubscription: vi.fn(),
  deleteEventSubSubscription: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock('../twitch-chat/helix', () => ({
  getBotIdentityRow: mocks.getBotIdentityRow,
  createChatSubscription: mocks.createChatSubscription,
  createRewardRedemptionSubscription: vi.fn(),
  deleteEventSubSubscription: mocks.deleteEventSubSubscription,
  sendChatMessage: mocks.sendChatMessage,
  getStream: vi.fn(),
  getChannelInfo: vi.fn(),
  getUserByLogin: vi.fn(),
  pruneSendThrottle: vi.fn(),
}));
vi.mock('../twitch-chat/broadcaster-token', () => ({ getBroadcasterAccessToken: vi.fn() }));
vi.mock('../embeds', () => ({ postAlert: vi.fn() }));

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readyState = 1;
  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  close(): void {}
}
const FakeWebSocketCtor = FakeWebSocket as unknown as WebSocketConstructorLike;

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() };
}

function channelRow() {
  return {
    id: 'channel-a',
    guildId: null,
    broadcasterUserId: 'b-1',
    broadcasterLogin: 'somestreamer',
    enabled: true,
    rewardsEnabled: false,
  };
}

function build(findMany: () => Promise<unknown[]>) {
  const logger = makeLogger();
  const { ctx } = createTestContext({
    overrides: {
      env: { TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: 'secret' } as unknown as PluginContext['env'],
      logger: logger as unknown as PluginContext['logger'],
    },
    prismaOverrides: { twitchChatChannel: { findMany } },
  });
  return { ctx, logger, manager: new TwitchChatManager(FakeWebSocketCtor) };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.clearAllMocks();
  mocks.getBotIdentityRow.mockResolvedValue({ botUserId: 'bot-1', botLogin: 'pavisiebot' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TwitchChatManager startup retry', () => {
  it('retries a failing startup with a capped 5s -> 60s backoff and connects once the database is ready', async () => {
    let failures = 7;
    const { ctx, logger, manager } = build(async () => {
      if (failures-- > 0) throw new Error('The column `guildId` does not exist in the current database.');
      return [channelRow()];
    });

    await expect(manager.start(ctx)).resolves.toBeUndefined(); // never throws
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatchObject({ retryInMs: 5000 });

    // 5s, 10s, 20s, 40s, 60s, 60s, 60s: the delay doubles and is capped at 60s.
    const delays = [5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000];
    for (const [i, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      if (i < delays.length - 1) {
        expect(logger.error.mock.calls[i + 1][0]).toMatchObject({ retryInMs: Math.min(delay * 2, 60_000) });
      }
    }

    // The 7th retry succeeded: a socket was opened and no further startup retry is pending.
    expect(FakeWebSocket.instances).toHaveLength(1);
    const startFailures = () =>
      logger.error.mock.calls.filter((c) => String(c[1]).includes('failed to start')).length;
    const failuresAfterRecovery = startFailures();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(startFailures()).toBe(failuresAfterRecovery);
    await manager.stop();
  });

  it('a bot-identity lookup that throws is retried too (it is not mistaken for "owner setup pending")', async () => {
    mocks.getBotIdentityRow.mockRejectedValueOnce(new Error('relation "TwitchBotIdentity" does not exist'));
    const { ctx, logger, manager } = build(async () => [channelRow()]);

    await manager.start(ctx);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await manager.stop();
  });

  it('the periodic reconcile also recovers a manager whose startup failed', async () => {
    let ready = false;
    const { ctx, manager } = build(async () => {
      if (!ready) throw new Error('column does not exist');
      return [channelRow()];
    });

    await manager.start(ctx);
    expect(FakeWebSocket.instances).toHaveLength(0);

    // Migration finished; the minute tick (reconcile) fires before the 5s..60s retry timer would have.
    ready = true;
    await manager.reconcile(ctx);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // The still-pending startup timer fires now and must not open a second socket.
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await manager.stop();
  });

  it('a reconcile that throws while the database is still down is contained and logged', async () => {
    const { ctx, logger, manager } = build(async () => {
      throw new Error('column does not exist');
    });
    await manager.start(ctx);
    await expect(manager.reconcile(ctx)).resolves.toBeUndefined();
    expect(logger.error.mock.calls.length).toBeGreaterThanOrEqual(2);
    await manager.stop();
  });

  it('stop() cancels a pending startup retry', async () => {
    const { ctx, logger, manager } = build(async () => {
      throw new Error('column does not exist');
    });
    await manager.start(ctx);
    await manager.stop();
    const errors = logger.error.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(logger.error).toHaveBeenCalledTimes(errors);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('a clean idle startup (nothing linked yet) schedules no retry', async () => {
    const { ctx, logger, manager } = build(async () => []);
    await manager.start(ctx);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(logger.error).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    await manager.stop();
  });
});
