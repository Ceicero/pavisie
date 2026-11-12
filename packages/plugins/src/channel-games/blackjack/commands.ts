// Turns one chat message into a blackjack intent, or null when it is not a blackjack command. Pure.
//
// Privacy: this is the only place in the games code that sees what a viewer typed, and nothing typed ever leaves
// it. The result carries a command kind and, at most, a whole number. No raw argument is returned, so nothing
// downstream can log it or echo it back into chat.

/** The full commands. These are reserved names: a NEW custom command may not use them. */
export const BLACKJACK_COMMAND_NAMES = ['blackjack', 'bj'] as const;

/** Short forms. NOT reserved: they only count while that chatter is seated or a lobby is open, and otherwise the
 * message falls through to the channel's custom commands as if games did not exist. */
export const BLACKJACK_ALIAS_NAMES = ['hit', 'stand', 'double', 'split', 'bet', 'join', 'leave'] as const;

export type BlackjackIntentKind =
  'help' | 'start' | 'stop' | 'deal' | 'status' | 'join' | 'leave' | 'hit' | 'stand' | 'double' | 'split';

export interface BlackjackIntent {
  kind: BlackjackIntentKind;
  /** The command word that was used, lowercased ("bj", "hit"). One of the fixed names above, never free text. */
  commandName: string;
  /** True for a short form such as `!hit`. */
  viaAlias: boolean;
  /** The bet for a join: a positive whole number, or null when missing or not a plain number. */
  amount: number | null;
}

const SUBCOMMANDS: Record<string, BlackjackIntentKind> = {
  help: 'help',
  start: 'start',
  open: 'start',
  stop: 'stop',
  cancel: 'stop',
  deal: 'deal',
  status: 'status',
  table: 'status',
  join: 'join',
  bet: 'join',
  leave: 'leave',
  hit: 'hit',
  stand: 'stand',
  stay: 'stand',
  double: 'double',
  split: 'split',
};

const ALIASES: Record<string, BlackjackIntentKind> = {
  hit: 'hit',
  stand: 'stand',
  double: 'double',
  split: 'split',
  bet: 'join',
  join: 'join',
  leave: 'leave',
};

/** Digits only, short enough to always be a safe integer. Anything else ("50.5", "1e9", "all") is not a bet. */
function parseAmount(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  const amount = Number(raw);
  return amount > 0 ? amount : null;
}

export function parseBlackjackCommand(messageText: string, commandPrefix: string): BlackjackIntent | null {
  if (!commandPrefix || !messageText.startsWith(commandPrefix)) return null;
  const parts = messageText.slice(commandPrefix.length).trim().split(/\s+/);
  const commandName = (parts[0] ?? '').toLowerCase();
  if (!commandName) return null;

  if ((BLACKJACK_COMMAND_NAMES as readonly string[]).includes(commandName)) {
    const sub = (parts[1] ?? '').toLowerCase();
    // `!bj` on its own, or with a word that is not a subcommand, shows the help line.
    const kind = SUBCOMMANDS[sub] ?? 'help';
    return { kind, commandName, viaAlias: false, amount: kind === 'join' ? parseAmount(parts[2]) : null };
  }

  const kind = ALIASES[commandName];
  if (!kind) return null;
  return { kind, commandName, viaAlias: true, amount: kind === 'join' ? parseAmount(parts[1]) : null };
}
