import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { TwitchChatManager } from '../twitch-chat/manager';
import { buildFakeChannelPrisma } from '../../channel-economy/__tests__/fake-channel-prisma';
import type { WebSocketConstructorLike, WebSocketLike } from '../twitch-chat/socket';

// Table games (blackjack) through the real `TwitchChatManager`: where a game command sits between the economy
// commands and the custom-command engine, what falls through untouched, and what never reaches a log line.
// The ledger is NOT mocked here: bets and payouts run through the real ledger functions over the in-memory fake
// database. Same `vi.hoisted`/FakeWebSocket harness as the other `twitch-chat-manager*.test.ts` files.
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
vi.mock('../twitch-chat/broadcaster-token', () => ({
  getBroadcasterAccessToken: mocks.getBroadcasterAccessToken,
}));
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
  return {
    TWITCH_CLIENT_ID: 'client-id',
    TWITCH_CLIENT_SECRET: 'client-secret',
  } as unknown as PluginContext['env'];
}

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() };
}

function makeChannelRow() {
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
  };
}

function makeCommandRow(name: string, response: string) {
  return {
    id: `command-${name}`,
    channelId: 'channel-a',
    guildId: null,
    name,
    response,
    cooldownSeconds: 0,
    minLevel: 'EVERYONE',
    enabled: true,
    createdBy: 'creator-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

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
    earnEnabled: false,
    earnPerMessage: 5,
    earnCooldownSeconds: 60,
    earnDailyCap: 200,
    blackjackEnabled: true,
    blackjackMinBet: 10,
    blackjackMaxBet: 500,
    ...overrides,
  };
}

interface Chatter {
  id?: string;
  name?: string;
  badges?: string[];
}

const STREAMER: Chatter = { id: 'b-1', name: 'SomeStreamer', badges: ['broadcaster'] };
const MOD: Chatter = { id: 'mod-1', name: 'AMod', badges: ['moderator'] };
const VIEWER: Chatter = { id: 'viewer-1', name: 'ViewerOne', badges: [] };

function chatFrame(text: string, chatter: Chatter = VIEWER) {
  return {
    subscription: { id: 'sub-b-1', type: 'channel.chat.message', version: '1', status: 'enabled' },
    event: {
      broadcaster_user_id: 'b-1',
      chatter_user_id: chatter.id ?? 'viewer-1',
      chatter_user_login: (chatter.name ?? 'ViewerOne').toLowerCase(),
      chatter_user_name: chatter.name ?? 'ViewerOne',
      message: { text },
      badges: (chatter.badges ?? []).map((set_id) => ({ set_id })),
    },
  };
}

const TABLE_KEY = 'pavisie:games:table:b-1';

async function setup(
  opts: { economy?: Record<string, unknown> | null; commands?: Record<string, unknown>[] } = {},
) {
  const logger = makeLogger();
  const db = buildFakeChannelPrisma([
    { economyId: 'economy-1', viewerUserId: 'viewer-1', balance: 1000n },
    { economyId: 'economy-1', viewerUserId: 'viewer-2', balance: 1000n },
  ]);
  const economy = opts.economy === undefined ? makeEconomyRow() : opts.economy;
  const channel = makeChannelRow();
  // The fake channel database for the ledger, plus the handful of lookups the manager itself makes.
  const prisma = Object.assign(db.prisma as unknown as Record<string, unknown>, {
    twitchChatChannel: {
      findMany: async () => [channel],
      findUnique: async () => channel,
      update: async () => ({}),
    },
    twitchChatCommand: { findMany: async () => opts.commands ?? [] },
    twitchChatReward: { findMany: async () => [] },
    channelEconomy: { findUnique: async () => economy },
  });

  const manager = new TwitchChatManager(FakeWebSocketCtor);
  const { ctx, redis } = createTestContext({
    overrides: {
      env: makeEnv(),
      isEnabled: async () => true,
      logger: logger as unknown as PluginContext['logger'],
      prisma: prisma as unknown as PluginContext['prisma'],
    },
  });

  await manager.start(ctx);
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws?.emit('session_welcome', {
    session: { id: 'sess-1', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null },
  });
  await flush();

  /** Delivers one chat message and waits for everything it set in motion, including the paced game output. */
  const say = async (text: string, chatter: Chatter = VIEWER) => {
    ws?.emit('notification', chatFrame(text, chatter));
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flush();
  };
  const sent = () => mocks.sendChatMessage.mock.calls.map((call) => String(call[2]));
  const table = async () => {
    const raw = await redis.get(TABLE_KEY);
    return raw
      ? (JSON.parse(raw) as { phase: string; seats: { viewerUserId: string; bet: number }[] })
      : null;
  };
  return { manager, ctx, redis, db, logger, say, sent, table };
}

