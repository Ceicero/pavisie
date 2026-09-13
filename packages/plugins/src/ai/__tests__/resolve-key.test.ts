import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

// `@pavisie/core`'s `env` singleton is computed once, at that module's first import, from `process.env` — so
// `ENCRYPTION_KEY` must be set *before* anything (transitively) imports `@pavisie/core`. This file has no
// static imports of its own for that reason; everything it needs is imported dynamically inside `beforeAll`,
// after the env var is set, so `resolveApiKey`'s real (env-key-implicit) `decryptSecret()` call succeeds.
let encryptSecret: typeof import('@pavisie/core').encryptSecret;
let resolveApiKey: typeof import('../resolve-key').resolveApiKey;
let describeAvailability: typeof import('../service').describeAvailability;
let configSchema: typeof import('../manifest').configSchema;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
  ({ encryptSecret } = await import('@pavisie/core'));
  ({ resolveApiKey } = await import('../resolve-key'));
  ({ describeAvailability } = await import('../service'));
  ({ configSchema } = await import('../manifest'));
  // The dynamic imports above transform `@pavisie/core` + the ai plugin on first use, which can take well over
  // vitest's default 10s hook timeout when the whole plugins suite runs in parallel — give the hook room.
}, 30_000);

function baseConfig(overrides: Record<string, unknown> = {}) {
  return configSchema.parse(overrides);
}

describe('resolveApiKey', () => {
  it('prefers the guild-configured key over the env fallback', () => {
    const config = baseConfig({ apiKeyEnc: encryptSecret('guild-secret'), allowEnvKeys: true });
    const resolved = resolveApiKey(config, { OPENAI_API_KEY: 'env-secret' });
    expect(resolved).toEqual({ apiKey: 'guild-secret', source: 'guild' });
  });

  it('falls back to the matching env key when allowEnvKeys is true and no guild key is set', () => {
    const config = baseConfig({ provider: 'anthropic', allowEnvKeys: true });
    const resolved = resolveApiKey(config, { ANTHROPIC_API_KEY: 'env-anthropic' });
    expect(resolved).toEqual({ apiKey: 'env-anthropic', source: 'env' });
  });

  it('does not use the env fallback when allowEnvKeys is false', () => {
    const config = baseConfig({ allowEnvKeys: false });
    const resolved = resolveApiKey(config, { OPENAI_API_KEY: 'env-secret' });
    expect(resolved).toBeNull();
  });

  it('returns null when nothing is configured', () => {
    const config = baseConfig();
    expect(resolveApiKey(config, {})).toBeNull();
  });

  it('never falls back to the env key for the compatible provider, even with allowEnvKeys true (would leak the operator key to a guild-controlled base URL)', () => {
    const config = baseConfig({
      provider: 'compatible',
      baseUrl: 'https://llm.example.com',
      allowEnvKeys: true,
    });
    const resolved = resolveApiKey(config, { OPENAI_API_KEY: 'env-compat' });
    expect(resolved).toBeNull();
  });

  it('still uses the guild key for the compatible provider when one is configured', () => {
    const config = baseConfig({
      provider: 'compatible',
      baseUrl: 'https://llm.example.com',
      apiKeyEnc: encryptSecret('guild-compat-secret'),
      allowEnvKeys: true,
    });
    const resolved = resolveApiKey(config, { OPENAI_API_KEY: 'env-compat' });
    expect(resolved).toEqual({ apiKey: 'guild-compat-secret', source: 'guild' });
  });
});

describe('describeAvailability', () => {
  it('is unavailable with a helpful reason when no key resolves', () => {
    const config = baseConfig({ allowEnvKeys: false });
    const result = describeAvailability(config, {});
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/environment-key fallback is turned off/i);
  });

  it('is available once a key resolves', () => {
    const config = baseConfig();
    const result = describeAvailability(config, { OPENAI_API_KEY: 'env-secret' });
    expect(result.available).toBe(true);
  });
});
