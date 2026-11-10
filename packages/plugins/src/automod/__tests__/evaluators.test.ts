import { describe, expect, it } from 'vitest';
import {
  evaluateMessageRule,
  evaluateJoinRule,
  testRuleWithText,
  MemoryWindowStore,
  type NormalizedJoin,
  type NormalizedMessage,
} from '../engine';
import type { AutomodRuleConfig } from '../schemas';

const BASE_MESSAGE: NormalizedMessage = {
  guildId: 'g1',
  channelId: 'c1',
  messageId: 'm1',
  authorId: 'u1',
  authorBot: false,
  content: 'hello world',
  userMentionCount: 0,
  roleMentionCount: 0,
  everyoneMentioned: false,
  attachments: [],
  channelNsfw: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function msg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { ...BASE_MESSAGE, ...overrides };
}

const BASE_JOIN: NormalizedJoin = {
  guildId: 'g1',
  userId: 'u1',
  userBot: false,
  accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
  joinedAt: new Date('2026-01-01T00:00:00Z'),
};

function join(overrides: Partial<NormalizedJoin> = {}): NormalizedJoin {
  return { ...BASE_JOIN, ...overrides };
}

describe('MESSAGE_FREQUENCY', () => {
  const config: AutomodRuleConfig = { type: 'MESSAGE_FREQUENCY', maxMessages: 3, windowSeconds: 10 };

  it('does not match under the limit', async () => {
    const windowStore = new MemoryWindowStore();
    for (let i = 0; i < 3; i += 1) {
      const result = await evaluateMessageRule(config, { message: msg({ messageId: `m${i}` }), windowStore });
      expect(result.matched).toBe(false);
    }
  });

  it('matches once the limit is exceeded within the window', async () => {
    const windowStore = new MemoryWindowStore();
    let last;
    for (let i = 0; i < 4; i += 1) {
      last = await evaluateMessageRule(config, { message: msg({ messageId: `m${i}` }), windowStore });
    }
    expect(last?.matched).toBe(true);
  });

  it('says the allowance is exclusive, so "3" cannot be read as a trigger point', async () => {
    const windowStore = new MemoryWindowStore();
    let last;
    for (let i = 0; i < 4; i += 1) {
      last = await evaluateMessageRule(config, { message: msg({ messageId: `m${i}` }), windowStore });
    }
    expect(last?.reason).toContain('flags above 3');
  });

  it('is per-author (a different user is not affected)', async () => {
    const windowStore = new MemoryWindowStore();
    for (let i = 0; i < 4; i += 1) {
      await evaluateMessageRule(config, {
        message: msg({ authorId: 'u1', messageId: `a${i}` }),
        windowStore,
      });
    }
    const result = await evaluateMessageRule(config, {
      message: msg({ authorId: 'u2', messageId: 'b0' }),
      windowStore,
    });
    expect(result.matched).toBe(false);
  });
});

describe('DUPLICATE_MESSAGES', () => {
  const config: AutomodRuleConfig = { type: 'DUPLICATE_MESSAGES', maxDuplicates: 3, windowSeconds: 60 };

  it('ignores empty content', async () => {
    const windowStore = new MemoryWindowStore();
    const result = await evaluateMessageRule(config, { message: msg({ content: '   ' }), windowStore });
    expect(result.matched).toBe(false);
  });

  it('matches after the same content repeats maxDuplicates times', async () => {
    const windowStore = new MemoryWindowStore();
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await evaluateMessageRule(config, {
        message: msg({ content: 'spam spam spam', messageId: `m${i}` }),
        windowStore,
      });
    }
    expect(last?.matched).toBe(true);
  });

  it('is case/whitespace-normalized', async () => {
    const windowStore = new MemoryWindowStore();
    const variants = ['SPAM', 'spam', '  spam  '];
    let last;
    for (const [i, content] of variants.entries()) {
      last = await evaluateMessageRule(config, {
        message: msg({ content, messageId: `m${i}` }),
        windowStore,
      });
    }
    expect(last?.matched).toBe(true);
  });

  it('does not confuse two different messages', async () => {
    const windowStore = new MemoryWindowStore();
    await evaluateMessageRule(config, { message: msg({ content: 'aaa', messageId: 'm0' }), windowStore });
    await evaluateMessageRule(config, { message: msg({ content: 'bbb', messageId: 'm1' }), windowStore });
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'ccc', messageId: 'm2' }),
      windowStore,
    });
    expect(result.matched).toBe(false);
  });
});

describe('MENTION_SPAM', () => {
  const config: AutomodRuleConfig = { type: 'MENTION_SPAM', maxMentions: 5, includeRoleMentions: true };

  it('does not match below the threshold', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ userMentionCount: 2 }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });

  it('matches at/above the threshold combining users + roles', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ userMentionCount: 3, roleMentionCount: 2 }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('ignores role mentions when includeRoleMentions is false', async () => {
    const cfg: AutomodRuleConfig = { ...config, includeRoleMentions: false };
    const result = await evaluateMessageRule(cfg, {
      message: msg({ userMentionCount: 2, roleMentionCount: 10 }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });

  it('says the threshold is inclusive, so "5" cannot be read as an allowance', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ userMentionCount: 5 }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('flags at 5 or more');
  });

  it('counts @everyone as one mention', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ userMentionCount: 4, everyoneMentioned: true }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });
});

