import { describe, expect, it, vi } from 'vitest';
import { CommandCooldowns } from '../twitch-chat/engine';
import {
  ECONOMY_COMMAND_NAMES,
  handleEconomyChatCommand,
  type EconomyChatPort,
  type EconomyCommandHelix,
  type EconomyCommandInput,
} from '../twitch-chat/economy-commands';

const CHANNEL_ID = 'channel-1';
const BOT_TWITCH_USER_ID = 'bot-twitch-1';

function makePort(overrides: Partial<EconomyChatPort> = {}): EconomyChatPort {
  return {
    currencySymbol: '♦️',
    getOrCreateWallet: vi.fn(async () => ({ balance: 0n })),
    claimDaily: vi.fn(async () => ({ ok: true as const, amount: 50n, streak: 1 })),
    give: vi.fn(async () => ({ ok: true as const })),
    getLeaderboard: vi.fn(async () => []),
    ...overrides,
  };
}

function makeHelix(overrides: Partial<EconomyCommandHelix> = {}): EconomyCommandHelix {
  return {
    getUserByLogin: vi.fn(async () => ({ ok: true, value: null })),
    ...overrides,
  };
}

/** `port` doubles as the lazy loader's result: `null` means "no enabled currency for this channel". */
function baseInput(
  overrides: Partial<Omit<EconomyCommandInput, 'loadEconomy'>> & { port?: EconomyChatPort | null } = {},
): EconomyCommandInput {
  const { port, ...rest } = overrides;
  const resolved = port === undefined ? makePort() : port;
  return {
    event: { chatterUserId: 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: '' },
    commandPrefix: '!',
    channelId: CHANNEL_ID,
    customCommandNames: new Set(),
    loadEconomy: vi.fn(async () => resolved),
    botTwitchUserId: BOT_TWITCH_USER_ID,
    helix: makeHelix(),
    cooldowns: new CommandCooldowns(),
    ...rest,
  };
}

describe('handleEconomyChatCommand — fallthrough conditions', () => {
  it('does not handle a message that does not start with the prefix', async () => {
    const input = baseInput({ event: { chatterUserId: 'v', chatterDisplayName: 'V', messageText: 'balance please' } });
    expect(await handleEconomyChatCommand(input)).toEqual({ handled: false });
    expect(input.loadEconomy).not.toHaveBeenCalled();
  });

  it('does not handle a non-reserved command name, and never loads the currency for it', async () => {
    const input = baseInput({ event: { chatterUserId: 'v', chatterDisplayName: 'V', messageText: '!hello' } });
    expect(await handleEconomyChatCommand(input)).toEqual({ handled: false });
    expect(input.loadEconomy).not.toHaveBeenCalled();
  });

  it('does not handle when an enabled custom command already owns the name (custom commands win)', async () => {
    const port = makePort();
    const input = baseInput({
      event: { chatterUserId: 'v', chatterDisplayName: 'V', messageText: '!balance' },
      customCommandNames: new Set(['balance']),
      port,
    });
    expect(await handleEconomyChatCommand(input)).toEqual({ handled: false });
    expect(input.loadEconomy).not.toHaveBeenCalled();
    expect(port.getOrCreateWallet).not.toHaveBeenCalled();
  });

  it('does not handle when the channel has no enabled currency (loader returns null)', async () => {
    const result = await handleEconomyChatCommand(
      baseInput({ event: { chatterUserId: 'v', chatterDisplayName: 'V', messageText: '!balance' }, port: null }),
    );
    expect(result).toEqual({ handled: false });
  });

  it('handles an economy command whenever a currency is available (no Discord server involved)', async () => {
    const result = await handleEconomyChatCommand(
      baseInput({ event: { chatterUserId: 'v', chatterDisplayName: 'V', messageText: '!balance' } }),
    );
    expect(result.handled).toBe(true);
  });
});

describe.each(['balance', 'bal'] as const)('handleEconomyChatCommand — !%s', (name) => {
  it("replies with the caller's balance in the channel's currency", async () => {
    const port = makePort({ currencySymbol: '💎', getOrCreateWallet: vi.fn(async () => ({ balance: 1234n })) });
    const result = await handleEconomyChatCommand(
      baseInput({
        event: { chatterUserId: 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: `!${name}` },
        port,
      }),
    );
    expect(result).toEqual({ handled: true, reply: '@ViewerOne, you have 1,234 💎' });
    expect(port.getOrCreateWallet).toHaveBeenCalledWith('viewer-1', 'ViewerOne');
  });
});

