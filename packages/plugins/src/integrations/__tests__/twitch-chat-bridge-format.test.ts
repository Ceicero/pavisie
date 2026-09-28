import { describe, expect, it } from 'vitest';
import {
  DISCORD_TO_TWITCH_MAX_LENGTH,
  TWITCH_TO_DISCORD_MAX_LENGTH,
  escapeDiscordMarkdown,
  escapeLeadingHeaderMarker,
  formatDiscordToTwitch,
  formatTwitchToDiscord,
  neutralizeMassMentions,
  resolveMentionsToPlainNames,
  startsWithAny,
  toBridgeWebhookUsername,
} from '../twitch-chat/bridge-format';

describe('resolveMentionsToPlainNames', () => {
  it('resolves a plain user mention <@id>', () => {
    expect(resolveMentionsToPlainNames('hi <@111>', [{ id: '111', name: 'Ada' }], [], [])).toBe('hi @Ada');
  });

  it('resolves a nickname-mention variant <@!id> the same as <@id>', () => {
    expect(resolveMentionsToPlainNames('hi <@!111>', [{ id: '111', name: 'Ada' }], [], [])).toBe('hi @Ada');
  });

  it('resolves a role mention <@&id>', () => {
    expect(resolveMentionsToPlainNames('ping <@&222>', [], [{ id: '222', name: 'Mods' }], [])).toBe('ping @Mods');
  });

  it('resolves a channel mention <#id>', () => {
    expect(resolveMentionsToPlainNames('see <#333>', [], [], [{ id: '333', name: 'general' }])).toBe('see #general');
  });

  it('resolves multiple mixed mentions in one string', () => {
    const result = resolveMentionsToPlainNames(
      '<@111> and <@&222> in <#333>',
      [{ id: '111', name: 'Ada' }],
      [{ id: '222', name: 'Mods' }],
      [{ id: '333', name: 'general' }],
    );
    expect(result).toBe('@Ada and @Mods in #general');
  });

  it('replaces an unresolved mention id with a generic placeholder rather than leaving the raw id', () => {
    expect(resolveMentionsToPlainNames('hi <@999>', [], [], [])).toBe('hi @user');
    expect(resolveMentionsToPlainNames('ping <@&999>', [], [], [])).toBe('ping @role');
    expect(resolveMentionsToPlainNames('see <#999>', [], [], [])).toBe('see #channel');
  });

  it('leaves plain text with no mention tokens untouched', () => {
    expect(resolveMentionsToPlainNames('no mentions here', [], [], [])).toBe('no mentions here');
  });
});

describe('formatDiscordToTwitch', () => {
  const base = { displayName: 'Brandon', hasAttachment: false, userMentions: [], roleMentions: [], channelMentions: [] };

  it('prefixes with [Discord] displayName: ', () => {
    expect(formatDiscordToTwitch({ ...base, content: 'hello there' })).toBe('[Discord] Brandon: hello there');
  });

  it('collapses newlines to a single space and trims', () => {
    expect(formatDiscordToTwitch({ ...base, content: '  line one\nline two\r\nline three  ' })).toBe(
      '[Discord] Brandon: line one line two line three',
    );
  });

  it('appends [attachment] with a leading space when there is remaining text', () => {
    expect(formatDiscordToTwitch({ ...base, content: 'check this out', hasAttachment: true })).toBe(
      '[Discord] Brandon: check this out [attachment]',
    );
  });

  it('appends just [attachment] with no leading space when the text is empty', () => {
    expect(formatDiscordToTwitch({ ...base, content: '', hasAttachment: true })).toBe('[Discord] Brandon: [attachment]');
  });

  it('resolves mentions before formatting', () => {
    const result = formatDiscordToTwitch({
      ...base,
      content: 'hey <@111>',
      userMentions: [{ id: '111', name: 'Ada' }],
    });
    expect(result).toBe('[Discord] Brandon: hey @Ada');
  });

  it('does not truncate when the full string is exactly at the max length', () => {
    const prefix = '[Discord] Brandon: ';
    const text = 'x'.repeat(DISCORD_TO_TWITCH_MAX_LENGTH - prefix.length);
    const result = formatDiscordToTwitch({ ...base, content: text });
    expect(result.length).toBe(DISCORD_TO_TWITCH_MAX_LENGTH);
    expect(result.endsWith('…')).toBe(false);
  });

  it('truncates and appends a single ellipsis when the full string exceeds the max length by one character', () => {
    const prefix = '[Discord] Brandon: ';
    const text = 'x'.repeat(DISCORD_TO_TWITCH_MAX_LENGTH - prefix.length + 1);
    const result = formatDiscordToTwitch({ ...base, content: text });
    expect(result.length).toBe(DISCORD_TO_TWITCH_MAX_LENGTH);
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith(prefix)).toBe(true);
  });

  it('never truncates the prefix itself, even for a very long displayName', () => {
    const longName = 'N'.repeat(600);
    const result = formatDiscordToTwitch({ ...base, displayName: longName, content: 'hi' });
    expect(result.startsWith(`[Discord] ${longName}: `)).toBe(true);
  });
});

