import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// No static imports of `@pavisie/core`: its `env` is computed once at first import from `process.env`, so
// `ENCRYPTION_KEY` (and the operator key these tests deliberately probe for) must be set first. Same pattern as
// `twitch-chat-broadcaster-token.test.ts`.
let encryptSecret: typeof import('@pavisie/core').encryptSecret;
let redisKey: typeof import('@pavisie/core').redisKey;
let createTestContext: typeof import('../../sdk/testing').createTestContext;
let synthesizeTts: typeof import('../twitch-chat/tts').synthesizeTts;

const GUILD_ID = 'guild-1';
const CHANNEL_ID = 'channel-a';

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
  // The operator's platform key is set for EVERY test in this file on purpose: the headline guarantee is that
  // TTS never spends it, so it must be present and reachable for that assertion to mean anything.
  process.env.OPENAI_API_KEY = 'sk-operator-platform-key-must-never-be-used';
  ({ encryptSecret, redisKey } = await import('@pavisie/core'));
  ({ createTestContext } = await import('../../sdk/testing'));
  ({ synthesizeTts } = await import('../twitch-chat/tts'));
});

/** An `ai` PluginConfig row as `loadAiConfig` reads it. `allowEnvKeys` defaults to TRUE in the ai manifest, so
 * the default here reflects the real-world shape that would otherwise fall back to the operator's key. */
function aiConfigRow(config: Record<string, unknown>) {
  return { guildId: GUILD_ID, pluginId: 'ai', config };
}

function contextWith(config: Record<string, unknown> | null) {
  return createTestContext({
    prismaOverrides: {
      pluginConfig: { findUnique: async () => (config ? aiConfigRow(config) : null) },
    },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okSpeechResponse(bytes = 'fake-mp3') {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from(bytes),
    json: async () => ({}),
  };
}

describe('synthesizeTts — bring-your-own-key billing guarantee', () => {
  it("never spends the operator's platform OPENAI_API_KEY when a guild has no key of its own", async () => {
    // The exact scenario the operator asked for: a free server with the AI plugin left at defaults
    // (`allowEnvKeys: true`) and no key of its own. TTS must decline rather than quietly bill the operator.
    const { ctx } = contextWith({ provider: 'openai', allowEnvKeys: true });

    const result = await synthesizeTts(ctx, GUILD_ID, CHANNEL_ID, 'hello chat');

    expect(result).toBeNull();
    // The strongest form of the assertion: OpenAI was never contacted at all, so no key could have been spent.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the guild\'s OWN key when it has one, and caches the audio under a channel-scoped key', async () => {
    fetchMock.mockResolvedValue(okSpeechResponse());
    const guildKey = 'sk-this-guild-pays-for-itself';
    const { ctx } = contextWith({
      provider: 'openai',
      allowEnvKeys: true,
      apiKeyEnc: encryptSecret(guildKey),
    });

    const result = await synthesizeTts(ctx, GUILD_ID, CHANNEL_ID, 'hello chat');

    expect(result).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe(`Bearer ${guildKey}`);
    expect(init.headers.authorization).not.toContain('operator-platform-key');

    const cached = await ctx.redis.get(redisKey('overlay', 'tts', CHANNEL_ID, result!.audioId));
    expect(cached).toBe(Buffer.from('fake-mp3').toString('base64'));
  });

  it('declines for a non-openai provider instead of trying to speak through it', async () => {
    const { ctx } = contextWith({ provider: 'anthropic', allowEnvKeys: true, apiKeyEnc: encryptSecret('sk-a') });

    expect(await synthesizeTts(ctx, GUILD_ID, CHANNEL_ID, 'hello')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declines honestly when the guild has never configured the AI plugin at all', async () => {
    const { ctx } = contextWith(null);

    expect(await synthesizeTts(ctx, GUILD_ID, CHANNEL_ID, 'hello')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null (never throws) when OpenAI rejects the request, and never logs the key', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Incorrect API key provided' } }),
    });
    const guildKey = 'sk-guild-key-that-is-invalid';
    const { ctx } = contextWith({
      provider: 'openai',
      allowEnvKeys: true,
      apiKeyEnc: encryptSecret(guildKey),
    });
    // `createTestContext` exposes no log buffer, so watch the logger directly: a failed synthesis must report
    // the status code and nothing else — an API key in a log line is a leak wherever those logs are shipped.
    const warn = vi.spyOn(ctx.logger, 'warn');

    expect(await synthesizeTts(ctx, GUILD_ID, CHANNEL_ID, 'hello')).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(guildKey);
  });
});
