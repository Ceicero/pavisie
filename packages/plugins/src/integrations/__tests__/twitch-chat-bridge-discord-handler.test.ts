import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { AUTOMOD_GATE_DELAY_MS, twitchBridgeMessageCreateHandler } from '../twitch-chat/bridge-discord-handler';
import { getBridgeDropCount, pruneBridgeDropCount } from '../twitch-chat/bridge-metrics';

// `vi.mock`/`vi.hoisted` are hoisted above every import — see `twitch-chat-manager.test.ts` for the same pattern.
const mocks = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock('../twitch-chat/helix', () => mocks);

const BRIDGE_CHANNEL_ROW = {
  id: 'twitch-channel-row-1',
  guildId: 'guild-1',
  broadcasterUserId: 'b-1',
  broadcasterLogin: 'somestreamer',
  enabled: true,
  commandPrefix: '!',
  bridgeDiscordChannelId: 'discord-chan-1',
  bridgeDiscordToTwitch: true,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMessage(overrides: Record<string, any> = {}): any {
  return {
    guildId: 'guild-1',
    id: 'msg-1',
    channelId: 'discord-chan-1',
    content: 'hello world',
    author: { bot: false, system: false, username: 'brandon' },
    webhookId: null,
    member: { displayName: 'Brandon' },
    attachments: { size: 0 },
    stickers: { size: 0 },
    mentions: { users: [], roles: [], channels: [] },
    channel: { messages: { fetch: vi.fn().mockResolvedValue({}) } },
    ...overrides,
  };
}

function makeCtx(findFirstResult: unknown = BRIDGE_CHANNEL_ROW, extraOverrides: Partial<PluginContext> = {}) {
  return createTestContext({
    prismaOverrides: {
      twitchChatChannel: { findFirst: async () => findFirstResult },
    },
    overrides: extraOverrides,
  });
}

async function runHandler(ctx: PluginContext, message: unknown): Promise<void> {
  await twitchBridgeMessageCreateHandler.handler(ctx, message as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendChatMessage.mockResolvedValue({ ok: true });
  pruneBridgeDropCount(BRIDGE_CHANNEL_ROW.id);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('twitchBridgeMessageCreateHandler — echo-loop safety', () => {
  it('never relays a message authored by a bot', async () => {
    const { ctx } = makeCtx();
    const message = makeMessage({ author: { bot: true, system: false, username: 'somebot' } });
    await runHandler(ctx, message);
    // Even without advancing the automod-gate delay, a bot-authored message must bail out immediately.
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('never relays a message posted by any webhook (including the bridge webhook itself)', async () => {
    const { ctx } = makeCtx();
    const message = makeMessage({ webhookId: 'some-webhook-id' });
    await runHandler(ctx, message);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('never relays a system message', async () => {
    const { ctx } = makeCtx();
    const message = makeMessage({ author: { bot: false, system: true, username: 'discord' } });
    await runHandler(ctx, message);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe('twitchBridgeMessageCreateHandler — command-prefix skip', () => {
  it('does not relay a message starting with the bot command prefix', async () => {
    const { ctx } = makeCtx(BRIDGE_CHANNEL_ROW, { env: { COMMAND_PREFIX: '+' } as unknown as PluginContext['env'] });
    const message = makeMessage({ content: '+help' });
    await runHandler(ctx, message);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('does not relay a message starting with a literal "/"', async () => {
    const { ctx } = makeCtx();
    const message = makeMessage({ content: '/ban someone' });
    await runHandler(ctx, message);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe('twitchBridgeMessageCreateHandler — no bridge configured', () => {
  it('no-ops when no TwitchChatChannel row bridges this Discord channel', async () => {
    const { ctx } = makeCtx(null);
    const message = makeMessage();
    await runHandler(ctx, message);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe('twitchBridgeMessageCreateHandler — regression: both directions off', () => {
  it('does not relay even with a bridge Discord channel configured, when bridgeDiscordToTwitch is false', async () => {
    // findFirst's `where` filters on `bridgeDiscordToTwitch: true` in the real query — a row with it false
    // would never be returned by a real Prisma query, so the fake here returns null to model that faithfully.
    const { ctx } = makeCtx(null);
    const message = makeMessage();
    await runHandler(ctx, message);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe('twitchBridgeMessageCreateHandler — automod gate (delay + recheck)', () => {
  it('relays once the delay elapses and the message still exists', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({});
    const { ctx } = makeCtx();
    const message = makeMessage({ channel: { messages: { fetch: fetchMock } } });

    const promise = runHandler(ctx, message);
    await vi.advanceTimersByTimeAsync(AUTOMOD_GATE_DELAY_MS);
    await promise;

    expect(fetchMock).toHaveBeenCalledWith('msg-1');
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(ctx, 'b-1', expect.stringContaining('[Discord] Brandon:'));
  });

  it('does not relay when the message was deleted (e.g. by automod) during the gate delay', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('Unknown Message'));
    const { ctx } = makeCtx();
    const message = makeMessage({ channel: { messages: { fetch: fetchMock } } });

    const promise = runHandler(ctx, message);
    await vi.advanceTimersByTimeAsync(AUTOMOD_GATE_DELAY_MS);
    await promise;

    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('does not send before the gate delay has elapsed', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({});
    const { ctx } = makeCtx();
    const message = makeMessage({ channel: { messages: { fetch: fetchMock } } });

    const promise = runHandler(ctx, message);
    await vi.advanceTimersByTimeAsync(AUTOMOD_GATE_DELAY_MS - 100);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    await promise;
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
  });
});

describe('twitchBridgeMessageCreateHandler — rate-limit drop counter', () => {
  it('increments the drop counter for the channel when sendChatMessage reports throttled', async () => {
    vi.useFakeTimers();
    mocks.sendChatMessage.mockResolvedValue({ ok: false, error: 'throttled' });
    const { ctx } = makeCtx();
    const message = makeMessage();

    expect(getBridgeDropCount(BRIDGE_CHANNEL_ROW.id)).toBe(0);
    const promise = runHandler(ctx, message);
    await vi.advanceTimersByTimeAsync(AUTOMOD_GATE_DELAY_MS);
    await promise;

    expect(getBridgeDropCount(BRIDGE_CHANNEL_ROW.id)).toBe(1);
  });

  it('does not increment the drop counter for a non-throttled failure', async () => {
    vi.useFakeTimers();
    mocks.sendChatMessage.mockResolvedValue({ ok: false, error: 'Twitch bot identity is not available.' });
    const { ctx } = makeCtx();
    const message = makeMessage();

    const promise = runHandler(ctx, message);
    await vi.advanceTimersByTimeAsync(AUTOMOD_GATE_DELAY_MS);
    await promise;

    expect(getBridgeDropCount(BRIDGE_CHANNEL_ROW.id)).toBe(0);
  });
});

describe('twitchBridgeMessageCreateHandler — privacy: never logs relayed text or identity', () => {
  it('no logger call anywhere in this handler receives the sentinel message text or display name', async () => {
    vi.useFakeTimers();
    const SENTINEL_TEXT = 'super-secret-sentinel-message-text-should-never-be-logged';
    const SENTINEL_NAME = 'Sentinel Display Name';
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as PluginContext['logger'];
    const { ctx } = makeCtx(BRIDGE_CHANNEL_ROW, { logger });
    const message = makeMessage({ content: SENTINEL_TEXT, member: { displayName: SENTINEL_NAME } });

    const promise = runHandler(ctx, message);
    await vi.advanceTimersByTimeAsync(AUTOMOD_GATE_DELAY_MS);
    await promise;

    for (const fn of [logger.warn, logger.error, logger.info, logger.debug]) {
      for (const call of (fn as ReturnType<typeof vi.fn>).mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(SENTINEL_TEXT);
        expect(serialized).not.toContain(SENTINEL_NAME);
      }
    }
  });
});
