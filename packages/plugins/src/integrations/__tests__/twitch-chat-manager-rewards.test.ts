import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisKey } from '@pavisie/core';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { TwitchChatManager } from '../twitch-chat/manager';
import type { WebSocketConstructorLike, WebSocketLike } from '../twitch-chat/socket';

// Channel-point rewards runtime tests — separate file from `twitch-chat-manager.test.ts` so that suite (chat-only)
// stays focused, and so this file's mocks can cover the extra modules the rewards path touches
// (`broadcaster-token.ts`, `../embeds`, `./tts`) without bloating the chat-only mock set. Same `vi.hoisted`
// pattern/rationale as the sibling file: `vi.mock` factories are hoisted above every import, so any variable they
// close over must come from `vi.hoisted`.
const mocks = vi.hoisted(() => ({
  getBotIdentityRow: vi.fn(),
  createChatSubscription: vi.fn(),
  createRewardRedemptionSubscription: vi.fn(),
  deleteEventSubSubscription: vi.fn(),
  sendChatMessage: vi.fn(),
  getStream: vi.fn(),
  getChannelInfo: vi.fn(),
  pruneSendThrottle: vi.fn(),
  getBroadcasterAccessToken: vi.fn(),
  postAlert: vi.fn(),
  synthesizeTts: vi.fn(),
}));

vi.mock('../twitch-chat/helix', () => ({
  getBotIdentityRow: mocks.getBotIdentityRow,
  createChatSubscription: mocks.createChatSubscription,
  createRewardRedemptionSubscription: mocks.createRewardRedemptionSubscription,
  deleteEventSubSubscription: mocks.deleteEventSubSubscription,
  sendChatMessage: mocks.sendChatMessage,
  getStream: mocks.getStream,
  getChannelInfo: mocks.getChannelInfo,
  pruneSendThrottle: mocks.pruneSendThrottle,
}));
vi.mock('../twitch-chat/broadcaster-token', () => ({ getBroadcasterAccessToken: mocks.getBroadcasterAccessToken }));
vi.mock('../embeds', () => ({ postAlert: mocks.postAlert }));
vi.mock('../twitch-chat/tts', () => ({ synthesizeTts: mocks.synthesizeTts }));

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

