import { t } from '@pavisie/core';
import { describe, expect, it } from 'vitest';
import {
  classifyDiscordFailure as exportedClassify,
  discordErrorCode as exportedCode,
  discordFailureKey as exportedKey,
} from '../index';
import {
  classifyDiscordFailure,
  discordErrorCode,
  discordFailureKey,
  type DiscordFailure,
} from '../discord-errors';

/** Discord REST codes the shared helper must treat as terminal, matching the community copy. */
const TERMINAL_CODES: Array<[number, DiscordFailure]> = [
  [10003, 'unknown_channel'],
  [10004, 'unknown_guild'],
  [10008, 'unknown_message'],
  [10013, 'unknown_user'],
  [50001, 'missing_access'],
  [50007, 'cannot_dm'],
  [50013, 'missing_permissions'],
];

describe('discordErrorCode', () => {
  it('reads a finite numeric code', () => {
    expect(discordErrorCode({ code: 10003 })).toBe(10003);
  });

  it('reads an all-digit string code', () => {
    expect(discordErrorCode({ code: '50013' })).toBe(50013);
  });

  it('returns null when the value is not a Discord REST code', () => {
    expect(discordErrorCode(null)).toBeNull();
    expect(discordErrorCode(undefined)).toBeNull();
    expect(discordErrorCode('socket hang up')).toBeNull();
    expect(discordErrorCode(new Error('socket hang up'))).toBeNull();
    expect(discordErrorCode({})).toBeNull();
    expect(discordErrorCode({ code: null })).toBeNull();
    expect(discordErrorCode({ code: '50013x' })).toBeNull();
    expect(discordErrorCode({ code: Number.NaN })).toBeNull();
    expect(discordErrorCode({ code: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('classifyDiscordFailure', () => {
  it.each(TERMINAL_CODES)('classifies Discord code %s as %s', (code, failure) => {
    expect(classifyDiscordFailure({ code })).toBe(failure);
    expect(classifyDiscordFailure({ code: String(code) })).toBe(failure);
    expect(classifyDiscordFailure(Object.assign(new Error('DiscordAPIError'), { code }))).toBe(failure);
  });

  it('returns null for network errors, 5xx, and rate limits so callers can retry', () => {
    expect(classifyDiscordFailure(new Error('socket hang up'))).toBeNull();
    expect(classifyDiscordFailure({ code: 500 })).toBeNull();
    expect(classifyDiscordFailure({ status: 503 })).toBeNull();
    expect(classifyDiscordFailure({ code: 429, retryAfter: 1 })).toBeNull();
    expect(classifyDiscordFailure({ code: 0 })).toBeNull();
    expect(classifyDiscordFailure(null)).toBeNull();
    expect(classifyDiscordFailure(undefined)).toBeNull();
    expect(classifyDiscordFailure('not an error object')).toBeNull();
  });
});

describe('discordFailureKey', () => {
  // Shared sentences live in core `errors.*`. unknown_guild / unknown_user stay null: no shared key fits
  // "the server is gone" or "that user id does not exist" without inventing copy beyond the four assigned keys.
  const mapped: Array<[DiscordFailure, string, string]> = [
    ['unknown_channel', 'errors.channel_gone', 'That channel was deleted.'],
    ['unknown_message', 'errors.message_gone', 'That message was deleted.'],
    ['missing_access', 'errors.cannot_post', "I can't post in that channel. Check my permissions."],
    ['missing_permissions', 'errors.cannot_post', "I can't post in that channel. Check my permissions."],
    ['cannot_dm', 'errors.cannot_dm', "I can't send a direct message to that user."],
  ];

  it.each(mapped)('maps %s to %s', (failure, key, sentence) => {
    expect(discordFailureKey(failure)).toBe(key);
    expect(t(discordFailureKey(failure)!)).toBe(sentence);
    expect(t(key)).toBe(sentence);
  });

  it('classifies a raw error internally and returns the same core key', () => {
    expect(discordFailureKey({ code: 10003 })).toBe('errors.channel_gone');
    expect(discordFailureKey({ code: '10008' })).toBe('errors.message_gone');
    expect(discordFailureKey({ code: 50001 })).toBe('errors.cannot_post');
    expect(discordFailureKey({ code: '50013' })).toBe('errors.cannot_post');
    expect(
      discordFailureKey(Object.assign(new Error('Cannot send messages to this user'), { code: 50007 })),
    ).toBe('errors.cannot_dm');
  });

  it('returns null for unknown guild and unknown user', () => {
    expect(discordFailureKey('unknown_guild')).toBeNull();
    expect(discordFailureKey('unknown_user')).toBeNull();
    expect(discordFailureKey({ code: 10004 })).toBeNull();
    expect(discordFailureKey({ code: 10013 })).toBeNull();
  });

  it('returns null when classifyDiscordFailure returns null', () => {
    expect(discordFailureKey(new Error('socket hang up'))).toBeNull();
    expect(discordFailureKey({ code: 500 })).toBeNull();
    expect(discordFailureKey({ status: 502 })).toBeNull();
    expect(discordFailureKey({ code: 429 })).toBeNull();
    expect(discordFailureKey(null)).toBeNull();
    expect(discordFailureKey(undefined)).toBeNull();
    // A bare REST code is not an error object and not a DiscordFailure name.
    expect(discordFailureKey(10003)).toBeNull();
    expect(discordFailureKey(50007)).toBeNull();
  });
});

describe('sdk barrel', () => {
  it('re-exports the discord error helpers', () => {
    expect(exportedClassify).toBe(classifyDiscordFailure);
    expect(exportedCode).toBe(discordErrorCode);
    expect(exportedKey).toBe(discordFailureKey);
  });
});