describe('INVITE_LINKS', () => {
  const config: AutomodRuleConfig = {
    type: 'INVITE_LINKS',
    allowOwnServerInvites: true,
    allowedInviteCodes: ['allowed123'],
  };

  it('does not match content with no invites', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'just talking' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });

  it('matches an invite not on the allow list', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'join us discord.gg/evilcode' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('does not match an allowed invite code', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'discord.gg/allowed123' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });
});

describe('SCAM_LINKS', () => {
  const config: AutomodRuleConfig = { type: 'SCAM_LINKS', useBuiltInList: true, blockedDomains: [] };

  it('matches a built-in scam domain', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'check this out https://dlscord.com/free' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
    expect(result.evidence?.matchedDomain).toBe('dlscord.com');
  });

  it('matches a built-in bait phrase even without a link', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'hey! free nitro for everyone!' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('does not match an unrelated link', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'see https://example.com/page' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });

  it('matches an admin-added custom domain even when the built-in list is off', async () => {
    const cfg: AutomodRuleConfig = {
      type: 'SCAM_LINKS',
      useBuiltInList: false,
      blockedDomains: ['scam-example.com'],
    };
    const result = await evaluateMessageRule(cfg, {
      message: msg({ content: 'https://scam-example.com/x' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });
});

describe('REGEX_FILTER', () => {
  const config: AutomodRuleConfig = { type: 'REGEX_FILTER', pattern: '\\bbadword\\b', flags: 'i' };

  it('matches the pattern', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'this has a BADWORD in it' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('does not match unrelated text', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'perfectly fine message' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });

  it('degrades to no-match instead of throwing on an invalid stored pattern', async () => {
    const cfg = { ...config, pattern: '(' } as AutomodRuleConfig;
    const result = await evaluateMessageRule(cfg, {
      message: msg({ content: 'anything' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });
});

describe('WORD_FILTER', () => {
  it('gives the same answers when one rule config is reused across many messages', async () => {
    // The compiled matchers are kept per config object, so reuse must not leak state between messages.
    const config: AutomodRuleConfig = {
      type: 'WORD_FILTER',
      words: ['spam', 'two words', 'a.b'],
      wholeWord: true,
      caseSensitive: false,
    };
    const run = async (content: string) =>
      evaluateMessageRule(config, { message: msg({ content }), windowStore: new MemoryWindowStore() });

    for (let pass = 0; pass < 3; pass += 1) {
      expect((await run('this is SPAM here')).evidence).toEqual({ matchedWord: 'spam' });
      expect((await run('spammer central')).matched).toBe(false);
      expect((await run('Two Words in a row')).evidence).toEqual({ matchedWord: 'two words' });
      // The dot is literal: "a.b" is listed, "axb" is not.
      expect((await run('see a.b now')).matched).toBe(true);
      expect((await run('see axb now')).matched).toBe(false);
    }
  });

  it('reports the first listed word that matches', async () => {
    const config: AutomodRuleConfig = {
      type: 'WORD_FILTER',
      words: ['second', 'first'],
      wholeWord: false,
      caseSensitive: false,
    };
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'first and second' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.evidence).toEqual({ matchedWord: 'second' });
  });

  it('treats an edited rule as a new config, never serving the old word list', async () => {
    const before: AutomodRuleConfig = {
      type: 'WORD_FILTER',
      words: ['old'],
      wholeWord: true,
      caseSensitive: false,
    };
    const after: AutomodRuleConfig = { ...before, words: ['new'] };
    const run = async (config: AutomodRuleConfig, content: string) =>
      (await evaluateMessageRule(config, { message: msg({ content }), windowStore: new MemoryWindowStore() }))
        .matched;

    expect(await run(before, 'an old word')).toBe(true);
    expect(await run(after, 'an old word')).toBe(false);
    expect(await run(after, 'a new word')).toBe(true);
  });

  it('matches a whole-word, case-insensitive hit', async () => {
    const config: AutomodRuleConfig = {
      type: 'WORD_FILTER',
      words: ['spam'],
      wholeWord: true,
      caseSensitive: false,
    };
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'this is SPAM here' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('whole-word mode does not match a substring', async () => {
    const config: AutomodRuleConfig = {
      type: 'WORD_FILTER',
      words: ['spam'],
      wholeWord: true,
      caseSensitive: false,
    };
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'spammer central' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });

  it('non-whole-word mode matches a substring', async () => {
    const config: AutomodRuleConfig = {
      type: 'WORD_FILTER',
      words: ['spam'],
      wholeWord: false,
      caseSensitive: false,
    };
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'spammer central' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('case-sensitive mode respects case', async () => {
    const config: AutomodRuleConfig = {
      type: 'WORD_FILTER',
      words: ['SPAM'],
      wholeWord: false,
      caseSensitive: true,
    };
    const lower = await evaluateMessageRule(config, {
      message: msg({ content: 'spam' }),
      windowStore: new MemoryWindowStore(),
    });
    const upper = await evaluateMessageRule(config, {
      message: msg({ content: 'SPAM' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(lower.matched).toBe(false);
    expect(upper.matched).toBe(true);
  });
});

describe('CAPS', () => {
  const config: AutomodRuleConfig = { type: 'CAPS', minLength: 5, maxCapsPercent: 70 };

  it('ignores short messages', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'HI' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });

  it('matches mostly-uppercase long messages', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'THIS IS SHOUTING AT YOU' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('does not match normal-case long messages', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'this is a perfectly normal sentence' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });
});

describe('REPEATED_CHARS', () => {
  const config: AutomodRuleConfig = { type: 'REPEATED_CHARS', maxRepeats: 5 };

  it('matches a long run of the same character', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'nooooooo way' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('does not match short runs', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'wow really cool' }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });
});

describe('ATTACHMENTS', () => {
  it('matches a blocked extension', async () => {
    const config: AutomodRuleConfig = {
      type: 'ATTACHMENTS',
      blockedExtensions: ['exe'],
      maxAttachments: undefined,
    };
    const result = await evaluateMessageRule(config, {
      message: msg({ attachments: [{ filename: 'virus.exe' }] }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('matches too many attachments', async () => {
    const config: AutomodRuleConfig = { type: 'ATTACHMENTS', blockedExtensions: [], maxAttachments: 1 };
    const result = await evaluateMessageRule(config, {
      message: msg({ attachments: [{ filename: 'a.png' }, { filename: 'b.png' }] }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('does not match a clean attachment under the limit', async () => {
    const config: AutomodRuleConfig = { type: 'ATTACHMENTS', blockedExtensions: ['exe'], maxAttachments: 5 };
    const result = await evaluateMessageRule(config, {
      message: msg({ attachments: [{ filename: 'photo.png' }] }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });

  it('does not match a message with no attachments', async () => {
    const config: AutomodRuleConfig = { type: 'ATTACHMENTS', blockedExtensions: ['exe'], maxAttachments: 0 };
    const result = await evaluateMessageRule(config, {
      message: msg({ attachments: [] }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });
});

describe('NSFW_ENFORCEMENT', () => {
  const config: AutomodRuleConfig = {
    type: 'NSFW_ENFORCEMENT',
    requireNsfwChannelForKeywords: ['nsfw-word'],
  };

  it('matches a keyword outside an NSFW channel', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'contains nsfw-word here', channelNsfw: false }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('does not match inside an NSFW channel', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: 'contains nsfw-word here', channelNsfw: true }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });

  it('is a no-op (not a crash) when content is unavailable', async () => {
    const result = await evaluateMessageRule(config, {
      message: msg({ content: '', channelNsfw: false }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });
});

describe('ACCOUNT_AGE', () => {
  it('matches an account younger than the minimum', async () => {
    const config: AutomodRuleConfig = { type: 'ACCOUNT_AGE', minAccountAgeHours: 24 };
    const result = await evaluateJoinRule(config, {
      join: join({
        accountCreatedAt: new Date('2026-01-01T00:00:00Z'),
        joinedAt: new Date('2026-01-01T01:00:00Z'),
      }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(true);
  });

  it('does not match an older account', async () => {
    const config: AutomodRuleConfig = { type: 'ACCOUNT_AGE', minAccountAgeHours: 24 };
    const result = await evaluateJoinRule(config, {
      join: join({
        accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
        joinedAt: new Date('2026-01-01T00:00:00Z'),
      }),
      windowStore: new MemoryWindowStore(),
    });
    expect(result.matched).toBe(false);
  });
});

describe('RAID_DETECTION', () => {
  const config: AutomodRuleConfig = { type: 'RAID_DETECTION', joinBurstCount: 3, joinBurstWindowSeconds: 30 };

  it('does not match a slow trickle of joins', async () => {
    const windowStore = new MemoryWindowStore();
    const result = await evaluateJoinRule(config, { join: join({ userId: 'only-one' }), windowStore });
    expect(result.matched).toBe(false);
  });

  it('matches once enough joins land within the window', async () => {
    const windowStore = new MemoryWindowStore();
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await evaluateJoinRule(config, { join: join({ userId: `raider${i}` }), windowStore });
    }
    expect(last?.matched).toBe(true);
  });
});

describe('testRuleWithText', () => {
  it('runs a message-based rule type', async () => {
    const config: AutomodRuleConfig = { type: 'CAPS', minLength: 5, maxCapsPercent: 50 };
    const result = await testRuleWithText(config, 'THIS IS LOUD');
    expect(result.matched).toBe(true);
  });

  it('refuses to test a join-based rule type with sample text', async () => {
    const config: AutomodRuleConfig = { type: 'ACCOUNT_AGE', minAccountAgeHours: 24 };
    const result = await testRuleWithText(config, 'anything');
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/member joins/);
  });
});
