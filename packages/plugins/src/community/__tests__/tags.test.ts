import { describe, expect, it } from 'vitest';
import {
  TAG_NAME_RE,
  isValidTagName,
  matchesTrigger,
  normalizeTagName,
  parseStoredTagEmbed,
  renderTag,
  tagBodySchema,
  tagTriggerCooldownKey,
  tagTriggersCacheKey,
} from '../tags';
import type { TemplateVars } from '../../roles/engine';

const vars: TemplateVars = {
  user: 'brandon',
  'user.tag': 'brandon#0',
  'user.id': '123',
  server: 'Pavisie HQ',
  memberCount: 42,
  mention: '<@123>',
};

describe('tag names', () => {
  it('accepts lowercase letters, digits, dashes and underscores up to 32 chars', () => {
    for (const ok of ['rules', 'lfg', 'how-to_verify', 'a', '0tag', 'x'.repeat(32)]) {
      expect(TAG_NAME_RE.test(ok), ok).toBe(true);
    }
  });

  it('rejects uppercase, spaces, leading punctuation, and > 32 chars', () => {
    for (const bad of ['Rules', 'my tag', '-lead', '_lead', '', 'x'.repeat(33), 'tag!']) {
      expect(isValidTagName(bad), bad).toBe(false);
    }
  });

  it('normalizeTagName trims and lowercases', () => {
    expect(normalizeTagName('  Rules ')).toBe('rules');
  });
});

describe('matchesTrigger', () => {
  it('EXACT matches the whole message, case-insensitive and trimmed', () => {
    const tag = { triggerMode: 'EXACT' as const, trigger: 'How do I verify' };
    expect(matchesTrigger('  how do i VERIFY ', tag)).toBe(true);
    expect(matchesTrigger('how do i verify?', tag)).toBe(false);
    expect(matchesTrigger('so how do i verify', tag)).toBe(false);
  });

  it('CONTAINS matches only as a whole word/phrase', () => {
    const tag = { triggerMode: 'CONTAINS' as const, trigger: 'verify' };
    expect(matchesTrigger('hey, how do I verify?', tag)).toBe(true);
    expect(matchesTrigger('VERIFY', tag)).toBe(true);
    expect(matchesTrigger('the verifying process', tag)).toBe(false);
    expect(matchesTrigger('unverify me', tag)).toBe(false);
  });

  it('CONTAINS escapes regex specials in the trigger', () => {
    const tag = { triggerMode: 'CONTAINS' as const, trigger: 'c++ (beta).*' };
    expect(matchesTrigger('is c++ (beta).* out yet', tag)).toBe(true);
    expect(matchesTrigger('is cxx (beta) x out yet', tag)).toBe(false);
  });

  it('STARTS_WITH requires the phrase at the start followed by end or a non-word char', () => {
    const tag = { triggerMode: 'STARTS_WITH' as const, trigger: '!rules' };
    expect(matchesTrigger('!rules', tag)).toBe(true);
    expect(matchesTrigger('!Rules please', tag)).toBe(true);
    expect(matchesTrigger('!rulesx', tag)).toBe(false);
    expect(matchesTrigger('please !rules', tag)).toBe(false);
  });

  it('truncates input to 2000 chars before matching', () => {
    const tag = { triggerMode: 'CONTAINS' as const, trigger: 'needle' };
    const long = `${'a '.repeat(1100)}needle`;
    expect(long.length).toBeGreaterThan(2000);
    expect(matchesTrigger(long, tag)).toBe(false);
    expect(matchesTrigger(`needle ${'a '.repeat(1100)}`, tag)).toBe(true);
  });

  it('never matches NONE mode or an empty trigger', () => {
    expect(matchesTrigger('anything', { triggerMode: 'NONE', trigger: 'anything' })).toBe(false);
    expect(matchesTrigger('anything', { triggerMode: 'EXACT', trigger: '' })).toBe(false);
    expect(matchesTrigger('', { triggerMode: 'EXACT', trigger: 'x' })).toBe(false);
  });
});