describe('handleEconomyChatCommand — !daily', () => {
  it('replies with the claimed amount and streak on success', async () => {
    const port = makePort({ claimDaily: vi.fn(async () => ({ ok: true as const, amount: 75n, streak: 3 })) });
    const result = await handleEconomyChatCommand(
      baseInput({
        event: { chatterUserId: 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: '!daily' },
        port,
      }),
    );
    expect(result).toEqual({ handled: true, reply: '@ViewerOne, you claimed 75 ♦️! Streak: 3 day(s).' });
    expect(port.claimDaily).toHaveBeenCalledWith('viewer-1', 'ViewerOne');
  });

  it('replies with time remaining on cooldown', async () => {
    const port = makePort({ claimDaily: vi.fn(async () => ({ ok: false as const, retryAfterMs: 2 * 60 * 60 * 1000 })) });
    const result = await handleEconomyChatCommand(
      baseInput({
        event: { chatterUserId: 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: '!daily' },
        port,
      }),
    );
    expect(result).toEqual({
      handled: true,
      reply: "@ViewerOne, you've already claimed today — try again in about 2h.",
    });
  });
});

describe('handleEconomyChatCommand — !give', () => {
  function giveEvent(text: string) {
    return { chatterUserId: 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: text };
  }

  it('gives a usage message with too few args', async () => {
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give someone') }));
    expect(result).toEqual({ handled: true, reply: '@ViewerOne, usage: !give <name> <amount>' });
  });

  it('rejects an invalid (non-integer/zero/negative) amount without calling Helix', async () => {
    const helix = makeHelix();
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give someone abc'), helix }));
    expect(result.handled).toBe(true);
    expect((result as { reply: string }).reply).toMatch(/valid whole-number amount/);
    expect(helix.getUserByLogin).not.toHaveBeenCalled();

    const zero = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give someone 0'), helix }));
    expect((zero as { reply: string }).reply).toMatch(/valid whole-number amount/);
  });

  it('reports a transient Helix failure distinctly from an unknown user', async () => {
    const helix = makeHelix({ getUserByLogin: vi.fn(async () => ({ ok: false as const })) });
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give someone 10'), helix }));
    expect((result as { reply: string }).reply).toMatch(/couldn't reach Twitch/);
  });

  it('rejects an unknown Twitch login without echoing the input', async () => {
    const helix = makeHelix({ getUserByLogin: vi.fn(async () => ({ ok: true, value: null })) });
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give nosuchuser 10'), helix }));
    expect((result as { reply: string }).reply).toBe("@ViewerOne, couldn't find that Twitch user.");
    expect((result as { reply: string }).reply).not.toContain('nosuchuser');
  });

  it('rejects a login containing punctuation without calling Helix, and never echoes it', async () => {
    // Each of these is a single whitespace-free token (so it lands as one `args[0]`) but contains a character
    // outside Twitch's own login alphabet ([a-z0-9_]) — the exact class of input that must never reach a reply.
    const helix = makeHelix();
    const badLogins = ['user@name', 'a"b', "quote'd", 'ok/name', 'semi;colon', 'dot.name', 'caps!bang'];
    for (const bad of badLogins) {
      const result = await handleEconomyChatCommand(baseInput({ event: giveEvent(`!give ${bad} 10`), helix }));
      expect((result as { reply: string }).reply).toBe("@ViewerOne, that isn't a valid Twitch username.");
      expect((result as { reply: string }).reply).not.toContain(bad);
    }
    expect(helix.getUserByLogin).not.toHaveBeenCalled();
  });

  it('rejects a login built from multiple words (spaces make later "words" the amount, but a bad word-1 is still rejected) without calling Helix', async () => {
    const helix = makeHelix();
    // "not" alone is a syntactically valid-looking login token, so this exercises the amount-parsing path
    // rather than the login-format path — included so the two validations are not confused with each other.
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give not a login'), helix }));
    expect((result as { reply: string }).reply).toMatch(/valid whole-number amount/);
    expect(helix.getUserByLogin).not.toHaveBeenCalled();
  });

  it('rejects a URL as the login without calling Helix or echoing it', async () => {
    const helix = makeHelix();
    const result = await handleEconomyChatCommand(
      baseInput({ event: giveEvent('!give https://evil.example/x 10'), helix }),
    );
    expect((result as { reply: string }).reply).toBe("@ViewerOne, that isn't a valid Twitch username.");
    expect((result as { reply: string }).reply).not.toContain('evil.example');
    expect(helix.getUserByLogin).not.toHaveBeenCalled();
  });

  it('rejects a login longer than 25 characters without calling Helix', async () => {
    const helix = makeHelix();
    const tooLong = 'a'.repeat(26);
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent(`!give ${tooLong} 10`), helix }));
    expect((result as { reply: string }).reply).toBe("@ViewerOne, that isn't a valid Twitch username.");
    expect(helix.getUserByLogin).not.toHaveBeenCalled();
  });

  it('accepts an optional leading @ and lowercases the login', async () => {
    const helix = makeHelix({
      getUserByLogin: vi.fn(async (login: string) => {
        expect(login).toBe('someone'); // stripped of @ and lowercased before lookup
        return { ok: true, value: { id: 'target-1', login: 'someone', displayName: 'Someone' } };
      }),
    });
    const port = makePort({ give: vi.fn(async () => ({ ok: true as const })) });
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give @SomeOne 10'), helix, port }));
    expect(result).toEqual({ handled: true, reply: '@ViewerOne, gave 10 ♦️ to Someone.' });
  });

  it('rejects giving to the bot account without calling give', async () => {
    const helix = makeHelix({
      getUserByLogin: vi.fn(async () => ({ ok: true, value: { id: BOT_TWITCH_USER_ID, login: 'pavisiebot', displayName: 'PavisieBot' } })),
    });
    const port = makePort();
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give pavisiebot 10'), helix, port }));
    expect(result).toEqual({ handled: true, reply: "@ViewerOne, you can't give to the bot." });
    expect(port.give).not.toHaveBeenCalled();
  });

  it('rejects giving to self, surfaced via the ledger reason', async () => {
    const helix = makeHelix({
      getUserByLogin: vi.fn(async () => ({ ok: true, value: { id: 'viewer-1', login: 'viewerone', displayName: 'ViewerOne' } })),
    });
    const port = makePort({ give: vi.fn(async () => ({ ok: false, reason: 'self' })) });
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give viewerone 10'), helix, port }));
    expect(result).toEqual({ handled: true, reply: "@ViewerOne, you can't give to yourself." });
  });

  it.each([
    ['below_min', 'that amount is too small.'],
    ['above_max', 'that amount is too large.'],
    ['insufficient_balance', "you don't have enough for that."],
    ['invalid_amount', 'give a valid whole-number amount.'],
  ] as const)('surfaces the %s ledger rejection', async (reason, expectedTail) => {
    const helix = makeHelix({
      getUserByLogin: vi.fn(async () => ({ ok: true, value: { id: 'target-1', login: 'someone', displayName: 'Someone' } })),
    });
    const port = makePort({ give: vi.fn(async () => ({ ok: false, reason })) });
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give someone 10'), helix, port }));
    expect(result).toEqual({ handled: true, reply: `@ViewerOne, ${expectedTail}` });
  });

  it('an unknown ledger reason gets a fixed generic reply (never the raw reason)', async () => {
    const helix = makeHelix({
      getUserByLogin: vi.fn(async () => ({ ok: true, value: { id: 'target-1', login: 'someone', displayName: 'Someone' } })),
    });
    const port = makePort({ give: vi.fn(async () => ({ ok: false, reason: 'weird_internal_reason' })) });
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give someone 10'), helix, port }));
    expect(result).toEqual({ handled: true, reply: "@ViewerOne, that didn't work." });
  });

  it('gives on success, handing both display names to the ledger (which stores them only after validation)', async () => {
    const helix = makeHelix({
      getUserByLogin: vi.fn(async () => ({ ok: true, value: { id: 'target-1', login: 'someone', displayName: 'Someone' } })),
    });
    const port = makePort({ give: vi.fn(async () => ({ ok: true as const })) });
    const result = await handleEconomyChatCommand(baseInput({ event: giveEvent('!give someone 25'), helix, port }));
    expect(result).toEqual({ handled: true, reply: '@ViewerOne, gave 25 ♦️ to Someone.' });
    expect(port.give).toHaveBeenCalledWith('viewer-1', 'target-1', 25, {
      fromDisplayName: 'ViewerOne',
      toDisplayName: 'Someone',
    });
    // The handler itself never pre-creates wallets (no bystander wallet on a rejected give).
    expect(port.getOrCreateWallet).not.toHaveBeenCalled();
  });
});

