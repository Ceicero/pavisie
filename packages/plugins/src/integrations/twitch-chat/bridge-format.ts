// Discord <-> Twitch chat bridge — pure/testable formatting helpers: no discord.js, no Prisma, no
// `PluginContext`. `manager.ts` and `bridge-discord-handler.ts` feed these plain data and use the plain string
// they return. NEVER log or persist message text or chatter/author identity here — this module only transforms
// text, it never sends or stores anything itself.

/** Twitch's practical chat message length; the bot's own `[Discord] name: ` prefix counts against this. */
export const DISCORD_TO_TWITCH_MAX_LENGTH = 500;
/** Discord's hard per-message content limit. */
export const TWITCH_TO_DISCORD_MAX_LENGTH = 2000;

export interface DiscordToTwitchInput {
  displayName: string;
  content: string;
  /** True if the Discord message had any attachment or sticker. */
  hasAttachment: boolean;
  userMentions: { id: string; name: string }[];
  roleMentions: { id: string; name: string }[];
  channelMentions: { id: string; name: string }[];
}

/**
 * Replaces `<@id>`/`<@!id>` (user), `<@&id>` (role), and `<#id>` (channel) mention tokens with plain
 * `@name`/`@name`/`#name` text, resolved against the given mention lists. A mention whose id isn't found in its
 * list (shouldn't normally happen — the lists are expected to cover every mention actually present in `content`)
 * still gets replaced with a generic `@user`/`@role`/`#channel` rather than left as a raw id — no raw Discord id
 * of any kind may remain in the output.
 */
export function resolveMentionsToPlainNames(
  content: string,
  userMentions: { id: string; name: string }[],
  roleMentions: { id: string; name: string }[],
  channelMentions: { id: string; name: string }[],
): string {
  let result = content.replace(/<@!?(\d{1,20})>/g, (_match, id: string) => {
    const found = userMentions.find((m) => m.id === id);
    return `@${found ? found.name : 'user'}`;
  });
  result = result.replace(/<@&(\d{1,20})>/g, (_match, id: string) => {
    const found = roleMentions.find((m) => m.id === id);
    return `@${found ? found.name : 'role'}`;
  });
  result = result.replace(/<#(\d{1,20})>/g, (_match, id: string) => {
    const found = channelMentions.find((m) => m.id === id);
    return `#${found ? found.name : 'channel'}`;
  });
  return result;
}

/**
 * Formats a Discord message for relay into Twitch chat: resolves mentions to plain names, collapses
 * newlines to a single space, appends an `[attachment]` marker when relevant, and prefixes with
 * `[Discord] <displayName>: `. The prefix is never truncated — only the text portion is, with a single
 * ellipsis appended so the total (prefix + text + ellipsis) never exceeds `DISCORD_TO_TWITCH_MAX_LENGTH`.
 */
export function formatDiscordToTwitch(input: DiscordToTwitchInput): string {
  const resolved = resolveMentionsToPlainNames(
    input.content,
    input.userMentions,
    input.roleMentions,
    input.channelMentions,
  );
  const collapsed = resolved.replace(/[\r\n]+/g, ' ').trim();

  let text = collapsed;
  if (input.hasAttachment) {
    text = collapsed.length > 0 ? `${collapsed} [attachment]` : '[attachment]';
  }

  const prefix = `[Discord] ${input.displayName}: `;
  const full = prefix + text;
  if (full.length <= DISCORD_TO_TWITCH_MAX_LENGTH) return full;

  // Truncate only the text portion, reserving exactly one character for the ellipsis, so
  // prefix.length + truncated.length + 1 <= DISCORD_TO_TWITCH_MAX_LENGTH.
  const available = Math.max(0, DISCORD_TO_TWITCH_MAX_LENGTH - prefix.length - 1);
  return prefix + text.slice(0, available) + '…';
}

/** Matches `@everyone`/`@here`, case-insensitive, not preceded by a word character or another `@` (so
 * "email@everyone.com" isn't touched) and word-bounded after the keyword (so "@everyoneelse" is NOT
 * neutralized — "else" continues the word run with no boundary between "everyone" and "else"). */
const MASS_MENTION_PATTERN = /(?<![\w@])@(everyone|here)\b/gi;

/**
 * Breaks `@everyone`/`@here` with a zero-width space (`@` + U+200B + `everyone`/`here`) so the literal text can
 * never re-trigger a mass ping if it's ever echoed anywhere else — in addition to (never instead of) setting
 * `allowedMentions: { parse: [] }` on the actual Discord send.
 */
export function neutralizeMassMentions(text: string): string {
  return text.replace(MASS_MENTION_PATTERN, (_match, word: string) => `@\u200b${word}`);
}

