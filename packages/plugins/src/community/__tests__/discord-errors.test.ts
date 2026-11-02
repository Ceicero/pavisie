import { describe, expect, it } from 'vitest';
import { classifyDiscordFailure, discordErrorCode } from '../discord-errors';

describe('classifyDiscordFailure', () => {
  it('recognises deleted channels and messages, and missing access or permissions', () => {
    expect(classifyDiscordFailure({ code: 10003 })).toBe('unknown_channel');
    expect(classifyDiscordFailure({ code: 10008 })).toBe('unknown_message');
    expect(classifyDiscordFailure({ code: 50001 })).toBe('missing_access');
    expect(classifyDiscordFailure({ code: '50013' })).toBe('missing_permissions');
  });

  it('leaves transient failures retryable', () => {
    expect(classifyDiscordFailure(new Error('socket hang up'))).toBeNull();
    expect(classifyDiscordFailure({ code: 500 })).toBeNull();
    expect(discordErrorCode(null)).toBeNull();
  });
});