async function flush(times = 60): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function makeEnv(overrides: Partial<{ TWITCH_CLIENT_ID: string; TWITCH_CLIENT_SECRET: string }> = {}) {
  return { TWITCH_CLIENT_ID: 'client-id', TWITCH_CLIENT_SECRET: 'client-secret', ...overrides } as unknown as PluginContext['env'];
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
    connectionId: 'connection-1',
    overlayTokenEnc: null,
    rewardsEnabled: false,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRewardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reward-1',
    channelId: 'channel-a',
    guildId: 'guild-1',
    rewardId: 'twitch-reward-1',
    rewardTitle: 'Hydrate!',
    enabled: true,
    action: 'CHAT',
    soundUrl: null,
    volume: 80,
    ttsTemplate: null,
    chatTemplate: 'Thanks {user}!',
    discordChannelId: null,
    discordTemplate: null,
    cooldownSeconds: 0,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function redemptionFrame(overrides: Record<string, unknown> = {}) {
  return {
    subscription: {
      id: 'sub-rewards-b-1',
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      status: 'enabled',
    },
    event: {
      broadcaster_user_id: 'b-1',
      user_name: 'ViewerOne',
      user_input: 'hello world',
      reward: { id: 'twitch-reward-1', title: 'Hydrate!' },
      ...overrides,
    },
  };
}

function welcomePayload(sessionId = 'sess-1') {
  return { session: { id: sessionId, status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.clearAllMocks();
  mocks.getBotIdentityRow.mockResolvedValue({ botUserId: 'bot-1', botLogin: 'pavisiebot' });
  mocks.createChatSubscription.mockImplementation(async (_ctx: unknown, _sessionId: string, broadcasterUserId: string) => ({
    ok: true,
    subscriptionId: `sub-chat-${broadcasterUserId}`,
  }));
  mocks.createRewardRedemptionSubscription.mockImplementation(
    async (_ctx: unknown, _sessionId: string, channel: { broadcasterUserId: string }) => ({
      ok: true,
      subscriptionId: `sub-rewards-${channel.broadcasterUserId}`,
    }),
  );
  mocks.deleteEventSubSubscription.mockResolvedValue(true);
  mocks.sendChatMessage.mockResolvedValue({ ok: true });
  mocks.getStream.mockResolvedValue({ ok: true, value: null });
  mocks.getChannelInfo.mockResolvedValue({ ok: true, value: null });
  mocks.getBroadcasterAccessToken.mockResolvedValue({ accessToken: 'broadcaster-token' });
  mocks.postAlert.mockResolvedValue(true);
  mocks.synthesizeTts.mockResolvedValue({ audioId: 'audio-1' });
});

describe('TwitchChatManager reconcile — reward subscriptions (independent of chat)', () => {
  it('creates a rewards subscription only when rewardsEnabled AND a broadcaster token is available', async () => {
    const channel = makeChannelRow({ rewardsEnabled: true });
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
        twitchChatReward: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', welcomePayload());
    await flush();

    expect(mocks.createChatSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.getBroadcasterAccessToken).toHaveBeenCalledWith(ctx, expect.objectContaining({ id: 'channel-a' }));
    expect(mocks.createRewardRedemptionSubscription).toHaveBeenCalledWith(
      ctx,
      'sess-1',
      expect.objectContaining({ id: 'channel-a' }),
    );
    // Both subscriptions live on the same channel id — connectedChannelIds() (chat-scoped) still reports it once.
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);
  });

  it('does not create a rewards subscription when rewardsEnabled is false, and never calls the broadcaster-token helper for it', async () => {
    const channel = makeChannelRow({ rewardsEnabled: false });
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
        twitchChatReward: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', welcomePayload());
    await flush();

    expect(mocks.createRewardRedemptionSubscription).not.toHaveBeenCalled();
    expect(mocks.getBroadcasterAccessToken).not.toHaveBeenCalled();
  });

  it('surfaces a clear, actionable lastError when rewardsEnabled but the broadcaster token/scope is missing — chat still connects', async () => {
    mocks.getBroadcasterAccessToken.mockResolvedValue(null);
    const channel = makeChannelRow({ rewardsEnabled: true });
    const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];

    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: {
          findMany: async () => [channel],
          update: async (args: unknown) => {
            updates.push(args as (typeof updates)[number]);
            return {};
          },
        },
        twitchChatCommand: { findMany: async () => [] },
        twitchChatReward: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', welcomePayload());
    await flush();

    expect(mocks.createRewardRedemptionSubscription).not.toHaveBeenCalled();
    // Chat is completely unaffected by the missing rewards scope.
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);
    const chatUpdate = updates.find((u) => u.data.status === 'CONNECTED');
    expect(chatUpdate).toBeDefined();

    const scopeErrorUpdate = updates.find(
      (u) => typeof u.data.lastError === 'string' && /re-link/i.test(u.data.lastError as string),
    );
    expect(scopeErrorUpdate).toBeDefined();
    expect(scopeErrorUpdate?.data.lastError).toMatch(/channel:read:redemptions/);
    // Never fails silently — status is never flipped to ERROR just for the missing rewards scope.
    expect(scopeErrorUpdate?.data.status).toBeUndefined();
  });

  it('disabling rewards deletes only the rewards subscription — chat stays connected', async () => {
    let channel = makeChannelRow({ rewardsEnabled: true });
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
        twitchChatReward: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', welcomePayload());
    await flush();
    expect(mocks.createRewardRedemptionSubscription).toHaveBeenCalledTimes(1);

    channel = makeChannelRow({ rewardsEnabled: false }); // owner flips rewards off
    await manager.reconcile(ctx);

    expect(mocks.deleteEventSubSubscription).toHaveBeenCalledWith(ctx, 'sub-rewards-b-1');
    expect(mocks.deleteEventSubSubscription).not.toHaveBeenCalledWith(ctx, 'sub-chat-b-1');
    expect(manager.connectedChannelIds()).toEqual(['channel-a']); // chat untouched
  });

  it('a scope revoked AFTER the subscription exists is caught on the next tick — not silently ignored', async () => {
    // Regression guard. The broadcaster can revoke `channel:read:redemptions` on Twitch's site at any time,
    // long after we subscribed. An earlier version short-circuited on "already subscribed" before re-checking
    // the token, so the revocation surfaced nowhere: redemptions quietly stopped firing while the dashboard
    // and /twitch status still looked healthy. The token check must run BEFORE that short-circuit.
    const channel = makeChannelRow({ rewardsEnabled: true });
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: {
          findMany: async () => [channel],
          update: async (args: unknown) => {
            updates.push(args as (typeof updates)[number]);
            return {};
          },
        },
        twitchChatCommand: { findMany: async () => [] },
        twitchChatReward: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', welcomePayload());
    await flush();
    expect(mocks.createRewardRedemptionSubscription).toHaveBeenCalledTimes(1);

    // The broadcaster revokes the scope: the token helper now returns null for this channel.
    mocks.getBroadcasterAccessToken.mockResolvedValue(null);
    updates.length = 0;
    await manager.reconcile(ctx);

    // The now-dead subscription is torn down at Twitch and forgotten locally...
    expect(mocks.deleteEventSubSubscription).toHaveBeenCalledWith(ctx, 'sub-rewards-b-1');
    // ...the admin is told why, in the same actionable wording as a never-granted scope...
    const scopeError = updates.find((u) => typeof u.data.lastError === 'string');
    expect(scopeError?.data.lastError).toMatch(/channel:read:redemptions/);
    // ...and chat is left completely alone.
    expect(mocks.deleteEventSubSubscription).not.toHaveBeenCalledWith(ctx, 'sub-chat-b-1');
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);
  });

  it('removing the channel entirely tears down BOTH subscriptions', async () => {
    let channels: unknown[] = [makeChannelRow({ rewardsEnabled: true })];
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => channels, update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
        twitchChatReward: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', welcomePayload());
    await flush();
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);

    channels = []; // unlinked/disabled/guild disabled
    await manager.reconcile(ctx);

    expect(mocks.deleteEventSubSubscription).toHaveBeenCalledWith(ctx, 'sub-chat-b-1');
    expect(mocks.deleteEventSubSubscription).toHaveBeenCalledWith(ctx, 'sub-rewards-b-1');
    expect(manager.connectedChannelIds()).toEqual([]);
  });

  it('a rewards-subscription revocation sets lastError WITHOUT flipping status to ERROR, and leaves chat connected', async () => {
    const channel = makeChannelRow({ rewardsEnabled: true });
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
        twitchChatReward: { findMany: async () => [] },
      },
    });

    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', welcomePayload());
    await flush();
    updates.length = 0; // ignore the create-time updates; only care about the post-revocation one

    ws.emit('revocation', {
      subscription: {
        id: 'sub-rewards-b-1',
        type: 'channel.channel_points_custom_reward_redemption.add',
        status: 'authorization_revoked',
      },
    });
    await flush();

    expect(manager.connectedChannelIds()).toEqual(['channel-a']); // chat subscription untouched
    const revocationUpdate = updates.find((u) => typeof u.lastError === 'string' && /revoked/i.test(u.lastError as string));
    expect(revocationUpdate).toBeDefined();
    expect(revocationUpdate?.status).toBeUndefined();
  });
});

