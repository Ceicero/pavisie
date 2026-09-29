import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { createTestContext } from '../../sdk/testing';
import type { EconomyGetConfigResult, EconomyService, PluginContext } from '../../sdk';
import { TwitchChatManager } from '../twitch-chat/manager';
import { fireDueTimers } from '../twitch-chat/timers';
import type { WebSocketConstructorLike, WebSocketLike } from '../twitch-chat/socket';

// Guildless Twitch chat channels (`TwitchChatChannel.guildId === null`, set up from the creator dashboard —
// ARCHITECTURE.md §19e) run on their own `enabled` flag alone. Custom commands, timers and the built-ins work;
// everything that needs a Discord server (economy commands/earning, the Discord bridge, DISCORD/TTS reward
// actions) is quietly unavailable — never a crash, never an error message into Twitch chat. Guild-linked
// channels are exercised alongside as a control so "unchanged" is asserted, not assumed. Same `vi.hoisted`/
// FakeWebSocket harness as `twitch-chat-manager.test.ts` / `twitch-chat-manager-rewards.test.ts`.
const mocks = vi.hoisted(() => ({
  getBotIdentityRow: vi.fn(),
  createChatSubscription: vi.fn(),
  createRewardRedemptionSubscription: vi.fn(),
  deleteEventSubSubscription: vi.fn(),
  sendChatMessage: vi.fn(),
  getStream: vi.fn(),
  getChannelInfo: vi.fn(),
  getUserByLogin: vi.fn(),
  pruneSendThrottle: vi.fn(),
  getBroadcasterAccessToken: vi.fn(),
  postAlert: vi.fn(),
  synthesizeTts: vi.fn(),
  checkBridgeChannelAccess: vi.fn(),
  ensureBridgeWebhook: vi.fn(),
  clearBridgeWebhook: vi.fn(),
  webhookCtor: vi.fn(),
}));

vi.mock('../twitch-chat/helix', () => ({
  getBotIdentityRow: mocks.getBotIdentityRow,
  createChatSubscription: mocks.createChatSubscription,
  createRewardRedemptionSubscription: mocks.createRewardRedemptionSubscription,
  deleteEventSubSubscription: mocks.deleteEventSubSubscription,
  sendChatMessage: mocks.sendChatMessage,
  getStream: mocks.getStream,
  getChannelInfo: mocks.getChannelInfo,
  getUserByLogin: mocks.getUserByLogin,
  pruneSendThrottle: mocks.pruneSendThrottle,
}));
vi.mock('../twitch-chat/broadcaster-token', () => ({ getBroadcasterAccessToken: mocks.getBroadcasterAccessToken }));
vi.mock('../embeds', () => ({ postAlert: mocks.postAlert }));
vi.mock('../twitch-chat/tts', () => ({ synthesizeTts: mocks.synthesizeTts }));
vi.mock('../twitch-chat/bridge-webhook', () => ({
  checkBridgeChannelAccess: mocks.checkBridgeChannelAccess,
  ensureBridgeWebhook: mocks.ensureBridgeWebhook,
  clearBridgeWebhook: mocks.clearBridgeWebhook,
  UNKNOWN_WEBHOOK_ERROR_CODE: 10015,
}));
vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  return {
    ...actual,
    WebhookClient: class {
      constructor(opts: unknown) {
        mocks.webhookCtor(opts);
      }
      send() {
        return Promise.resolve({});
      }
    },
  };
});

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

function makeEnv() {
  return { TWITCH_CLIENT_ID: 'client-id', TWITCH_CLIENT_SECRET: 'client-secret' } as unknown as PluginContext['env'];
}

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() };
}

function makeChannelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'channel-a',
    guildId: null,
    broadcasterUserId: 'b-1',
    broadcasterLogin: 'somestreamer',
    enabled: true,
    status: 'PENDING',
    lastError: null,
    lastConnectedAt: null,
    commandPrefix: '!',
    connectionId: null,
    overlayTokenEnc: null,
    rewardsEnabled: false,
    bridgeDiscordChannelId: null,
    bridgeDiscordToTwitch: false,
    bridgeTwitchToDiscord: false,
    bridgeWebhookId: null,
    bridgeWebhookTokenEnc: null,
    bridgeLastError: null,
    createdBy: 'creator-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCommandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'command-1',
    channelId: 'channel-a',
    guildId: null,
    name: 'hello',
    response: 'Hi {user}!',
    cooldownSeconds: 5,
    minLevel: 'EVERYONE',
    enabled: true,
    createdBy: 'creator-1',
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
    createdBy: 'creator-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function chatFrame(text: string) {
  return {
    subscription: { id: 'sub-b-1', type: 'channel.chat.message', version: '1', status: 'enabled' },
    event: {
      broadcaster_user_id: 'b-1',
      chatter_user_id: 'viewer-1',
      chatter_user_login: 'viewerone',
      chatter_user_name: 'ViewerOne',
      message: { text },
      badges: [],
    },
  };
}

function redemptionFrame() {
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
      user_input: '',
      reward: { id: 'twitch-reward-1', title: 'Hydrate!' },
    },
  };
}

function makeEconomyService(): EconomyService {
  const config: EconomyGetConfigResult = {
    currencyName: 'Agis',
    currencySymbol: 'A',
    twitchEnabled: true,
    twitchEarnEnabled: true,
    twitchEarnPerMessage: 5,
    twitchEarnCooldownSeconds: 60,
    twitchEarnDailyCap: 200,
  };
  return {
    getConfig: vi.fn(async () => config),
    getOrCreateWallet: vi.fn(async () => ({ balance: 100n, lastDailyAt: null })),
    claimDaily: vi.fn(async () => ({ ok: true as const, amount: 10n, streak: 1 })),
    give: vi.fn(async () => ({ ok: true as const })),
    credit: vi.fn(async () => ({ ok: true as const, newBalance: 0n })),
    getLeaderboard: vi.fn(async () => []),
  } as unknown as EconomyService;
}

interface SetupOptions {
  channels?: Record<string, unknown>[];
  commands?: Record<string, unknown>[];
  rewards?: Record<string, unknown>[];
  isEnabled?: PluginContext['isEnabled'];
  economyService?: EconomyService;
  logger?: ReturnType<typeof makeLogger>;
}

async function setup(opts: SetupOptions = {}) {
  const channels = opts.channels ?? [makeChannelRow()];
  const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
  const isEnabled = vi.fn(opts.isEnabled ?? (async () => true));
  const logger = opts.logger ?? makeLogger();
  const manager = new TwitchChatManager(FakeWebSocketCtor);
  const { ctx } = createTestContext({
    overrides: { env: makeEnv(), isEnabled, logger: logger as unknown as PluginContext['logger'] },
    prismaOverrides: {
      twitchChatChannel: {
        findMany: async () => channels,
        findUnique: async () => channels[0] ?? null,
        update: async (args: unknown) => {
          updates.push(args as (typeof updates)[number]);
          return {};
        },
      },
      twitchChatCommand: { findMany: async () => opts.commands ?? [] },
      twitchChatReward: { findMany: async () => opts.rewards ?? [] },
    },
  });
  if (opts.economyService) ctx.services.register('economy', opts.economyService);

  await manager.start(ctx);
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws?.emit('session_welcome', {
    session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null },
  });
  await flush();
  return { manager, ctx, ws, updates, isEnabled, logger };
}