describe('neutralizeMassMentions', () => {
  it('breaks @everyone with a zero-width space', () => {
    expect(neutralizeMassMentions('@everyone check this out')).toBe('@​everyone check this out');
  });

  it('breaks @here', () => {
    expect(neutralizeMassMentions('@here')).toBe('@​here');
  });

  it('is case-insensitive', () => {
    expect(neutralizeMassMentions('@EVERYONE')).toBe('@​EVERYONE');
  });

  it('does not touch @everyoneelse (no word boundary after "everyone")', () => {
    expect(neutralizeMassMentions('@everyoneelse')).toBe('@everyoneelse');
  });

  it('does not touch an email-shaped token like name@everyone.com', () => {
    expect(neutralizeMassMentions('name@everyone.com')).toBe('name@everyone.com');
  });

  it('leaves text with no mass mention untouched', () => {
    expect(neutralizeMassMentions('hello world')).toBe('hello world');
  });
});

describe('escapeDiscordMarkdown', () => {
  it('escapes backslash first, so escaping other characters does not double-escape it', () => {
    // A literal backslash followed by an asterisk: the backslash must become \\ (not re-escaped again when the
    // asterisk step runs), and the asterisk becomes \*.
    expect(escapeDiscordMarkdown('\\*')).toBe('\\\\\\*');
  });

  it('escapes every special character', () => {
    expect(escapeDiscordMarkdown('*_~`|>')).toBe('\\*\\_\\~\\`\\|\\>');
  });

  it('escapes square brackets so masked-link syntax can never form', () => {
    expect(escapeDiscordMarkdown('[free nitro](https://phish.example)')).toBe(
      '\\[free nitro\\](https://phish.example)',
    );
  });

  it('leaves plain text untouched', () => {
    expect(escapeDiscordMarkdown('hello world 123')).toBe('hello world 123');
  });
});

describe('escapeLeadingHeaderMarker', () => {
  it('escapes a leading "# " header marker', () => {
    expect(escapeLeadingHeaderMarker('# big header')).toBe('\\# big header');
  });

  it('escapes a leading "## " header marker', () => {
    expect(escapeLeadingHeaderMarker('## medium header')).toBe('\\#\\# medium header');
  });

  it('escapes a leading "### " header marker', () => {
    expect(escapeLeadingHeaderMarker('### small header')).toBe('\\#\\#\\# small header');
  });

  it('escapes a leading "-# " subtext marker', () => {
    expect(escapeLeadingHeaderMarker('-# subtext')).toBe('\\-\\# subtext');
  });

  it('does not touch a "#" that appears mid-line rather than at the start', () => {
    expect(escapeLeadingHeaderMarker('see the #general channel')).toBe('see the #general channel');
  });

  it('does not touch a bare "#" with no following whitespace at the start', () => {
    expect(escapeLeadingHeaderMarker('#hashtag no space')).toBe('#hashtag no space');
  });

  it('leaves text with no marker untouched', () => {
    expect(escapeLeadingHeaderMarker('hello world')).toBe('hello world');
  });
});

