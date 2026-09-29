/**
 * Client-side sanity check for the OpenAI key field on the creator dashboard. Mirrors the API's `ttsKeySchema`
 * (`apps/api/src/routes/creator-twitch-rewards.ts`): starts with `sk-`, no whitespace, 20-300 characters. It only
 * catches a pasted-the-wrong-thing slip; OpenAI itself decides whether the key works, and the server re-validates.
 */
export const TTS_KEY_MIN = 20;
export const TTS_KEY_MAX = 300;

export function isPlausibleOpenAiKey(value: string): boolean {
  return value.length >= TTS_KEY_MIN && value.length <= TTS_KEY_MAX && /^sk-\S+$/.test(value);
}