beforeEach(async () => {
  await new RedisMock().flushall();
  FakeWebSocket.instances = [];
  vi.clearAllMocks();
  mocks.getBotIdentityRow.mockResolvedValue({ botUserId: 'bot-1', botLogin: 'pavisiebot' });
  mocks.createChatSubscription.mockImplementation(
    async (_ctx: unknown, _sid: string, broadcasterUserId: string) => ({
      ok: true,
      subscriptionId: `sub-chat-${broadcasterUserId}`,
    }),
  );
  mocks.sendChatMessage.mockResolvedValue({ ok: true });
});

describe('table games in the chat pipeline', () => {
  it('opens a table for the streamer and seats a viewer, taking the bet through the ledger', async () => {
    const t = await setup();
    await t.say('!bj start', STREAMER);
    expect((await t.table())?.phase).toBe('lobby');
    expect(t.sent()[0]).toContain('Blackjack table is open');

    await t.say('!bj join 50');
    expect((await t.table())?.seats).toEqual([
      expect.objectContaining({ viewerUserId: 'viewer-1', bet: 50 }),
    ]);
    expect(t.db.getWallet('economy-1', 'viewer-1')?.balance).toBe(950n);
    expect(t.db.getTransactions()).toEqual([
      expect.objectContaining({ type: 'blackjack_bet', fromUserId: 'viewer-1', amount: 50n }),
    ]);
    await t.manager.stop();
  });

  it('lets a moderator open a table but not an ordinary viewer', async () => {
    const t = await setup();
    await t.say('!bj start', VIEWER);
    expect(await t.table()).toBeNull();
    await t.say('!bj start', MOD);
    expect((await t.table())?.phase).toBe('lobby');
    await t.manager.stop();
  });

  it('accepts the short forms while a lobby is open', async () => {
    const t = await setup();
    await t.say('!bj start', STREAMER);
    await t.say('!join 25');
    expect((await t.table())?.seats).toEqual([
      expect.objectContaining({ viewerUserId: 'viewer-1', bet: 25 }),
    ]);
    await t.say('!leave');
    expect((await t.table())?.seats).toEqual([]);
    expect(t.db.getWallet('economy-1', 'viewer-1')?.balance).toBe(1000n);
    await t.manager.stop();
  });

  it('still answers the economy commands first', async () => {
    const t = await setup();
    await t.say('!balance');
    expect(t.sent()).toEqual(['@ViewerOne, you have 1,000 A']);
    await t.manager.stop();
  });
});