/**
 * Escapes characters Discord's markdown parser treats specially, so relayed Twitch chat text always renders as
 * literal text in Discord: backslash, asterisk, underscore, tilde, backtick, pipe, greater-than, and the square
 * brackets that form masked-link syntax (`[text](url)`) — escaping both brackets means `[text](url)` can never
 * parse as a clickable link, closing off a phishing vector where a masked link shows friendly text but points
 * somewhere else. Backslash MUST be escaped first — escaping it after the others would double-escape the
 * backslashes those steps just added.
 */
export function escapeDiscordMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/\|/g, '\\|')
    .replace(/>/g, '\\>')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** Matches a leading Discord header (`#`/`##`/`###`) or subtext (`-#`) marker followed by whitespace, right at
 * the start of the string only — a `#` appearing mid-line is never a header marker to Discord's parser and must
 * not be touched. */
const LEADING_HEADER_MARKER_PATTERN = /^(-#|#{1,3})(\s)/;

/**
 * Escapes just the leading header/subtext marker (`#`, `##`, `###`, `-#`) at the very start of `text`, so a
 * relayed Twitch message can never render as an oversized Discord header or subtext line — each character of the
 * matched marker gets its own backslash (e.g. `# ` -> `\# `, `-# ` -> `\-\# `). Everything after the marker,
 * including any `#` that appears later in the string, is left untouched.
 */
export function escapeLeadingHeaderMarker(text: string): string {
  const match = text.match(LEADING_HEADER_MARKER_PATTERN);
  if (!match) return text;
  const marker = match[1];
  const escapedMarker = marker
    .split('')
    .map((ch) => `\\${ch}`)
    .join('');
  return escapedMarker + text.slice(marker.length);
}

/**
 * Formats a Twitch chat message for relay into Discord (via the bridge webhook): neutralizes `@everyone`/`@here`
 * first (so the zero-width-space insertion isn't itself escaped by the next step), then escapes markdown
 * (including masked-link brackets), then escapes a leading header/subtext marker, then truncates to
 * `TWITCH_TO_DISCORD_MAX_LENGTH` — in that order, so the hard Discord content limit is never exceeded by text
 * that grows during escaping. Header-marker escaping runs AFTER markdown escaping (which never touches `#`/`-`,
 * so the leading characters it sees are unchanged from the original) and is the last step that inserts new
 * backslashes, so nothing it inserts is ever re-processed by an earlier `.replace()` call.
 */
export function formatTwitchToDiscord(text: string): string {
  const neutralized = neutralizeMassMentions(text);
  const escaped = escapeDiscordMarkdown(neutralized);
  const headerEscaped = escapeLeadingHeaderMarker(escaped);
  if (headerEscaped.length <= TWITCH_TO_DISCORD_MAX_LENGTH) return headerEscaped;
  return headerEscaped.slice(0, TWITCH_TO_DISCORD_MAX_LENGTH - 1) + '…';
}

/** True if `text` starts with any of the given prefixes (case-sensitive, exact prefix match). Used for the
 * Discord-side "is this a bot command, don't relay it" check (the bot's message prefix and a literal `/`). */
export function startsWithAny(text: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

/** Matches "discord" or "clyde" case-insensitively, anywhere in a string. Discord rejects any webhook `username`
 * containing either substring (case-insensitive) — the whole send fails silently, so a Twitch display name that
 * happens to contain one of these (e.g. `DiscordFan99`) must never reach `.send()` unmodified. */
const RESERVED_WEBHOOK_USERNAME_SUBSTRINGS = /(discord|clyde)/gi;

/** U+200B, built from a code point (not a literal character in source) so it can never be mistaken for a plain
 * space by an editor/linter — same neutralization technique `neutralizeMassMentions` above uses for
 * `@everyone`/`@here`. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Builds a safe Discord webhook `username` for a relayed Twitch chatter's display name: neutralizes any
 * case-insensitive "discord"/"clyde" occurrence by inserting a zero-width space after the match's first
 * character (preserving original casing and readability), trims whitespace (falling back to `'Twitch viewer'`
 * if that leaves nothing), appends `' (Twitch)'`, and finally truncates to Discord's 80-character webhook
 * username cap — applied last, after the suffix, so the cap always holds on the actual string sent to Discord.
 */
export function toBridgeWebhookUsername(displayName: string): string {
  const neutralized = displayName.replace(
    RESERVED_WEBHOOK_USERNAME_SUBSTRINGS,
    (match) => `${match.slice(0, 1)}${ZERO_WIDTH_SPACE}${match.slice(1)}`,
  );
  const trimmed = neutralized.trim();
  const base = trimmed.length > 0 ? trimmed : 'Twitch viewer';
  return `${base} (Twitch)`.slice(0, 80);
}
