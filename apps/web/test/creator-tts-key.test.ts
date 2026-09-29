import { describe, expect, it } from 'vitest';
import { TTS_KEY_MAX, TTS_KEY_MIN, isPlausibleOpenAiKey } from '../src/lib/creator/tts-key';

// Pinned to the API's `ttsKeySchema` (apps/api/src/routes/creator-twitch-rewards.ts): `sk-...`, no whitespace, 20-300 chars.
describe('isPlausibleOpenAiKey', () => {
  it('accepts sk- keys (including project keys) within the length bounds', () => {
    expect(isPlausibleOpenAiKey('sk-' + 'a'.repeat(TTS_KEY_MIN - 3))).toBe(true);
    expect(isPlausibleOpenAiKey('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789_-')).toBe(true);
    expect(isPlausibleOpenAiKey('sk-' + 'a'.repeat(TTS_KEY_MAX - 3))).toBe(true);
  });

  it('rejects the wrong prefix, spaces, and lengths outside the bounds', () => {
    expect(isPlausibleOpenAiKey('')).toBe(false);
    expect(isPlausibleOpenAiKey('sk-short')).toBe(false);
    expect(isPlausibleOpenAiKey('x'.repeat(40))).toBe(false);
    expect(isPlausibleOpenAiKey('sk-has space inside abcdefghijklmnop')).toBe(false);
    expect(isPlausibleOpenAiKey('sk-' + 'a'.repeat(TTS_KEY_MAX))).toBe(false);
  });
});