describe('renderTag', () => {
  it('substitutes the fixed variable set and leaves unknown tokens literal', () => {
    const rendered = renderTag(
      { content: 'Read {server} rules, {user}. {unknown} {process.env}', embed: null },
      vars,
    );
    expect(rendered.content).toBe('Read Pavisie HQ rules, brandon. {unknown} {process.env}');
    expect(rendered.embeds).toBeUndefined();
  });

  it('always sets allowedMentions.parse = [] and only whitelists the invoker when {mention} is used', () => {
    const plain = renderTag({ content: '@everyone hi', embed: null }, vars, '123');
    expect(plain.allowedMentions).toEqual({ parse: [] });

    const withMention = renderTag({ content: 'hi {mention}', embed: null }, vars, '123');
    expect(withMention.content).toBe('hi <@123>');
    expect(withMention.allowedMentions).toEqual({ parse: [], users: ['123'] });

    const noInvoker = renderTag({ content: 'hi {mention}', embed: null }, vars);
    expect(noInvoker.allowedMentions).toEqual({ parse: [] });
  });

  it('builds a sanitised embed from the stored payload', () => {
    const rendered = renderTag(
      {
        content: null,
        embed: {
          title: 'Welcome to {server}',
          description: 'Hey @everyone, {user} joined. <@&999>',
          colorHex: '#5865F2',
          footer: 'members: {memberCount}',
          imageUrl: 'https://example.com/a.png',
        },
      },
      vars,
    );
    expect(rendered.content).toBeUndefined();
    expect(rendered.embeds).toHaveLength(1);
    const json = rendered.embeds![0].toJSON();
    expect(json.title).toBe('Welcome to Pavisie HQ');
    expect(json.description).toBe('Hey [mention], brandon joined. [mention]');
    expect(json.footer?.text).toBe('members: 42');
    expect(json.color).toBe(0x5865f2);
    expect(json.image?.url).toBe('https://example.com/a.png');
    expect(rendered.allowedMentions).toEqual({ parse: [] });
  });

  it('ignores an empty or malformed stored embed', () => {
    expect(parseStoredTagEmbed(null)).toBeUndefined();
    expect(parseStoredTagEmbed('nope')).toBeUndefined();
    expect(parseStoredTagEmbed({ colorHex: '#ffffff' })).toBeUndefined();
    expect(parseStoredTagEmbed({ title: 5 })).toBeUndefined();
    expect(parseStoredTagEmbed({ title: 'ok' })).toEqual({ title: 'ok' });
  });
});

describe('tagBodySchema', () => {
  it('normalises the name and accepts a plain-content tag', () => {
    const parsed = tagBodySchema.parse({ name: '  Rules ', content: 'Read the rules' });
    expect(parsed).toMatchObject({
      name: 'rules',
      content: 'Read the rules',
      triggerMode: 'NONE',
      triggerChannelIds: [],
      staffOnly: false,
    });
    expect(parsed.embed).toBeUndefined();
    expect(parsed.trigger).toBeUndefined();
  });

  it('rejects an invalid name', () => {
    expect(tagBodySchema.safeParse({ name: 'Bad Name', content: 'x' }).success).toBe(false);
    expect(tagBodySchema.safeParse({ name: '-x', content: 'x' }).success).toBe(false);
  });

  it('requires content or a non-empty embed', () => {
    expect(tagBodySchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(tagBodySchema.safeParse({ name: 'x', content: '   ' }).success).toBe(false);
    expect(tagBodySchema.safeParse({ name: 'x', embed: { colorHex: '#ffffff' } }).success).toBe(false);
    expect(tagBodySchema.safeParse({ name: 'x', embed: { title: 'Hi' } }).success).toBe(true);
  });

  it('requires a trigger phrase (>= 2 chars) iff triggerMode != NONE', () => {
    expect(tagBodySchema.safeParse({ name: 'x', content: 'y', triggerMode: 'CONTAINS' }).success).toBe(false);
    expect(
      tagBodySchema.safeParse({ name: 'x', content: 'y', triggerMode: 'CONTAINS', trigger: 'a' }).success,
    ).toBe(false);
    expect(
      tagBodySchema.safeParse({ name: 'x', content: 'y', triggerMode: 'CONTAINS', trigger: 'ab' }).success,
    ).toBe(true);
    // A phrase with NONE is tolerated (kept for later) but never matched.
    expect(
      tagBodySchema.safeParse({ name: 'x', content: 'y', triggerMode: 'NONE', trigger: 'zz' }).success,
    ).toBe(true);
  });

  it('caps content at 2000 chars and validates embed color / image URL', () => {
    expect(tagBodySchema.safeParse({ name: 'x', content: 'a'.repeat(2001) }).success).toBe(false);
    expect(tagBodySchema.safeParse({ name: 'x', embed: { title: 't', colorHex: 'red' } }).success).toBe(
      false,
    );
    expect(
      tagBodySchema.safeParse({ name: 'x', embed: { title: 't', imageUrl: 'ftp://example.com/x.png' } })
        .success,
    ).toBe(false);
    expect(
      tagBodySchema.safeParse({ name: 'x', embed: { title: 't', imageUrl: 'https://example.com/x.png' } })
        .success,
    ).toBe(true);
  });
});

describe('redis keys', () => {
  it('builds namespaced keys', () => {
    expect(tagTriggersCacheKey('g1')).toMatch(/community:tag-triggers:g1$/);
    expect(tagTriggerCooldownKey('g1', 't1')).toMatch(/community:tag-cd:g1:t1$/);
  });
});
