// The streamer-chosen currency symbol, as it may appear in chat. Pure, shared by the settings schema (which refuses
// a symbol that is not already chat-safe) and every chat line that shows one (which cleans it again on output, so
// values stored before the rule existed are covered too).

/** The symbol a channel starts with, and the fallback when nothing usable is left of one. */
export const DEFAULT_CURRENCY_SYMBOL = '♦️';

/**
 * Letters, digits, currency and other symbols (emoji included), plus what emoji are built from: combining marks,
 * variation selectors, and the zero-width joiner for sequences such as 👨‍💻. Everything else is dropped:
 * `@` (mentions), `/`, `.`, `:` and the rest of punctuation (commands, links), whitespace and line breaks,
 * control characters, and invisible formatting such as bidi overrides.
 */
const SYMBOL_ALLOWED = /[\p{L}\p{N}\p{S}\p{M}‍]/u;
/** Settings cap the symbol at 8 characters; this is a second cap in case a stored value is longer. */
const SYMBOL_MAX_LENGTH = 16;

/** The symbol made safe to put in a chat line. Falls back to the default symbol if nothing usable is left. */
export function chatSafeSymbol(symbol: string): string {
  const kept = Array.from(symbol.normalize('NFC'))
    .filter((ch) => SYMBOL_ALLOWED.test(ch))
    .join('')
    .slice(0, SYMBOL_MAX_LENGTH)
    // A joiner only means something between two characters.
    .replace(/^‍+|‍+$/gu, '');
  return /[\p{L}\p{N}\p{S}]/u.test(kept) ? kept : DEFAULT_CURRENCY_SYMBOL;
}

/** Whether a symbol is already chat-safe as typed, i.e. `chatSafeSymbol` would leave it unchanged. Used by the
 * settings schema to refuse anything else rather than silently change what the streamer typed. */
export function isChatSafeSymbol(symbol: string): boolean {
  const normalized = symbol.normalize('NFC');
  return chatSafeSymbol(normalized) === normalized;
}