beforeEach(async () => {
  await new RedisMock().flushall();
  FakeWebSocket.instances = [];
  vi.clearAllMocks();
  mocks.getBotIdentityRow.mockResolvedValue({ botUserId: 'bot-1', botLogin: 'pavisiebot' });
  mocks.createChatSubscription.mockImplementation(async (_ctx: unknown, _sid: string, broadcasterUserId: string) => ({
    ok: true,
    subscriptionId: `sub-chat-${broadcasterUserId}`,
  }));
  mocks.createRewardRedemptionSubscription.mockImplementation(
    async (_ctx: unknown, _sid: string, channel: { broadcasterUserId: string }) => ({
      ok: true,
      subscriptionId: `sub-rewards-${channel.broadcasterUserId}`,
    }),
  );
  mocks.deleteEventSubSubscription.mockResolvedValue(true);
  mocks.sendChatMessage.mockResolvedValue({ ok: true });
  mocks.getStream.mockResolvedValue({ ok: true, value: null });
  mocks.getChannelInfo.mockResolvedValue({ ok: true, value: null });
  mocks.getUserByLogin.mockResolvedValue({ ok: true, value: null });
  mocks.getBroadcasterAccessToken.mockResolvedValue({ accessToken: 'broadcaster-token' });
  mocks.postAlert.mockResolvedValue(true);
  mocks.synthesizeTts.mockResolvedValue({ audioId: 'audio-1' });
  mocks.checkBridgeChannelAccess.mockResolvedValue({ ok: true });
  mocks.ensureBridgeWebhook.mockResolvedValue({ ok: true, client: { send: vi.fn() } });
  mocks.clearBridgeWebhook.mockResolvedValue(undefined);
});

describe('guildless channel: reconcile runs on its own `enabled` flag', () => {
  it('subscribes a guildless channel even though no guild could ever have "integrations" enabled for it', async () => {
    const { manager, updates, isEnabled } = await setup({
      isEnabled: async () => false, // every guild-scoped enablement check says "off"
    });

    expect(mocks.createChatSubscription).toHaveBeenCalledWith(expect.anything(), 'sess-1', 'b-1');
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);
    expect(updates.some((u) => u.where.id === 'channel-a' && u.data.status === 'CONNECTED')).toBe(true);
    // No guild, so `ctx.isEnabled` is never consulted for it (and never with a null guild id).
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it('guild-linked channels are gated exactly as before, alongside a guildless one', async () => {
    const { manager, isEnabled } = await setup({
      channels: [
        makeChannelRow({ id: 'guildless', guildId: null, broadcasterUserId: 'b-1' }),
        makeChannelRow({ id: 'linked-on', guildId: 'guild-on', broadcasterUserId: 'b-2' }),
        makeChannelRow({ id: 'linked-off', guildId: 'guild-off', broadcasterUserId: 'b-3' }),
      ],
      isEnabled: async (guildId: string) => guildId === 'guild-on',
    });

    expect(manager.connectedChannelIds().sort()).toEqual(['guildless', 'linked-on']);
    expect(isEnabled).toHaveBeenCalledWith('guild-on');
    expect(isEnabled).toHaveBeenCalledWith('guild-off');
    expect(isEnabled).not.toHaveBeenCalledWith(null);
  });
});

describe('guildless channel: what works', () => {
  it('answers a custom command and the built-in !commands', async () => {
    const { ws } = await setup({ commands: [makeCommandRow()] });

    ws.emit('notification', chatFrame('!hello'));
    await flush();
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(expect.anything(), 'b-1', 'Hi ViewerOne!');

    mocks.sendChatMessage.mockClear();
    ws.emit('notification', chatFrame('!commands'));
    await flush();
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendChatMessage.mock.calls[0][2]).toContain('hello');
  });

  it('fires due timers into a guildless channel', async () => {
    const { manager, ctx } = await setup();
    const timerCtx = createTestContext({
      prismaOverrides: {
        twitchChatTimer: {
          findMany: async () => [
            {
              id: 'timer-1',
              channelId: 'channel-a',
              guildId: null,
              name: 'socials',
              message: 'Follow the stream!',
              intervalMinutes: 30,
              enabled: true,
              lastFiredAt: null,
              createdBy: 'creator-1',
              createdAt: new Date(),
              updatedAt: new Date(),
              channel: makeChannelRow(),
            },
          ],
          update: async () => ({}),
        },
      },
    }).ctx;

    expect(manager.connectedChannelIds()).toEqual(['channel-a']);
    await fireDueTimers(timerCtx, manager);
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(timerCtx, 'b-1', 'Follow the stream!');
    expect(ctx).toBeDefined();
  });
});

