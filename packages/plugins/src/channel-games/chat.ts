// The door between a chat message and the table host. Decides whether a message is a game command at all, and
// if it is, hands the host a parsed intent. Sits after the channel's economy commands and before its custom
// command engine (`TwitchChatManager.tryGameCommand`).
//
// `{ handled: false }` means the message is not the games' business and the caller must fall through to the
// engine completely unchanged. That is the answer whenever:
//   - the text is not a blackjack command;
//   - the channel already has a custom command with that name (an existing custom command always wins);
//   - blackjack (or the whole currency) is switched off and no table is still finishing;
//   - it is a short alias (`!hit`, `!join`, ...) and this chatter is not seated and no lobby is open.
//
// Privacy: `messageText` is read once, by the parser, and goes no further. It is never logged, stored or
// repeated, and neither is anything derived from it except a command kind and a whole number.
import { parseBlackjackCommand } from './blackjack/commands';
import type { ChannelGameHost, GameEconomy } from './host';

export interface GameChatEvent {
  chatterUserId: string;
  chatterDisplayName: string;
  messageText: string;
  /** Badge `set_id`s on this message, used only to recognise the streamer and their moderators. */
  badgeSetIds: readonly string[];
}

/** A channel's currency as the games need it: `null` from `loadEconomy` means no currency or it is switched off. */
export interface GameEconomyRow extends GameEconomy {
  blackjackEnabled: boolean;
}

export interface GameChatInput {
  event: GameChatEvent;
  commandPrefix: string;
  broadcasterUserId: string;
  /** Enabled custom command names for this channel. */
  customCommandNames: ReadonlySet<string>;
  /** The channel's ENABLED currency, or null. Only called once the message is known to be a game command no
   * custom command owns, so ordinary chat never pays for it. */
  loadEconomy: () => Promise<GameEconomyRow | null>;
  host: ChannelGameHost;
}

export type GameChatResult = { handled: boolean };

const MODERATOR_BADGES = new Set(['broadcaster', 'moderator']);

export async function handleGameChatCommand(input: GameChatInput): Promise<GameChatResult> {
  const { event, commandPrefix, broadcasterUserId, customCommandNames, host } = input;

  const intent = parseBlackjackCommand(event.messageText, commandPrefix);
  if (!intent) return { handled: false };
  if (customCommandNames.has(intent.commandName)) return { handled: false };
  if (intent.viaAlias && !host.aliasApplies(broadcasterUserId, event.chatterUserId))
    return { handled: false };

  const economy = await input.loadEconomy();
  const enabled = Boolean(economy?.blackjackEnabled);
  // Switched off: a table that is already running still gets to finish (its players' bets are on it), but
  // nothing new can start and, with no table, the command does not exist as far as this channel is concerned.
  if (!enabled && !host.hasActiveTable(broadcasterUserId)) return { handled: false };

  await host.handleBlackjack(
    { broadcasterUserId, commandPrefix },
    enabled ? economy : null,
    {
      userId: event.chatterUserId,
      displayName: event.chatterDisplayName,
      isModerator: event.badgeSetIds.some((badge) => MODERATOR_BADGES.has(badge)),
    },
    intent,
  );
  return { handled: true };
}
