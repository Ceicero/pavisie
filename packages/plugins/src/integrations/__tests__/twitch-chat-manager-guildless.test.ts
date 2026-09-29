import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { TwitchChatManager } from '../twitch-chat/manager';
import { fireDueTimers } from '../twitch-chat/timers';
import type { WebSocketConstructorLike, WebSocketLike } from '../twitch-chat/socket';

// Guildless Twitch chat channels (`TwitchChatChannel.guildId === null`, set up from the creator dashboard —
// ARCHITECTURE.md §19e) run on their own `enabled` flag alone. Custom commands, timers, the built-ins AND the
// channel's own currency (`ChannelEconomy`: economy commands + chat earning, §18b) work; everything that needs a
// Discord server (the Discord bridge, DISCORD/TTS reward actions) is quietly unavailable — never a crash, never an
// error message into Twitch chat. Guild-linked
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

// The channel-economy ledger is mocked so these tests assert WHICH ledger call the manager makes for a guildless
// channel (its own unit tests live in `channel-economy/__tests__`). Same hoisting rationale as `mocks` above.
const ledgerMocks = vi.hoisted(() => ({
  getOrCreateChannelWallet: vi.fn(),
  claimChannelDaily: vi.fn(),
  giveChannel: vi.fn(),
  creditChannel: vi.fn(),
  getChannelEarnedLeaderboard: vi.fn(),
}));
vi.mock('../../channel-economy/ledger', () => ledgerMocks);

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
    ttsOpenAiKeyEnc: null,
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
    guildId: null,
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

/** A `ChannelEconomy` row — the channel's own currency, independent of any Discord server. */
function makeEconomyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'economy-1',
    platform: 'TWITCH',
    channelUserId: 'b-1',
    enabled: true,
    currencyName: 'Agis',
    currencySymbol: 'A',
    dailyMinAmount: 50,
    dailyMaxAmount: 150,
    streakBonusPerDay: 10,
    streakBonusMax: 200,
    giveMinAmount: 1,
    giveMaxAmount: 100000,
    earnEnabled: true,
    earnPerMessage: 5,
    earnCooldownSeconds: 60,
    earnDailyCap: 200,
    ...overrides,
  };
}

interface SetupOptions {
  channels?: Record<string, unknown>[];
  commands?: Record<string, unknown>[];
  rewards?: Record<string, unknown>[];
  isEnabled?: PluginContext['isEnabled'];
  /** The channel's `ChannelEconomy` row; omit for "the channel has no currency". */
  economy?: Record<string, unknown> | null;
  logger?: ReturnType<typeof makeLogger>;
  /** A fake discord.js client, for the tests that reach the bridge reconcile's guild lookup. */
  client?: unknown;
}

