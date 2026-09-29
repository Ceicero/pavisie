// Twitch chat economy commands (!balance/!bal/!daily/!give/!top) — parsed and handled here, BEFORE
// `engine.handleChatMessage` (see `TwitchChatManager.tryEconomyCommand`), so:
//   (a) an existing custom command with one of these names still wins (checked before anything else here) and
//       nothing already configured on a channel breaks;
//   (b) the engine (`engine.ts`) stays free of economy knowledge — it never sees these names at all;
//   (c) a message this module doesn't handle for economy reasons falls through to the engine completely
//       unchanged — never a marker string, never a partially-consumed reply.
// The currency is OWNED BY THE TWITCH CHANNEL (`ChannelEconomy`, ARCHITECTURE.md §18b/§19e): these commands run for
// any channel whose economy is enabled, guild-linked or not. Balances are only ever touched through the
// `EconomyChatPort` the caller hands in (built by `economy-port.ts` over `channel-economy/ledger.ts`) — this module
// never imports Prisma or a ledger directly, and NEVER logs chat text, the chatter's display name, or any reply text.
import type { ChannelClaimDailyResult } from '../../channel-economy/ledger';
import { CommandCooldowns, type EngineHelixResult } from './engine';

/** Reserved economy command names — enforced at write time for NEW custom commands the same way
 * `TWITCH_CHAT_RESERVED_COMMAND_NAMES`'s built-ins are (`@pavisie/types/integrations`); an EXISTING custom
 * command with one of these names still wins here (see `handleEconomyChatCommand`'s first checks). */
export const ECONOMY_COMMAND_NAMES = ['balance', 'bal', 'daily', 'give', 'top'] as const;
export type EconomyCommandName = (typeof ECONOMY_COMMAND_NAMES)[number];

function isEconomyCommandName(name: string): name is EconomyCommandName {
  return (ECONOMY_COMMAND_NAMES as readonly string[]).includes(name);
}

/** Per-viewer, per-command cooldown — independent of custom-command/built-in cooldowns (distinct key
 * namespace, `econ:<viewerId>:<name>`, on the SAME `CommandCooldowns` instance the engine uses for those). */
const ECONOMY_COMMAND_COOLDOWN_SECONDS = 10;

/** Twitch's own login character rules (lowercase letters, digits, underscore; 1-25 chars) — `!give`'s target
 * argument is checked against this BEFORE any Helix call or any reply that might include it. Rejecting an
 * obviously-invalid login locally (instead of letting it flow into an echoed reply) is what closes the echo-
 * abuse hole in `handleGive`. */
const TWITCH_LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;

/** Everything the chat commands need from one channel's currency. Built by `createEconomyChatPort`
 * (`economy-port.ts`) over the channel-economy ledger; tests pass a plain fake. */
