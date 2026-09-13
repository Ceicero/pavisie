import { ExternalServiceError } from '@pavisie/core';
import { fetchWithTimeout } from './fetch-with-timeout';
import type { AiCompleteRequest, AiCompleteResponse, AiProvider } from './types';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string | null;
}

interface AnthropicMessagesResponse {
  model?: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Anthropic Messages API. */
export function createAnthropicProvider(options: AnthropicProviderOptions): AiProvider {
  const baseUrl = (
    options.baseUrl && options.baseUrl.trim().length > 0 ? options.baseUrl : DEFAULT_BASE_URL
  ).replace(/\/+$/, '');

  return {
    id: 'anthropic',
    async complete(request: AiCompleteRequest): Promise<AiCompleteResponse> {
      const body = {
        model: options.model,
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.4,
      };

      const response = await fetchWithTimeout(
        `${baseUrl}/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
        },
        request.signal,
      );

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
            ? payload.error.message
            : `Anthropic request failed with status ${response.status}.`;
        throw new ExternalServiceError(`AI provider error: ${message}`);
      }

      const parsed = payload as AnthropicMessagesResponse;
      const text = (parsed.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (!text) {
        throw new ExternalServiceError('The AI provider returned an empty response.');
      }

      return {
        text,
        promptTokens: parsed.usage?.input_tokens ?? 0,
        completionTokens: parsed.usage?.output_tokens ?? 0,
        model: parsed.model ?? options.model,
      };
    },
  };
}