describe('TwitchChatManager reward redemption dispatch', () => {
  async function setupChannelWithRewards(rewards: unknown[]) {
    const channel = makeChannelRow({ rewardsEnabled: true });
    const manager = new TwitchChatManager(FakeWebSocketCtor);
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
        twitchChatCommand: { findMany: async () => [] },
        twitchChatReward: { findMany: async () => rewards },
      },
    });
    await manager.start(ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit('session_welcome', welcomePayload());
    await flush();
    return { manager, ctx, ws };
  }

  it('CHAT action sends the templated text via sendChatMessage', async () => {
    const { ws, ctx } = await setupChannelWithRewards([makeRewardRow({ action: 'CHAT', chatTemplate: 'Thanks {user} for {reward}!' })]);

    ws.emit('notification', redemptionFrame());
    await flush();

    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', 'Thanks ViewerOne for Hydrate!!');
  });

  it('DISCORD action posts via postAlert to the configured Discord channel', async () => {
    const { ws, ctx } = await setupChannelWithRewards([
      makeRewardRow({ action: 'DISCORD', discordChannelId: 'discord-chan-1', discordTemplate: '{user} redeemed {reward}: {input}' }),
    ]);

    ws.emit('notification', redemptionFrame());
    await flush();

    expect(mocks.postAlert).toHaveBeenCalledWith(
      ctx,
      { guildId: 'guild-1', channelId: 'discord-chan-1' },
      expect.objectContaining({ description: 'ViewerOne redeemed Hydrate!: hello world' }),
    );
  });

  it('SOUND action publishes the fixed overlay payload shape over Redis pub/sub', async () => {
    const { ws, ctx } = await setupChannelWithRewards([
      makeRewardRow({ action: 'SOUND', soundUrl: 'https://example.com/sound.mp3', volume: 55 }),
    ]);
    const publishSpy = vi.spyOn(ctx.redis, 'publish');

    ws.emit('notification', redemptionFrame());
    await flush();

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [channelArg, payloadArg] = publishSpy.mock.calls[0] as [string, string];
    expect(channelArg).toBe(redisKey('overlay', 'channel-a'));
    const payload = JSON.parse(payloadArg) as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: 'sound', url: 'https://example.com/sound.mp3', volume: 55 });
    expect(typeof payload.id).toBe('string');
  });

  it('TTS action synthesizes then publishes the fixed overlay payload shape (audioId, not raw text)', async () => {
    mocks.synthesizeTts.mockResolvedValue({ audioId: 'audio-xyz' });
    const { ws, ctx } = await setupChannelWithRewards([
      makeRewardRow({ action: 'TTS', ttsTemplate: 'Say hi to {user}', volume: 40 }),
    ]);
    const publishSpy = vi.spyOn(ctx.redis, 'publish');

    ws.emit('notification', redemptionFrame());
    await flush();

    // channelId is passed so the synthesized audio lands under a channel-scoped Redis key — that scope is
    // what stops another channel's valid overlay token from fetching this audio.
    expect(mocks.synthesizeTts).toHaveBeenCalledWith(ctx, 'guild-1', 'channel-a', 'Say hi to ViewerOne');
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [channelArg, payloadArg] = publishSpy.mock.calls[0] as [string, string];
    expect(channelArg).toBe(redisKey('overlay', 'channel-a'));
    const payload = JSON.parse(payloadArg) as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: 'tts', audioId: 'audio-xyz', volume: 40 });
    expect(payload).not.toHaveProperty('text');
  });

  it('TTS unavailable (no provider/key) skips the action honestly — no publish, no crash', async () => {
    mocks.synthesizeTts.mockResolvedValue(null);
    const { ws, ctx } = await setupChannelWithRewards([makeRewardRow({ action: 'TTS', ttsTemplate: 'Say hi to {user}' })]);
    const publishSpy = vi.spyOn(ctx.redis, 'publish');

    ws.emit('notification', redemptionFrame());
    await flush();

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('a thrown error in one reward action never kills the manager — a later chat message still works', async () => {
    mocks.sendChatMessage.mockRejectedValueOnce(new Error('Helix is down'));
    const { ws } = await setupChannelWithRewards([makeRewardRow({ action: 'CHAT', chatTemplate: 'Thanks {user}!' })]);

    ws.emit('notification', redemptionFrame());
    await flush();

    ws.emit('notification', redemptionFrame({ user_name: 'ViewerTwo' }));
    await flush();

    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(2);
  });

  describe('privacy: viewer input and display name never reach the logger', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('is upheld across CHAT/DISCORD/SOUND/TTS-unavailable dispatch, including on a dispatch failure', async () => {
      const SECRET_INPUT = 'SECRET_INPUT_zzz_should_never_be_logged';
      const SECRET_NAME = 'SECRET_NAME_qqq_should_never_be_logged';
      const logger = makeLogger();
      mocks.postAlert.mockRejectedValueOnce(new Error('discord post failed')); // force at least one error-path log
      mocks.synthesizeTts.mockResolvedValue(null); // force the TTS-unavailable warn-path log

      const channel = makeChannelRow({ rewardsEnabled: true });
      const rewards = [
        makeRewardRow({ id: 'r-chat', action: 'CHAT', chatTemplate: 'Thanks {user}: {input}' }),
        makeRewardRow({ id: 'r-discord', action: 'DISCORD', discordChannelId: 'discord-chan-1', discordTemplate: '{user}: {input}' }),
        makeRewardRow({ id: 'r-sound', action: 'SOUND', soundUrl: 'https://example.com/s.mp3' }),
        makeRewardRow({ id: 'r-tts', action: 'TTS', ttsTemplate: '{user} says {input}' }),
      ];

      const manager = new TwitchChatManager(FakeWebSocketCtor);
      const { ctx } = createTestContext({
        overrides: { env: makeEnv(), logger },
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [channel], update: async () => ({}) },
          twitchChatCommand: { findMany: async () => [] },
          twitchChatReward: { findMany: async () => rewards },
        },
      });
      await manager.start(ctx);
      const ws = FakeWebSocket.instances[0];
      ws.emit('session_welcome', welcomePayload());
      await flush();

      ws.emit('notification', redemptionFrame({ user_name: SECRET_NAME, user_input: SECRET_INPUT }));
      await flush();

      const loggerMock = logger as unknown as Record<'warn' | 'error' | 'debug' | 'info', ReturnType<typeof vi.fn>>;
      const allLoggedText = (['warn', 'error', 'debug', 'info'] as const)
        .flatMap((level) => loggerMock[level].mock.calls)
        .map((call) => JSON.stringify(call))
        .join('\n');

      expect(allLoggedText).not.toContain(SECRET_INPUT);
      expect(allLoggedText).not.toContain(SECRET_NAME);
      // Sanity check the test actually exercised at least one log call (else the assertions above are vacuous).
      const totalCalls = (['warn', 'error', 'debug', 'info'] as const).reduce(
        (sum, level) => sum + loggerMock[level].mock.calls.length,
        0,
      );
      expect(totalCalls).toBeGreaterThan(0);
    });
  });
});