export interface EconomyChatPort {
  currencySymbol: string;
  /** Get-or-create the viewer's wallet (refreshing their display name). */
  getOrCreateWallet(viewerUserId: string, displayName: string): Promise<{ balance: bigint }>;
  claimDaily(viewerUserId: string, displayName: string): Promise<ChannelClaimDailyResult>;
  /** A transfer inside this ONE channel's currency. `toUserId` is already resolved (via Helix) by the caller. */
  give(
    fromUserId: string,
    toUserId: string,
    amount: number,
    names: { fromDisplayName: string; toDisplayName: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Top viewers by lifetime earned. */
  getLeaderboard(limit: number): Promise<Array<{ displayName: string; earned: bigint }>>;
}

export interface EconomyChatterEvent {
  chatterUserId: string;
  /** Chatter's current Twitch display name — used for `getOrCreateWallet` (keeps leaderboards current) and in
   * the reply text. Never logged. */
  chatterDisplayName: string;
  messageText: string;
}

export interface EconomyCommandHelix {
  getUserByLogin(
    login: string,
  ): Promise<EngineHelixResult<{ id: string; login: string; displayName: string } | null>>;
}

export interface EconomyCommandInput {
  event: EconomyChatterEvent;
  commandPrefix: string;
  channelId: string;
  /** Enabled custom command names for this channel — a custom command with a reserved name always wins. */
  customCommandNames: ReadonlySet<string>;
  /** Resolves this channel's currency, or `null` when it has none / it is switched off. Called only once the
   * message is known to be an economy command that no custom command owns, so ordinary chat never pays for it. */
  loadEconomy: () => Promise<EconomyChatPort | null>;
  /** The bot identity's own Twitch user id, if known — `!give` rejects sending to it. */
  botTwitchUserId: string | null;
  helix: EconomyCommandHelix;
  cooldowns: CommandCooldowns;
  now?: number;
}

/** `{ handled: false }` means "not an eligible economy command right now" — the caller must fall through to
 * `engine.handleChatMessage` completely unchanged. `{ handled: true, reply }` means this module owns the
 * message; `reply` is `null` only while the per-viewer cooldown is active (silent, matching the engine's own
 * cooldown behavior for custom/built-in commands). */
export type EconomyCommandResult = { handled: false } | { handled: true; reply: string | null };

const GIVE_REASON_MESSAGES: Record<string, string> = {
  self: "you can't give to yourself.",
  bot: "you can't give to the bot.",
  below_min: 'that amount is too small.',
  above_max: 'that amount is too large.',
  insufficient_balance: "you don't have enough for that.",
  invalid_amount: 'give a valid whole-number amount.',
};

/** Mirrors `economy/service.ts`'s `formatCurrency` — duplicated rather than imported because plugins never
 * import across each other's folders directly (ARCHITECTURE.md §7.5), and this is a one-line pure formatter, not
 * business logic. */
function formatAmount(amount: bigint, symbol: string): string {
  return `${amount.toLocaleString('en-US')} ${symbol}`;
}

async function handleBalance(input: EconomyCommandInput, economy: EconomyChatPort): Promise<string> {
  const { event } = input;
  const wallet = await economy.getOrCreateWallet(event.chatterUserId, event.chatterDisplayName);
  return `@${event.chatterDisplayName}, you have ${formatAmount(wallet.balance, economy.currencySymbol)}`;
}

async function handleDaily(input: EconomyCommandInput, economy: EconomyChatPort): Promise<string> {
  const { event } = input;
  const result = await economy.claimDaily(event.chatterUserId, event.chatterDisplayName);
  if (!result.ok) {
    const hours = Math.ceil(result.retryAfterMs / (60 * 60 * 1000));
    return `@${event.chatterDisplayName}, you've already claimed today — try again in about ${hours}h.`;
  }
  return `@${event.chatterDisplayName}, you claimed ${formatAmount(result.amount, economy.currencySymbol)}! Streak: ${result.streak} day(s).`;
}

async function handleGive(args: string[], input: EconomyCommandInput, economy: EconomyChatPort): Promise<string> {
  const { event, botTwitchUserId, helix, commandPrefix } = input;

  if (args.length < 2) {
    return `@${event.chatterDisplayName}, usage: ${commandPrefix}give <name> <amount>`;
  }

  const login = (args[0] ?? '').replace(/^@/, '').toLowerCase();
  const amount = Number(args[1]);

  // Validated against Twitch's own login character rules BEFORE any Helix call, and — critically — before any
  // reply that could include it. Never echo viewer-typed text back into chat in our own voice: `!give <slur or
  // link> 5` must never make the bot post that text verbatim (an easy way to get the bot account banned under
  // Twitch ToS). Every reply below is a fixed string that never includes `login` or any other raw argument.
  if (!TWITCH_LOGIN_PATTERN.test(login)) {
    return `@${event.chatterDisplayName}, that isn't a valid Twitch username.`;
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return `@${event.chatterDisplayName}, give a valid whole-number amount, e.g. ${commandPrefix}give username 50.`;
  }

  const lookup = await helix.getUserByLogin(login);
  if (!lookup.ok) {
    return `@${event.chatterDisplayName}, couldn't reach Twitch to look that up — try again in a moment.`;
  }
  if (!lookup.value) {
    return `@${event.chatterDisplayName}, couldn't find that Twitch user.`;
  }
  if (botTwitchUserId && lookup.value.id === botTwitchUserId) {
    return `@${event.chatterDisplayName}, you can't give to the bot.`;
  }

  // Both wallets' display names are stored by the ledger itself once the transfer has passed validation, so a
  // rejected `!give` never leaves a wallet (or a stored display name) behind for a bystander.
  const result = await economy.give(event.chatterUserId, lookup.value.id, amount, {
    fromDisplayName: event.chatterDisplayName,
    toDisplayName: lookup.value.displayName,
  });
  if (!result.ok) {
    return `@${event.chatterDisplayName}, ${GIVE_REASON_MESSAGES[result.reason] ?? "that didn't work."}`;
  }
  return `@${event.chatterDisplayName}, gave ${formatAmount(BigInt(amount), economy.currencySymbol)} to ${lookup.value.displayName}.`;
}

async function handleTop(economy: EconomyChatPort): Promise<string> {
  const rows = await economy.getLeaderboard(5);
  if (rows.length === 0) return 'No one has earned anything from Twitch chat yet.';
  const parts = rows.map((row, i) => `${i + 1}. ${row.displayName} (${formatAmount(row.earned, economy.currencySymbol)})`);
  return `Top Twitch earners: ${parts.join(', ')}`;
}

/**
 * Parses one Twitch chat message for a reserved economy command name and, if eligible, runs it. Returns
 * `{ handled: false }` for anything that isn't a recognized, currently-eligible economy command — including
 * when an enabled custom command already owns that name or the channel has no enabled currency — so the caller
 * falls through to `engine.handleChatMessage` unchanged.
 */
export async function handleEconomyChatCommand(input: EconomyCommandInput): Promise<EconomyCommandResult> {
  const { event, commandPrefix, customCommandNames, loadEconomy, cooldowns, channelId } = input;
  const now = input.now ?? Date.now();

  if (!commandPrefix || !event.messageText.startsWith(commandPrefix)) return { handled: false };
  const rest = event.messageText.slice(commandPrefix.length).trim();
  if (!rest) return { handled: false };
  const parts = rest.split(/\s+/);
  const name = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1);

  if (!isEconomyCommandName(name)) return { handled: false };
  if (customCommandNames.has(name)) return { handled: false }; // an existing custom command with this name wins

  const economy = await loadEconomy();
  if (!economy) return { handled: false };

  if (!cooldowns.take(channelId, `econ:${event.chatterUserId}:${name}`, ECONOMY_COMMAND_COOLDOWN_SECONDS, now)) {
    return { handled: true, reply: null };
  }

  switch (name) {
    case 'balance':
    case 'bal':
      return { handled: true, reply: await handleBalance(input, economy) };
    case 'daily':
      return { handled: true, reply: await handleDaily(input, economy) };
    case 'give':
      return { handled: true, reply: await handleGive(args, input, economy) };
    case 'top':
      return { handled: true, reply: await handleTop(economy) };
  }
}