describe('falling through when the games do not apply', () => {
  it('does nothing at all when blackjack is switched off', async () => {
    const t = await setup({ economy: makeEconomyRow({ blackjackEnabled: false }) });
    await t.say('!bj start', STREAMER);
    await t.say('!bj join 50');
    expect(await t.table()).toBeNull();
    expect(t.sent()).toEqual([]);
    expect(t.db.getTransactions()).toEqual([]);
    await t.manager.stop();
  });

  it('does nothing when the channel currency is switched off or does not exist', async () => {
    for (const economy of [makeEconomyRow({ enabled: false }), null]) {
      const t = await setup({ economy });
      await t.say('!bj start', STREAMER);
      expect(await t.table()).toBeNull();
      expect(t.sent()).toEqual([]);
      await t.manager.stop();
    }
  });

  it('hands the message to the custom-command engine unchanged when blackjack is off', async () => {
    // Created before blackjack existed (new ones with this name are refused at save time).
    const t = await setup({
      economy: makeEconomyRow({ blackjackEnabled: false }),
      commands: [makeCommandRow('bj', 'Our old bj command')],
    });
    await t.say('!bj start', STREAMER);
    expect(t.sent()).toEqual(['Our old bj command']);
    await t.manager.stop();
  });

  it('lets an existing custom command named bj win even when blackjack is on', async () => {
    const t = await setup({ commands: [makeCommandRow('bj', 'Our old bj command')] });
    await t.say('!bj start', STREAMER);
    expect(t.sent()).toEqual(['Our old bj command']);
    expect(await t.table()).toBeNull();

    // The other name is still blackjack.
    await t.say('!blackjack start', STREAMER);
    expect((await t.table())?.phase).toBe('lobby');
    await t.manager.stop();
  });

  it('leaves the short forms to custom commands when no table is running', async () => {
    const t = await setup({
      commands: [makeCommandRow('hit', 'Custom hit!'), makeCommandRow('join', 'Join our Discord')],
    });
    await t.say('!hit');
    await t.say('!join 50');
    expect(t.sent()).toEqual(['Custom hit!', 'Join our Discord']);
    expect(t.db.getTransactions()).toEqual([]);
    await t.manager.stop();
  });

  it('says nothing for a short form with no table and no custom command', async () => {
    const t = await setup();
    await t.say('!hit');
    await t.say('!join 50');
    await t.say('!stand');
    expect(t.sent()).toEqual([]);
    expect(t.db.getWallet('economy-1', 'viewer-1')?.balance).toBe(1000n);
    await t.manager.stop();
  });

  it('keeps a custom command with a short-form name working even while a table is open', async () => {
    const t = await setup({ commands: [makeCommandRow('join', 'Join our Discord')] });
    await t.say('!bj start', STREAMER);
    await t.say('!join 50');
    expect(t.sent()).toContain('Join our Discord');
    expect((await t.table())?.seats).toEqual([]);
    // The full command still seats the viewer.
    await t.say('!bj join 50');
    expect((await t.table())?.seats).toHaveLength(1);
    await t.manager.stop();
  });

  it('leaves a short form from an unseated viewer alone once the hand has started', async () => {
    const t = await setup({ commands: [makeCommandRow('hit', 'Custom hit!')] });
    await t.say('!bj start', STREAMER);
    await t.say('!bj join 50', { id: 'viewer-2', name: 'ViewerTwo' });
    await t.say('!bj deal', STREAMER);
    mocks.sendChatMessage.mockClear();
    await t.say('!stand', VIEWER);
    // viewer-1 is not at the table: nothing from the table is addressed to them.
    expect(t.sent().some((text) => text.includes('ViewerOne'))).toBe(false);
    await t.manager.stop();
  });

  it("ignores the bot's own messages", async () => {
    const t = await setup();
    await t.say('!bj start', { id: 'bot-1', name: 'pavisiebot', badges: ['broadcaster', 'moderator'] });
    expect(await t.table()).toBeNull();
    expect(t.sent()).toEqual([]);
    await t.manager.stop();
  });

  it('ignores ordinary chat', async () => {
    const t = await setup();
    await t.say('bj start please', STREAMER);
    await t.say('anyone want to play blackjack?');
    expect(await t.table()).toBeNull();
    expect(t.sent()).toEqual([]);
    await t.manager.stop();
  });
});

describe('privacy', () => {
  it('never logs, stores or repeats what a viewer typed', async () => {
    const t = await setup();
    const SECRET = 'SECRETMARKER-9f3a';
    await t.say('!bj start', STREAMER);
    await t.say(`!bj join 50 ${SECRET} https://evil.example/${SECRET}`);
    await t.say(`!bj ${SECRET}`);
    await t.say(`!bj join ${SECRET}`, { id: 'viewer-2', name: 'ViewerTwo' });
    await t.say(`!hit ${SECRET}`);
    await t.say(`!bj deal ${SECRET}`, STREAMER);
    await t.say(`!stand ${SECRET}`);
    await t.say(`!bj stop ${SECRET}`, STREAMER);
    // Give the paced output time to drain completely.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    // The table really ran: the bet was taken, so these assertions are not vacuous.
    expect(t.db.getTransactions().length).toBeGreaterThan(0);
    expect(t.sent().length).toBeGreaterThan(0);

    const logged = JSON.stringify(
      [t.logger.debug, t.logger.info, t.logger.warn, t.logger.error].flatMap((fn) => fn.mock.calls),
    );
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('evil.example');
    // No log line carries the message text under any field name.
    expect(logged).not.toContain('messageText');

    expect(t.sent().join('\n')).not.toContain(SECRET);
    expect(
      JSON.stringify(t.db.getTransactions(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain(SECRET);
    expect(JSON.stringify(t.db.getGameHands())).not.toContain(SECRET);
    const keys = await t.redis.keys('*');
    for (const key of keys) expect(`${key}=${await t.redis.get(key).catch(() => '')}`).not.toContain(SECRET);
    await t.manager.stop();
  });

  it('paces game output to one chat message a second', async () => {
    const t = await setup();
    const times: number[] = [];
    mocks.sendChatMessage.mockImplementation(async () => {
      times.push(Date.now());
      return { ok: true };
    });
    await t.say('!bj start', STREAMER);
    for (let i = 0; i < 6; i += 1) await t.say('!bj status');
    await t.say('!bj join 50');
    await new Promise((resolve) => setTimeout(resolve, 2_600));

    expect(times.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < times.length; i += 1) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000);
    }
    await t.manager.stop();
  });
});