describe('formatTwitchToDiscord', () => {
  it('neutralizes mass mentions and escapes markdown', () => {
    expect(formatTwitchToDiscord('@everyone *bold*')).toBe('@​everyone \\*bold\\*');
  });

  it('does not truncate when exactly at the max length', () => {
    const text = 'x'.repeat(TWITCH_TO_DISCORD_MAX_LENGTH);
    const result = formatTwitchToDiscord(text);
    expect(result.length).toBe(TWITCH_TO_DISCORD_MAX_LENGTH);
    expect(result.endsWith('…')).toBe(false);
  });

  it('truncates and replaces the last character with an ellipsis when one character over the max', () => {
    const text = 'x'.repeat(TWITCH_TO_DISCORD_MAX_LENGTH + 1);
    const result = formatTwitchToDiscord(text);
    expect(result.length).toBe(TWITCH_TO_DISCORD_MAX_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });

  it('escaping (which can grow the string) happens before truncation, so the hard Discord limit is never exceeded', () => {
    // Every character escapes to two characters, so the escaped length would be far over the limit if
    // truncation ran before escaping instead of after.
    const text = '*'.repeat(TWITCH_TO_DISCORD_MAX_LENGTH);
    const result = formatTwitchToDiscord(text);
    expect(result.length).toBeLessThanOrEqual(TWITCH_TO_DISCORD_MAX_LENGTH);
  });

  it('a masked link cannot render — both brackets are escaped and no live [text](url) pair survives', () => {
    const result = formatTwitchToDiscord('[free nitro](https://phish.example)');
    expect(result).toContain('\\[');
    expect(result).toContain('\\]');
    // A markdown-parseable masked link needs an UNESCAPED `]` immediately followed by `(` — that pair must not
    // survive, even though the parens themselves are untouched.
    expect(result).not.toMatch(/(?<!\\)\]\(/);
  });

  it.each([
    ['# ', '# announcing something'],
    ['## ', '## announcing something'],
    ['### ', '### announcing something'],
    ['-# ', '-# announcing something'],
  ])('neutralizes the %s header/subtext marker at the start of a message', (_marker, input) => {
    const result = formatTwitchToDiscord(input);
    // No unescaped leading header/subtext marker survives.
    expect(result).not.toMatch(/^(-#|#{1,3})\s/);
    expect(result).toContain('announcing something');
  });

  it('does not touch a "#" appearing mid-line, only a leading one', () => {
    const result = formatTwitchToDiscord('check out #general for more');
    expect(result).toBe('check out #general for more');
  });
});

describe('toBridgeWebhookUsername', () => {
  // Built from a code point, not a literal character in source, so it can never be silently lost/altered by an
  // editor or encoding change — same technique `bridge-format.ts` itself uses for this character.
  const ZWSP = String.fromCharCode(0x200b);

  it('neutralizes a "discord" occurrence with a zero-width space after its first character', () => {
    expect(toBridgeWebhookUsername('DiscordFan99')).toBe(`D${ZWSP}iscordFan99 (Twitch)`);
  });

  it('neutralizes an uppercase "CLYDE" occurrence', () => {
    expect(toBridgeWebhookUsername('CLYDE_the_bot')).toBe(`C${ZWSP}LYDE_the_bot (Twitch)`);
  });

  it('neutralizes mixed-case occurrences of both words inside a longer name', () => {
    const result = toBridgeWebhookUsername('xXDiscordClydeFanXx');
    expect(result).not.toMatch(/discord/i);
    expect(result).not.toMatch(/clyde/i);
    // Readability preserved: stripping zero-width spaces recovers the original text.
    expect(result.split(ZWSP).join('')).toBe('xXDiscordClydeFanXx (Twitch)');
  });

  it('falls back to "Twitch viewer" for an empty display name', () => {
    expect(toBridgeWebhookUsername('')).toBe('Twitch viewer (Twitch)');
  });

  it('falls back to "Twitch viewer" for a whitespace-only display name', () => {
    expect(toBridgeWebhookUsername('   ')).toBe('Twitch viewer (Twitch)');
  });

  it('caps the final result (name + suffix) at 80 characters for a very long display name', () => {
    const longName = 'N'.repeat(200);
    const result = toBridgeWebhookUsername(longName);
    expect(result.length).toBe(80);
  });

  it('keeps the " (Twitch)" suffix intact when the name is long but still fits under the cap once suffixed', () => {
    const name = 'N'.repeat(65); // 65 + ' (Twitch)' (9) = 74, comfortably under 80
    const result = toBridgeWebhookUsername(name);
    expect(result).toBe(`${name} (Twitch)`);
    expect(result.length).toBeLessThanOrEqual(80);
  });
});

describe('startsWithAny', () => {
  it('returns true when the text starts with one of the given prefixes', () => {
    expect(startsWithAny('+help', ['+', '/'])).toBe(true);
    expect(startsWithAny('/ban', ['+', '/'])).toBe(true);
  });

  it('returns false when the text starts with none of the given prefixes', () => {
    expect(startsWithAny('hello', ['+', '/'])).toBe(false);
  });

  it('is case-sensitive and exact-prefix', () => {
    expect(startsWithAny('Hello', ['hello'])).toBe(false);
  });
});