describe('guildless channel: Discord-dependent features are skipped cleanly', () => {
  it('economy commands are unavailable: no economy call, no reply, no error, no crash', async () => {
    const economyService = makeEconomyService();
    const logger = makeLogger();
    const { ws, isEnabled } = await setup({ economyService, logger });

    for (const text of ['!balance', '!bal', '!daily', '!give someone 5', '!top']) {
      ws.emit('notification', chatFrame(text));
      await flush();
    }

    expect(economyService.getConfig).not.toHaveBeenCalled();
    expect(economyService.getOrCreateWallet).not.toHaveBeenCalled();
    expect(economyService.claimDaily).not.toHaveBeenCalled();
    expect(economyService.give).not.toHaveBeenCalled();
    expect(economyService.getLeaderboard).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalledWith(null, 'economy');
    // Nothing is said in chat (not even an error), and nothing was logged as an error.
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('economy chat earning never credits a guildless channel\'s viewers', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { title: 'live' } });
    const economyService = makeEconomyService();
    const logger = makeLogger();
    const { ws } = await setup({ economyService, logger });

    ws.emit('notification', chatFrame('just chatting'));
    await flush();

    expect(economyService.getConfig).not.toHaveBeenCalled();
    expect(economyService.credit).not.toHaveBeenCalled();
    expect(mocks.getStream).not.toHaveBeenCalled(); // never even asked whether the channel is live
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('the Discord bridge never runs, even if the row carries stray bridge settings', async () => {
    const { ws, manager } = await setup({
      channels: [
        makeChannelRow({
          bridgeDiscordChannelId: '123456789012345678',
          bridgeDiscordToTwitch: true,
          bridgeTwitchToDiscord: true,
          bridgeWebhookId: 'wh-1',
          bridgeWebhookTokenEnc: 'enc:secret',
        }),
      ],
    });

    ws.emit('notification', chatFrame('hello discord'));
    await flush();

    expect(mocks.checkBridgeChannelAccess).not.toHaveBeenCalled();
    expect(mocks.ensureBridgeWebhook).not.toHaveBeenCalled();
    expect(mocks.webhookCtor).not.toHaveBeenCalled(); // no Twitch -> Discord relay client was built
    expect(mocks.sendChatMessage).not.toHaveBeenCalled(); // and no "now bridged" announcement into Twitch chat
    expect(manager.connectedChannelIds()).toEqual(['channel-a']);
  });

  it('DISCORD and TTS reward actions are skipped; CHAT still works; nothing errors', async () => {
    const logger = makeLogger();
    const { ws } = await setup({
      channels: [makeChannelRow({ rewardsEnabled: true })],
      rewards: [
        makeRewardRow({ id: 'r-discord', action: 'DISCORD', chatTemplate: null, discordChannelId: '123456789012345678', discordTemplate: 'x' }),
        makeRewardRow({ id: 'r-tts', action: 'TTS', chatTemplate: null, ttsTemplate: 'say {user}' }),
        makeRewardRow({ id: 'r-chat', action: 'CHAT' }),
      ],
      logger,
    });

    ws.emit('notification', redemptionFrame());
    await flush();

    expect(mocks.postAlert).not.toHaveBeenCalled();
    expect(mocks.synthesizeTts).not.toHaveBeenCalled();
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(expect.anything(), 'b-1', 'Thanks ViewerOne!');
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('guild-linked channel: behaviour unchanged (control)', () => {
  it('still routes !balance to the economy service and posts DISCORD reward actions', async () => {
    const economyService = makeEconomyService();
    const { ws } = await setup({
      channels: [makeChannelRow({ guildId: 'guild-1', rewardsEnabled: true, connectionId: 'conn-1' })],
      economyService,
      rewards: [
        makeRewardRow({ id: 'r-discord', action: 'DISCORD', chatTemplate: null, discordChannelId: '123456789012345678', discordTemplate: 'x' }),
      ],
    });

    ws.emit('notification', chatFrame('!balance'));
    await flush();
    expect(economyService.getOrCreateWallet).toHaveBeenCalledWith('guild-1', 'TWITCH', 'viewer-1', 'ViewerOne');

    ws.emit('notification', redemptionFrame());
    await flush();
    expect(mocks.postAlert).toHaveBeenCalledTimes(1);
  });
});