async function setup(opts: SetupOptions = {}) {
  const channels = opts.channels ?? [makeChannelRow()];
  const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
  const isEnabled = vi.fn(opts.isEnabled ?? (async () => true));
  const logger = opts.logger ?? makeLogger();
  const manager = new TwitchChatManager(FakeWebSocketCtor);
  const { ctx } = createTestContext({
    overrides: {
      env: makeEnv(),
      isEnabled,
      logger: logger as unknown as PluginContext['logger'],
      ...(opts.client ? { client: opts.client as PluginContext['client'] } : {}),
    },
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
      channelEconomy: { findUnique: async () => opts.economy ?? null },
    },
  });

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
  ledgerMocks.getOrCreateChannelWallet.mockResolvedValue({ balance: 100n });
  ledgerMocks.claimChannelDaily.mockResolvedValue({ ok: true, amount: 10n, streak: 1 });
  ledgerMocks.giveChannel.mockResolvedValue({ ok: true });
  ledgerMocks.creditChannel.mockResolvedValue({ ok: true, newBalance: 0n });
  ledgerMocks.getChannelEarnedLeaderboard.mockResolvedValue([]);
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

  it('guild-linked channels are NOT gated on the integrations plugin of their server any more (the chat bot belongs to the streamer)', async () => {
    const { manager, isEnabled } = await setup({
      channels: [
        makeChannelRow({ id: 'guildless', guildId: null, broadcasterUserId: 'b-1' }),
        makeChannelRow({ id: 'linked-on', guildId: 'guild-on', broadcasterUserId: 'b-2' }),
        makeChannelRow({ id: 'linked-off', guildId: 'guild-off', broadcasterUserId: 'b-3' }),
      ],
      isEnabled: async (guildId: string) => guildId === 'guild-on',
    });

    expect(manager.connectedChannelIds().sort()).toEqual(['guildless', 'linked-off', 'linked-on']);
    // The reconcile never consults the plugin state to decide who runs; only the Discord-side features do.
    expect(isEnabled).not.toHaveBeenCalled();
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
  it('economy commands WORK on the channel\'s own currency: no guild, no guild-scoped enablement check', async () => {
    const logger = makeLogger();
    const { ws, ctx, isEnabled } = await setup({ economy: makeEconomyRow(), logger });

    ws.emit('notification', chatFrame('!balance'));
    await flush();

    expect(ledgerMocks.getOrCreateChannelWallet).toHaveBeenCalledWith(
      expect.anything(),
      { economyId: 'economy-1', viewerUserId: 'viewer-1' },
      'ViewerOne',
    );
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', '@ViewerOne, you have 100 A');
    expect(isEnabled).not.toHaveBeenCalledWith(null, 'economy');
    expect(isEnabled).not.toHaveBeenCalledWith(expect.anything(), 'economy');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('!daily, !give and !top run against the channel economy too', async () => {
    mocks.getUserByLogin.mockResolvedValueOnce({ ok: true, value: { id: 'target-1', login: 'someone', displayName: 'Someone' } });
    const { ws } = await setup({ economy: makeEconomyRow() });

    for (const text of ['!daily', '!give someone 5', '!top']) {
      ws.emit('notification', chatFrame(text));
      await flush();
    }

    expect(ledgerMocks.claimChannelDaily).toHaveBeenCalledTimes(1);
    expect(ledgerMocks.giveChannel).toHaveBeenCalledWith(
      expect.anything(),
      'economy-1',
      'viewer-1',
      'target-1',
      5,
      { giveMinAmount: 1, giveMaxAmount: 100000 },
      expect.objectContaining({ botUserId: 'bot-1', fromDisplayName: 'ViewerOne', toDisplayName: 'Someone' }),
    );
    expect(ledgerMocks.getChannelEarnedLeaderboard).toHaveBeenCalledWith(expect.anything(), 'economy-1', 5);
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(3);
  });

  it('a guildless channel with no currency (or a switched-off one) stays silent: no ledger call, no reply, no error', async () => {
    const logger = makeLogger();
    for (const economy of [null, makeEconomyRow({ enabled: false })]) {
      vi.clearAllMocks();
      mocks.getBotIdentityRow.mockResolvedValue({ botUserId: 'bot-1', botLogin: 'pavisiebot' });
      mocks.createChatSubscription.mockResolvedValue({ ok: true, subscriptionId: 'sub-1' });
      mocks.sendChatMessage.mockResolvedValue({ ok: true });
      FakeWebSocket.instances = [];
      const { ws } = await setup({ economy, logger });

      for (const text of ['!balance', '!bal', '!daily', '!give someone 5', '!top']) {
        ws.emit('notification', chatFrame(text));
        await flush();
      }

      expect(ledgerMocks.getOrCreateChannelWallet).not.toHaveBeenCalled();
      expect(ledgerMocks.claimChannelDaily).not.toHaveBeenCalled();
      expect(ledgerMocks.giveChannel).not.toHaveBeenCalled();
      expect(ledgerMocks.getChannelEarnedLeaderboard).not.toHaveBeenCalled();
      expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    }
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('chat earning credits a guildless channel\'s viewers in the channel currency, silently', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { title: 'live' } });
    const logger = makeLogger();
    const { ws } = await setup({ economy: makeEconomyRow({ earnPerMessage: 7 }), logger });

    ws.emit('notification', chatFrame('just chatting'));
    await flush();

    expect(ledgerMocks.creditChannel).toHaveBeenCalledWith(
      expect.anything(),
      { economyId: 'economy-1', viewerUserId: 'viewer-1' },
      7,
      'twitch_chat_earn',
      { displayName: 'ViewerOne' },
    );
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('chat earning stays off when the channel currency has earning switched off, and never asks Twitch if live', async () => {
    mocks.getStream.mockResolvedValue({ ok: true, value: { title: 'live' } });
    const { ws } = await setup({ economy: makeEconomyRow({ earnEnabled: false }) });

    ws.emit('notification', chatFrame('just chatting'));
    await flush();

    expect(ledgerMocks.creditChannel).not.toHaveBeenCalled();
    expect(mocks.getStream).not.toHaveBeenCalled();
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

  it('DISCORD reward actions are skipped; CHAT, SOUND and TTS run (TTS on the channel key); nothing errors', async () => {
    const logger = makeLogger();
    const { ws, ctx } = await setup({
      channels: [makeChannelRow({ rewardsEnabled: true, ttsOpenAiKeyEnc: 'enc:channel-key' })],
      rewards: [
        makeRewardRow({ id: 'r-discord', action: 'DISCORD', chatTemplate: null, discordChannelId: '123456789012345678', discordTemplate: 'x' }),
        makeRewardRow({ id: 'r-tts', action: 'TTS', chatTemplate: null, ttsTemplate: 'say {user}', volume: 55 }),
        makeRewardRow({ id: 'r-sound', action: 'SOUND', chatTemplate: null, soundUrl: 'https://cdn.example.com/a.mp3', volume: 30 }),
        makeRewardRow({ id: 'r-chat', action: 'CHAT' }),
      ],
      logger,
    });
    const publishSpy = vi.spyOn(ctx.redis, 'publish');

    ws.emit('notification', redemptionFrame());
    await flush();

    // DISCORD: skipped quietly (a guildless channel has no server to post into).
    expect(mocks.postAlert).not.toHaveBeenCalled();
    // TTS: runs, handed the channel row so the channel's OWN key (or none) is what pays for it.
    expect(mocks.synthesizeTts).toHaveBeenCalledTimes(1);
    expect(mocks.synthesizeTts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'channel-a', guildId: null, ttsOpenAiKeyEnc: 'enc:channel-key' }),
      'say ViewerOne',
    );
    // SOUND + TTS both reach the overlay over Redis pub/sub.
    const published = publishSpy.mock.calls.map(([, payload]) => JSON.parse(payload as string) as Record<string, unknown>);
    expect(published).toHaveLength(2);
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tts', audioId: 'audio-1', volume: 55 }),
        expect.objectContaining({ kind: 'sound', url: 'https://cdn.example.com/a.mp3', volume: 30 }),
      ]),
    );
    // CHAT: still works.
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(expect.anything(), 'b-1', 'Thanks ViewerOne!');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a guildless channel with NO TTS key: the TTS action is skipped honestly (no publish, no error), other actions run', async () => {
    mocks.synthesizeTts.mockResolvedValue(null); // what `synthesizeTts` returns for "no key of any kind"
    const logger = makeLogger();
    const { ws, ctx } = await setup({
      channels: [makeChannelRow({ rewardsEnabled: true })],
      rewards: [
        makeRewardRow({ id: 'r-tts', action: 'TTS', chatTemplate: null, ttsTemplate: 'say {user}' }),
        makeRewardRow({ id: 'r-chat', action: 'CHAT' }),
      ],
      logger,
    });
    const publishSpy = vi.spyOn(ctx.redis, 'publish');

    ws.emit('notification', redemptionFrame());
    await flush();

    expect(publishSpy).not.toHaveBeenCalled();
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('guild-linked channel: behaviour unchanged (control)', () => {
  it('routes !balance to the channel economy (same as a guildless channel), posts DISCORD reward actions and runs TTS with the guild id', async () => {
    const { ws } = await setup({
      channels: [makeChannelRow({ guildId: 'guild-1', rewardsEnabled: true, connectionId: 'conn-1' })],
      economy: makeEconomyRow(),
      rewards: [
        makeRewardRow({ id: 'r-discord', guildId: 'guild-1', action: 'DISCORD', chatTemplate: null, discordChannelId: '123456789012345678', discordTemplate: 'x' }),
        makeRewardRow({ id: 'r-tts', guildId: 'guild-1', action: 'TTS', chatTemplate: null, ttsTemplate: 'say {user}' }),
      ],
    });

    ws.emit('notification', chatFrame('!balance'));
    await flush();
    expect(ledgerMocks.getOrCreateChannelWallet).toHaveBeenCalledWith(
      expect.anything(),
      { economyId: 'economy-1', viewerUserId: 'viewer-1' },
      'ViewerOne',
    );

    ws.emit('notification', redemptionFrame());
    await flush();
    expect(mocks.postAlert).toHaveBeenCalledTimes(1);
    // TTS still gets the linked guild id, so `synthesizeTts` can fall back to the guild's own key when the channel
    // has none of its own (precedence is unit-tested in twitch-chat-tts.test.ts).
    expect(mocks.synthesizeTts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'channel-a', guildId: 'guild-1', ttsOpenAiKeyEnc: null }),
      'say ViewerOne',
    );
  });
});

describe('guild-linked channel whose server has the integrations plugin OFF', () => {
  const linkedOff = () => makeChannelRow({ guildId: 'guild-1', rewardsEnabled: true, connectionId: 'conn-1' });

  it('keeps the chat bot, currency and non-Discord rewards running', async () => {
    const { ws, manager, ctx } = await setup({
      channels: [linkedOff()],
      commands: [makeCommandRow({ guildId: 'guild-1' })],
      economy: makeEconomyRow(),
      isEnabled: async () => false,
    });

    expect(manager.connectedChannelIds()).toEqual(['channel-a']);

    ws.emit('notification', chatFrame('!hello'));
    await flush();
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(expect.anything(), 'b-1', 'Hi ViewerOne!');

    mocks.sendChatMessage.mockClear();
    ws.emit('notification', chatFrame('!balance'));
    await flush();
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', '@ViewerOne, you have 100 A');
  });

  it('skips the DISCORD reward action (the server switched the integrations plugin off) but runs CHAT and SOUND', async () => {
    const { ws, ctx } = await setup({
      channels: [linkedOff()],
      rewards: [
        makeRewardRow({ id: 'r-discord', guildId: 'guild-1', action: 'DISCORD', chatTemplate: null, discordChannelId: '123456789012345678', discordTemplate: 'x' }),
        makeRewardRow({ id: 'r-sound', guildId: 'guild-1', action: 'SOUND', chatTemplate: null, soundUrl: 'https://cdn.example.com/a.mp3', volume: 30 }),
        makeRewardRow({ id: 'r-chat', guildId: 'guild-1', action: 'CHAT' }),
      ],
      isEnabled: async () => false,
    });
    const publishSpy = vi.spyOn(ctx.redis, 'publish');

    ws.emit('notification', redemptionFrame());
    await flush();

    expect(mocks.postAlert).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(expect.anything(), 'b-1', 'Thanks ViewerOne!');
  });

  it('does not relay Twitch chat into Discord or touch the bridge webhook while the plugin is off, and resumes when it is back on', async () => {
    let on = false;
    const fakeGuild = { id: 'guild-1' };
    const { ws, manager, ctx } = await setup({
      client: { guilds: { cache: { get: () => fakeGuild }, fetch: async () => fakeGuild } },
      channels: [
        makeChannelRow({
          guildId: 'guild-1',
          bridgeDiscordChannelId: 'discord-chan-1',
          bridgeTwitchToDiscord: true,
          bridgeWebhookId: 'wh-1',
          bridgeWebhookTokenEnc: 'enc:secret',
        }),
      ],
      isEnabled: async () => on,
    });
    mocks.checkBridgeChannelAccess.mockClear();
    await manager.reconcile(ctx);

    ws.emit('notification', chatFrame('hello discord'));
    await flush();

    expect(mocks.checkBridgeChannelAccess).not.toHaveBeenCalled();
    expect(mocks.ensureBridgeWebhook).not.toHaveBeenCalled();
    expect(mocks.webhookCtor).not.toHaveBeenCalled();
    expect(manager.connectedChannelIds()).toEqual(['channel-a']); // the chat bot itself never paused

    on = true;
    mocks.checkBridgeChannelAccess.mockClear();
    await manager.reconcile(ctx);
    expect(mocks.checkBridgeChannelAccess).toHaveBeenCalledTimes(1);
  });
});
