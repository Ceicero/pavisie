// Server-side TTS synthesis for channel-point TTS reward actions (channel-points spec, binding fact 7:
// `window.speechSynthesis` does not work in an OBS browser source — CEF ships no voices — so synthesis has to
// happen here, and the overlay just plays back audio bytes it's handed).
//
// Deliberately reuses the `ai` plugin's OWN per-guild key storage/decryption path rather than inventing a
// second one: a guild that has already configured an OpenAI key for `/ask` etc. gets TTS "for free", and there
// is exactly one place a guild's OpenAI key is ever stored/decrypted. `ai/service.ts` can't be called directly
// (its `AiService.complete()` is a chat completion, not a speech synthesis call, and `ctx.getConfig` only ever
// resolves the CALLING plugin's own config — there is no cross-plugin config accessor), so this loads the raw
// `ai` `PluginConfig` row itself and runs it through the exact same `configSchema`/`resolveApiKey` the `ai`
// plugin uses internally (see packages/plugins/src/ai/manifest.ts, packages/plugins/src/ai/resolve-key.ts).
import { randomUUID } from 'node:crypto';
import { redisKey } from '@pavisie/core';
import type { PluginContext } from '../../sdk';
import { configSchema as aiConfigSchema, type AiConfig } from '../../ai/manifest';
import { resolveApiKey } from '../../ai/resolve-key';

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
/** Primary model; OpenAI's newer, cheaper TTS model. Falls back to `tts-1` only when OpenAI reports the model
 * itself is unknown/unavailable to the caller — never on a transient/network failure. */
const PRIMARY_MODEL = 'gpt-4o-mini-tts';
const FALLBACK_MODEL = 'tts-1';
/** Fixed default voice — no per-guild/per-reward voice picker in v1. */
const DEFAULT_VOICE = 'alloy';
/** Matches the overlay's `GET /overlay/:token/tts/:id` cache TTL (channel-points spec) — short-lived, just long
 * enough for the overlay to fetch and play it once. */
const AUDIO_TTL_SECONDS = 300;

/** Loads the `ai` plugin's effective per-guild config directly from its `PluginConfig` row, applying the same
 * default-then-stored-merge `configSchema.parse` shape `GuildConfigStore.getConfig` uses internally — this
 * module has no access to that store (it isn't bound to the `ai` plugin's id), so it reproduces just that one
 * read here rather than adding a generic cross-plugin config accessor to the SDK (out of scope for this
 * feature). No caching: TTS synthesis is triggered by a channel-point redemption, not a hot per-message path. */
async function loadAiConfig(ctx: PluginContext, guildId: string): Promise<AiConfig> {
  const row = await ctx.prisma.pluginConfig.findUnique({
    where: { guildId_pluginId: { guildId, pluginId: 'ai' } },
  });
  const stored = (row?.config as Record<string, unknown> | undefined) ?? {};
  const defaults = aiConfigSchema.parse({}) as Record<string, unknown>;
  return aiConfigSchema.parse({ ...defaults, ...stored }) as AiConfig;
}

interface OpenAiErrorBody {
  error?: { message?: string; code?: string; type?: string };
}

/** OpenAI reports an unrecognized/unavailable model as a 4xx with `error.code === 'model_not_found'` (or, on
 * some accounts, just a message mentioning the model) — distinct from every other failure mode (bad key, rate
 * limit, network, 5xx), which must NOT trigger the one-time fallback-model retry. */
function isUnknownModelError(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500) return false;
  const error = (body as OpenAiErrorBody | null)?.error;
  if (!error) return false;
  if (error.code === 'model_not_found') return true;
  return typeof error.message === 'string' && /model/i.test(error.message);
}

type SpeechResult = { ok: true; bytes: ArrayBuffer } | { ok: false; status: number; body: unknown };

async function requestSpeech(params: { apiKey: string; model: string; text: string }): Promise<SpeechResult> {
  const res = await fetch(OPENAI_SPEECH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${params.apiKey}` },
    body: JSON.stringify({
      model: params.model,
      voice: DEFAULT_VOICE,
      input: params.text,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    return { ok: false, status: res.status, body };
  }
  const bytes = await res.arrayBuffer();
  return { ok: true, bytes };
}

/**
 * Synthesizes `text` to speech for `guildId` and caches the resulting mp3 bytes (base64-encoded) in Redis at
 * `pavisie:overlay:tts:<channelId>:<audioId>` with a 300s TTL, returning the opaque `audioId` the overlay's
 * `GET /overlay/:token/tts/:audioId` route resolves back to bytes.
 *
 * The key is scoped by `channelId` deliberately: that route authenticates a capability token to ONE channel,
 * and scoping the key is what stops a valid token for channel A from fetching channel B's audio — which is
 * a viewer's message spoken aloud, so it is exactly the sort of thing that must not leak across tenants.
 * Unguessable audio ids are not the control here; the key scope is.
 *
 * Returns `null` — and NEVER throws — whenever synthesis simply isn't available right now: the guild has not
 * supplied its OWN OpenAI key (TTS is bring-your-own-key and never falls back to the operator's platform key —
 * see the call site), the guild's provider isn't `openai` (an Anthropic-only guild has no corresponding speech
 * endpoint here), or the OpenAI request itself failed. This is the honest "TTS unavailable" path (mirrors the media plugin's
 * `MediaProvider.createStream()` precedent: an unimplemented/unconfigured provider means the feature reports
 * itself unavailable, not an error) — callers (`rewards.ts`'s action dispatch in `manager.ts`) just skip the
 * TTS action when this returns `null`.
 *
 * Never logs the resolved API key.
 */
export async function synthesizeTts(
  ctx: PluginContext,
  guildId: string,
  channelId: string,
  text: string,
): Promise<{ audioId: string } | null> {
  const config = await loadAiConfig(ctx, guildId);
  // Only an `openai`-provider config can possibly yield a usable key here — a `compatible`/`anthropic` guild
  // config has no key that OpenAI's speech endpoint would accept.
  if (config.provider !== 'openai') return null;

  // Deliberately NO env-key fallback: `{}` is passed where `resolveApiKey` would otherwise read the operator's
  // `OPENAI_API_KEY`. TTS is bring-your-own-key by design — a guild that wants its channel-point rewards spoken
  // pays for its own synthesis. `AiConfig.allowEnvKeys` defaults to TRUE, so passing `ctx.env` here would silently
  // bill every free guild's TTS to the operator the moment they set a platform key for any reason. The
  // `source === 'guild'` assertion below makes that guarantee explicit rather than implicit in an empty object.
  const resolvedKey = resolveApiKey(config, {});
  if (!resolvedKey || resolvedKey.source !== 'guild') return null;

  try {
    let result = await requestSpeech({ apiKey: resolvedKey.apiKey, model: PRIMARY_MODEL, text });
    if (!result.ok && isUnknownModelError(result.status, result.body)) {
      result = await requestSpeech({ apiKey: resolvedKey.apiKey, model: FALLBACK_MODEL, text });
    }
    if (!result.ok) {
      ctx.logger.warn(
        { status: result.status },
        'integrations/twitch-chat: TTS synthesis request failed; treating TTS as unavailable for this reward',
      );
      return null;
    }

    const audioId = randomUUID();
    const base64 = Buffer.from(result.bytes).toString('base64');
    await ctx.redis.set(redisKey('overlay', 'tts', channelId, audioId), base64, 'EX', AUDIO_TTL_SECONDS);
    return { audioId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn({ err: message }, 'integrations/twitch-chat: TTS synthesis request threw');
    return null;
  }
}
