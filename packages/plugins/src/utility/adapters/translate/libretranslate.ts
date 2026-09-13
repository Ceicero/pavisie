import { assertPublicHttpUrl, SsrfError } from '@pavisie/core';
import { TranslateAdapterError, type TranslateAdapter, type TranslateResult } from './types';

interface LibreTranslateResponse {
  translatedText?: string;
  detectedLanguage?: { confidence: number; language: string };
  error?: string;
}

/** LibreTranslate (self-hosted or public instance) adapter. `baseUrl` is operator-configured via `LIBRETRANSLATE_URL`. */
export class LibreTranslateAdapter implements TranslateAdapter {
  readonly provider = 'libretranslate';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async translate(text: string, to: string, from?: string): Promise<TranslateResult> {
    let target: URL;
    try {
      target = await assertPublicHttpUrl(new URL('/translate', this.baseUrl).toString());
    } catch (err) {
      throw new TranslateAdapterError(
        `LibreTranslate is misconfigured: ${err instanceof SsrfError ? err.message : 'invalid LIBRETRANSLATE_URL.'}`,
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: text,
          source: from ?? 'auto',
          target: to,
          format: 'text',
          ...(this.apiKey ? { api_key: this.apiKey } : {}),
        }),
      });
    } catch (err) {
      throw new TranslateAdapterError(
        `Could not reach LibreTranslate: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const data = (await response.json().catch(() => ({}))) as LibreTranslateResponse;

    if (!response.ok) {
      throw new TranslateAdapterError(
        `LibreTranslate returned an error (${response.status})${data.error ? `: ${data.error}` : '.'}`,
      );
    }
    if (!data.translatedText) {
      throw new TranslateAdapterError('LibreTranslate returned no translation.');
    }

    return {
      translatedText: data.translatedText,
      detectedSourceLanguage: data.detectedLanguage?.language,
      provider: this.provider,
    };
  }
}
