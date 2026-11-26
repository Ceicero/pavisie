import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type { PrismaClient } from '@pavisie/database';
import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_ECONOMY_DEFAULTS } from '../../channel-economy/settings';
import { chatSafeSymbol, formatAmount, lobbyOpened, results } from '../blackjack/messages';
import { createLobby } from '../blackjack/table';
import { handleGameChatCommand, type GameChatEvent, type GameEconomyRow } from '../chat';
import { ChannelGameHost, DEFAULT_GAME_TIMINGS } from '../host';
import type { CoalescingOutbound } from '../outbound';

function makeHost(clock: { now: number }, timings: { commandCooldownMs?: number } = {}) {
  return new ChannelGameHost({
    // The cooldown never touches the database, Redis or chat.
    prisma: {} as unknown as PrismaClient,
    redis: new RedisMock() as unknown as Redis,
    outbound: { enqueue: vi.fn() } as unknown as CoalescingOutbound,
    logger: { warn: vi.fn(), error: vi.fn() },
    timings,
    now: () => clock.now,
  });
}

describe('game command cooldown (host)', () => {
  it('defaults to 2 seconds', () => {
    expect(DEFAULT_GAME_TIMINGS.commandCooldownMs).toBe(2_000);
  });

  it('allows one command per viewer per channel inside the gap', () => {
    const clock = { now: 1_000_000 };
    const host = makeHost(clock);
    expect(host.takeCommandCooldown('chan', 'v1', 'hit')).toBe(true);
    clock.now += 1_999;
    expect(host.takeCommandCooldown('chan', 'v1', 'hit')).toBe(false);
    clock.now += 1;
    expect(host.takeCommandCooldown('chan', 'v1', 'hit')).toBe(true);
  });

  it('a refused command does not extend the cooldown', () => {
    const clock = { now: 0 };
    const host = makeHost(clock);
    expect(host.takeCommandCooldown('chan', 'v1', 'hit')).toBe(true);
    clock.now = 1_500;
    expect(host.takeCommandCooldown('chan', 'v1', 'hit')).toBe(false);
    clock.now = 2_000;
    expect(host.takeCommandCooldown('chan', 'v1', 'hit')).toBe(true);
  });

  it('keeps viewers and channels separate', () => {
    const clock = { now: 0 };
    const host = makeHost(clock);
    expect(host.takeCommandCooldown('chan', 'v1', 'hit')).toBe(true);
    expect(host.takeCommandCooldown('chan', 'v2', 'hit')).toBe(true);
    expect(host.takeCommandCooldown('other', 'v1', 'hit')).toBe(true);
    expect(host.takeCommandCooldown('chan', 'v1', 'hit')).toBe(false);
  });

  it('is per command: a different command is never blocked', () => {
    const host = makeHost({ now: 0 });
    expect(host.takeCommandCooldown('chan', 'v1', 'join')).toBe(true);
    expect(host.takeCommandCooldown('chan', 'v1', 'leave')).toBe(true);
    expect(host.takeCommandCooldown('chan', 'v1', 'join')).toBe(false);
  });

  it('is off when set to 0', () => {
    const host = makeHost({ now: 0 }, { commandCooldownMs: 0 });
    expect(host.takeCommandCooldown('chan', 'v1', 'hit')).toBe(true);
    expect(host.takeCommandCooldown('chan', 'v1', 'hit')).toBe(true);
  });

  it('sweeps expired entries once it remembers many viewers, and still enforces live ones', () => {
    const clock = { now: 0 };
    const host = makeHost(clock);
    for (let i = 0; i < 5_000; i++) host.takeCommandCooldown('chan', `old-${i}`, 'hit');
    clock.now = 10_000;
    expect(host.takeCommandCooldown('chan', 'fresh', 'hit')).toBe(true);
    const remembered = (host as unknown as { lastCommandAt: Map<string, number> }).lastCommandAt;
    expect(remembered.size).toBe(1);
    expect(host.takeCommandCooldown('chan', 'fresh', 'hit')).toBe(false);
  });
});