describe('handleEconomyChatCommand — !top', () => {
  it('replies with a one-line ranking', async () => {
    const port = makePort({
      getLeaderboard: vi.fn(async () => [
        { displayName: 'Alice', earned: 200n },
        { displayName: 'Bob', earned: 100n },
      ]),
    });
    const result = await handleEconomyChatCommand(
      baseInput({
        event: { chatterUserId: 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: '!top' },
        port,
      }),
    );
    expect(result).toEqual({
      handled: true,
      reply: 'Top Twitch earners: 1. Alice (200 ♦️), 2. Bob (100 ♦️)',
    });
    expect(port.getLeaderboard).toHaveBeenCalledWith(5);
  });

  it('replies gracefully when no one has earned anything', async () => {
    const port = makePort({ getLeaderboard: vi.fn(async () => []) });
    const result = await handleEconomyChatCommand(
      baseInput({
        event: { chatterUserId: 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: '!top' },
        port,
      }),
    );
    expect(result).toEqual({ handled: true, reply: 'No one has earned anything from Twitch chat yet.' });
  });
});

describe('handleEconomyChatCommand — per-viewer cooldown', () => {
  it('is silent (handled, null reply) on a second call within 10s, independent per viewer', async () => {
    const cooldowns = new CommandCooldowns();
    let now = 1_000_000;

    const first = await handleEconomyChatCommand(
      baseInput({
        event: { chatterUserId: 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: '!balance' },
        cooldowns,
        now,
      }),
    );
    expect(first.handled).toBe(true);
    expect((first as { reply: string | null }).reply).not.toBeNull();

    now += 5000; // within the 10s cooldown
    const second = await handleEconomyChatCommand(
      baseInput({
        event: { chatterUserId: 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: '!balance' },
        cooldowns,
        now,
      }),
    );
    expect(second).toEqual({ handled: true, reply: null });

    // A different viewer is not affected by viewer-1's cooldown.
    const otherViewer = await handleEconomyChatCommand(
      baseInput({
        event: { chatterUserId: 'viewer-2', chatterDisplayName: 'ViewerTwo', messageText: '!balance' },
        cooldowns,
        now,
      }),
    );
    expect(otherViewer.handled).toBe(true);
    expect((otherViewer as { reply: string | null }).reply).not.toBeNull();

    now += 6000; // now past the 10s cooldown for viewer-1
    const third = await handleEconomyChatCommand(
      baseInput({
        event: { chatterUserId: 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: '!balance' },
        cooldowns,
        now,
      }),
    );
    expect(third.handled).toBe(true);
    expect((third as { reply: string | null }).reply).not.toBeNull();
  });

  it('does not share cooldown state with the custom-command engine (distinct key namespace)', () => {
    // Reserved names are unaffected by unrelated custom-command cooldown keys on the same instance.
    const cooldowns = new CommandCooldowns();
    const now = 10_000_000;
    expect(cooldowns.take(CHANNEL_ID, 'balance', 30, now)).toBe(true); // a plain custom-command key
    expect(cooldowns.take(CHANNEL_ID, 'econ:viewer-1:balance', 10, now)).toBe(true); // distinct economy key
  });
});

describe('handleEconomyChatCommand — reserved names constant', () => {
  it('covers exactly balance/bal/daily/give/top', () => {
    expect([...ECONOMY_COMMAND_NAMES].sort()).toEqual(['bal', 'balance', 'daily', 'give', 'top']);
  });
});
