import { assertPublicHttpUrl, ExternalServiceError, SsrfError } from '@pavisie/core';
import { fetchWithTimeout } from './fetch-with-timeout';
import type { AiCompleteRequest, AiCompleteResponse, AiProvider } from './types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  /** Set for `provider: 'compatible'` — any OpenAI-chat-completions-shaped API. Defaults to OpenAI's own base URL. */
  baseUrl?: string | null;
}

interface OpenAiChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** OpenAI Chat Completions API (also used for any OpenAI-compatible `baseUrl` override — same request/response shape). */
export function createOpenAiProvider(options: OpenAiProviderOptions): AiProvider {
  const isCustomBaseUrl = Boolean(options.baseUrl && options.baseUrl.trim().length > 0);
  const baseUrl = (isCustomBaseUrl ? options.baseUrl! : DEFAULT_BASE_URL).replace(/\/+$/, '');

  return {
    id: 'openai',
    async complete(request: AiCompleteRequest): Promise<AiCompleteResponse> {
      // Re-validate a custom (`compatible` provider) base URL right before every request — it may have been
      // saved before SSRF validation existed, or DNS may have been re-pointed since. The default OpenAI base
      // URL never needs this (fixed, trusted host).
      if (isCustomBaseUrl) {
        try {
          await assertPublicHttpUrl(baseUrl);
        } catch (err) {
          throw new ExternalServiceError(
            err instanceof SsrfError
              ? `AI provider base URL is not allowed: ${err.message}`
              : 'AI provider base URL failed validation.',
          );
        }
      }

      const body = {
        model: options.model,
        messages: [{ role: 'system', content: request.system }, ...request.messages],
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.4,
      };

      const response = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(body),
        },
        request.signal,
      );

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
            ? payload.error.message
            : `OpenAI request failed with status ${response.status}.`;
        throw new ExternalServiceError(`AI provider error: ${message}`);
      }

      const parsed = payload as OpenAiChatCompletionResponse;
      const text = parsed.choices?.[0]?.message?.content ?? '';
      if (!text) {
        throw new ExternalServiceError('The AI provider returned an empty response.');
      }

      return {
        text,
        promptTokens: parsed.usage?.prompt_tokens ?? 0,
        completionTokens: parsed.usage?.completion_tokens ?? 0,
        model: parsed.model ?? options.model,
      };
    },
  };
}
