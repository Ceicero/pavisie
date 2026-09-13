import { validateUserRegex } from '@pavisie/core';
import { isValidLuhn } from './luhn';

export interface RedactionPattern {
  name: string;
  regex: RegExp;
  /**
   * Optional extra check run against the raw matched text before a match is actually redacted. Used by
   * `credit_card` to require a passing Luhn checksum -- without it, the regex alone matches any 13-19
   * digit run, which includes every Discord snowflake id (channel/user/role/message/guild ids are all
   * 17-19 digits). When `validate` returns false the match is left untouched in the output.
   */
  validate?: (matchedText: string) => boolean;
}

/**
 * Default redaction rules (SPEC.md section D / ARCHITECTURE.md's logging task: emails, phone numbers,
 * Discord tokens, credit-card-like numbers, IPv4 addresses). Applied to every stored/displayed log
 * payload regardless of guild config; admins can additionally configure their own patterns
 * (`config.redactionPatterns`, validated with `validateUserRegex` at save time in the `/logs redact add`
 * command and the API route).
 */
export const DEFAULT_REDACTION_PATTERNS: RedactionPattern[] = [
  { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  // Loose international-ish phone matcher: optional leading +CC, then 3-3-4 or similar digit groupings.
  { name: 'phone', regex: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g },
  // Discord bot/user tokens: base64url id segment, base64url timestamp segment, base64url HMAC segment.
  { name: 'discord_token', regex: /\b[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,40}\b/g },
  // Visa/Mastercard/Amex/Discover-shaped digit runs, optionally grouped with spaces or dashes. The separator
  // only ever appears *between* digits (never trailing) so the match can't swallow a following space/word.
  // A 13-19 digit run is also exactly the shape of a Discord snowflake id (17-19 digits), so a candidate
  // match is only ever redacted if it additionally passes the Luhn checksum real card numbers satisfy --
  // see `validate`. Discord markup (mentions, emoji, timestamps, message links) is masked out entirely
  // before this pattern ever sees the text; see `maskDiscordMarkup`.
  { name: 'credit_card', regex: /\b\d(?:[ -]?\d){12,18}\b/g, validate: (match) => isValidLuhn(match) },
  {
    name: 'ipv4',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
];

/**
 * Discord markup whose numeric id must never be touched by redaction: channel/user/role mentions,
 * (animated) custom emoji, timestamp markup, and message/channel links. All of these embed a bare
 * snowflake id as part of syntax that Discord's client parses structurally -- redacting the id (or
 * even just part of it) leaves broken, unresolvable markup in the rendered log, e.g. a channel
 * mention like `<#1539837857747832943>` rendering as `<#[redacted:credit_card]>`. This is matched
 * and masked out *before* any redaction pattern (default or custom) runs, so no pattern -- present or
 * future -- can reach inside this syntax.
 */
const DISCORD_MARKUP_REGEX =
  /<(?:#\d{17,20}|@!?\d{17,20}|@&\d{17,20}|a?:[A-Za-z0-9_~]+:\d{17,20}|t:-?\d{1,13}(?::[tTdDfFR])?)>|https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(?:@me|\d{17,20})\/\d{17,20}(?:\/\d{17,20})?/g;

// Plain-ASCII delimiters that can't appear in real Discord markup (which is only ever `<...>` or a
// `https://discord.com/channels/...` link) and aren't matched by any character class the default or
// custom redaction patterns use, so they're safe as an opaque wrapper for masked-out markup spans.
const MARKUP_TOKEN_PREFIX = 'DISCORD_MARKUP_';
const MARKUP_TOKEN_REGEX = /DISCORD_MARKUP_(\d+)/g;

function markupToken(index: number): string {
  return `${MARKUP_TOKEN_PREFIX}${index}`;
}

/**
 * Temporarily swaps every Discord-markup span in `text` for an opaque placeholder token (so no
 * redaction pattern's regex can match inside it), returning the masked text plus an `unmask` function
 * that restores the original spans verbatim once redaction has run.
 */
function maskDiscordMarkup(text: string): { masked: string; unmask: (input: string) => string } {
  const originals: string[] = [];
  DISCORD_MARKUP_REGEX.lastIndex = 0;
  const masked = text.replace(DISCORD_MARKUP_REGEX, (match) => {
    const token = markupToken(originals.length);
    originals.push(match);
    return token;
  });
  return {
    masked,
    unmask: (input: string) =>
      input.replace(MARKUP_TOKEN_REGEX, (_full, index: string) => originals[Number(index)] ?? ''),
  };
}

function placeholderFor(name: string): string {
  return `[redacted:${name}]`;
}

/**
 * Runs a single pattern's regex against `text`, redacting every match that also passes the pattern's
 * `validate` check (if any); matches that fail `validate` are left in the output untouched. Returns the
 * resulting text plus whether at least one match was actually redacted.
 */
function applyPattern(text: string, pattern: RedactionPattern): { text: string; matched: boolean } {
  let matched = false;
  pattern.regex.lastIndex = 0;
  const replaced = text.replace(pattern.regex, (match: string) => {
    if (pattern.validate && !pattern.validate(match)) {
      return match;
    }
    matched = true;
    return placeholderFor(pattern.name);
  });
  return { text: replaced, matched };
}

/**
 * Compiles a guild's custom redaction pattern strings into `RedactionPattern`s, skipping any that fail
 * `validateUserRegex` (defense in depth -- patterns are already validated when saved via `/logs redact add` or
 * the dashboard/API, but config can in principle be edited elsewhere) and naming them `custom1`, `custom2`, ...
 * in the order given.
 */
export function compileCustomPatterns(patterns: string[]): RedactionPattern[] {
  const out: RedactionPattern[] = [];
  patterns.forEach((pattern, index) => {
    const check = validateUserRegex(pattern);
    if (!check.ok) return;
    try {
      out.push({ name: `custom${index + 1}`, regex: new RegExp(pattern, 'gi') });
    } catch {
      // validateUserRegex already confirmed this compiles; unreachable in practice, but never let a bad
      // pattern crash the logging pipeline.
    }
  });
  return out;
}

function allPatterns(customPatterns: string[]): RedactionPattern[] {
  return [...DEFAULT_REDACTION_PATTERNS, ...compileCustomPatterns(customPatterns)];
}

/** Replaces every match of every default + custom pattern in `text` with a `[redacted:<name>]` placeholder. */
export function redactText(text: string, customPatterns: string[] = []): string {
  const { masked, unmask } = maskDiscordMarkup(text);
  let result = masked;
  for (const pattern of allPatterns(customPatterns)) {
    result = applyPattern(result, pattern).text;
  }
  return unmask(result);
}

export interface RedactionTestMatch {
  name: string;
  matched: boolean;
}

export interface RedactionTestResult {
  redacted: string;
  matches: RedactionTestMatch[];
}

/** Runs every default + custom pattern against `text`, returning the redacted text and which patterns fired -- used by `/logs redact list`'s live preview, the dashboard test box, and `POST .../redaction/test`. */
export function testRedactionPatterns(text: string, customPatterns: string[] = []): RedactionTestResult {
  const patterns = allPatterns(customPatterns);
  const { masked, unmask } = maskDiscordMarkup(text);
  const matches: RedactionTestMatch[] = [];
  let redacted = masked;

  for (const pattern of patterns) {
    const { text: next, matched } = applyPattern(redacted, pattern);
    matches.push({ name: pattern.name, matched });
    redacted = next;
  }

  return { redacted: unmask(redacted), matches };
}