describe('game command cooldown (chat door)', () => {
  const economy: GameEconomyRow = {
    id: 'eco-1',
    currencySymbol: 'Agis',
    blackjackMinBet: 10,
    blackjackMaxBet: 1000,
    blackjackEnabled: true,
  };

  function setup() {
    const clock = { now: 0 };
    const host = makeHost(clock);
    const handle = vi.spyOn(host, 'handleBlackjack').mockResolvedValue();
    const send = (event: Partial<GameChatEvent>, text = '!bj status') =>
      handleGameChatCommand({
        event: {
          chatterUserId: 'v1',
          chatterDisplayName: 'Viewer',
          badgeSetIds: [],
          ...event,
          messageText: text,
        },
        commandPrefix: '!',
        broadcasterUserId: 'chan',
        customCommandNames: new Set(),
        loadEconomy: async () => economy,
        host,
      });
    return { clock, handle, send };
  }

  it('swallows a viewer command inside the cooldown without reaching the table or the custom commands', async () => {
    const { clock, handle, send } = setup();
    expect(await send({})).toEqual({ handled: true });
    clock.now += 500;
    // Still handled (so it does not fall through to a custom command), but the table never sees it.
    expect(await send({})).toEqual({ handled: true });
    expect(handle).toHaveBeenCalledTimes(1);
    clock.now += 1_500;
    await send({});
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('lets a viewer run two different commands back to back', async () => {
    const { handle, send } = setup();
    await send({}, '!bj join 50');
    await send({}, '!bj leave');
    await send({}, '!bj join 50');
    // join, leave, then the repeated join inside the gap is dropped.
    expect(handle.mock.calls.map((call) => call[3].kind)).toEqual(['join', 'leave']);
  });

  it('exempts the streamer and moderators', async () => {
    const { handle, send } = setup();
    await send({ badgeSetIds: ['moderator'] }, '!bj start');
    await send({ badgeSetIds: ['moderator'] }, '!bj deal');
    await send({ chatterUserId: 'streamer', badgeSetIds: ['broadcaster'] }, '!bj stop');
    await send({ chatterUserId: 'streamer', badgeSetIds: ['broadcaster'] }, '!bj status');
    expect(handle).toHaveBeenCalledTimes(4);
  });

  it('does not start a cooldown for chat that is not a game command', async () => {
    const { handle, send } = setup();
    expect(await send({}, 'hello there')).toEqual({ handled: false });
    expect(await send({}, '!bj status')).toEqual({ handled: true });
    expect(handle).toHaveBeenCalledTimes(1);
  });
});

describe('currency symbol in chat', () => {
  it.each([
    ['♦️', '♦️'],
    ['Agis', 'Agis'],
    ['$', '$'],
    ['👨‍💻', '👨‍💻'],
    ['@mod', 'mod'],
    ['/ban', 'ban'],
    ['a.co/x', 'acox'],
    ['pts​', 'pts'],
    ['‮gis', 'gis'],
    ['a\nb', 'ab'],
    ['‍x‍', 'x'],
  ])('%j becomes %j', (input, expected) => {
    expect(chatSafeSymbol(input)).toBe(expected);
  });

  it.each(['', '   ', '\n\r', '::', '@', '​‍'])('%j falls back to the default symbol', (input) => {
    expect(chatSafeSymbol(input)).toBe(CHANNEL_ECONOMY_DEFAULTS.currencySymbol);
  });

  it('caps an over-long stored symbol', () => {
    expect(chatSafeSymbol('x'.repeat(40))).toHaveLength(16);
  });

  it('is applied to every line that shows the symbol', () => {
    const hostile = '@all\n/ban';
    expect(formatAmount(1500, hostile)).toBe('1,500 allban');

    const table = createLobby({
      tableId: 't-1',
      economyId: 'eco-1',
      broadcasterUserId: 'chan',
      currencySymbol: hostile,
      commandPrefix: '!',
      minBet: 10,
      maxBet: 1000,
      now: 0,
      lobbyMs: 40_000,
    });
    for (const line of [lobbyOpened(table, '!', 40), results(table, [])]) {
      expect(line).not.toMatch(/[@\n/]/);
      expect(line).toContain('allban');
    }
  });
});
