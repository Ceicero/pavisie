import { decryptSecret } from '@pavisie/core';
import type { AiConfig } from './manifest';
import { envKeyNameFor } from './providers/resolve';

export interface ResolveKeyEnv {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

export interface ResolvedKey {
  apiKey: string;
  /** Where the key came from — useful for `/ai config view` and `/ai test` diagnostics. */
  source: 'guild' | 'env';
}

/**
 * Resolves the API key to use for a guild's configured provider: the guild's own encrypted key first, else
 * (when `config.allowEnvKeys`) the matching process-env var. Returns `null` if neither is available.
 */
export function resolveApiKey(config: AiConfig, env: ResolveKeyEnv): ResolvedKey | null {
  if (config.apiKeyEnc) {
    try {
      return { apiKey: decryptSecret(config.apiKeyEnc), source: 'guild' };
    } catch {
      // Falls through to the env-key fallback (or null) below — a corrupt/rotated-key value shouldn't crash a request.
    }
  }

  // Never fall back to the operator's environment key for a guild-supplied `compatible` base URL — that would
  // send the operator's OpenAI key as a Bearer token to a third-party host the guild controls.
  if (config.allowEnvKeys && config.provider !== 'compatible') {
    const envKeyName = envKeyNameFor(config.provider);
    const envKey = env[envKeyName];
    if (envKey) {
      return { apiKey: envKey, source: 'env' };
    }
  }

  return null;
}
