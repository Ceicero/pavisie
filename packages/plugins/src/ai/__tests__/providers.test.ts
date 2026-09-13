import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError } from '@pavisie/core';
import { createAnthropicProvider } from '../providers/anthropic';
import { createOpenAiProvider } from '../providers/openai';

// `createOpenAiProvider` re-validates a custom `baseUrl` with `assertPublicHttpUrl` before every request (SSRF
// guard), which does a real DNS lookup — this test environment has no network access, so `dns.lookup` on a
// made-up test hostname would otherwise fail with ENOTFOUND. Stub it to resolve to a public IP so the SSRF
// check itself (not DNS availability) is what's being exercised.
vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) },
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('openai provider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds a chat/completions request with system + user messages, auth header, and maps the response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'hello there' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }),
    );

    const provider = createOpenAiProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini' });
    const result = await provider.complete({
      system: 'be nice',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
    });

    expect(result).toEqual({
      text: 'hello there',
      promptTokens: 12,
      completionTokens: 4,
      model: 'gpt-4o-mini',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBe(50);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be nice' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('honors a baseUrl override for OpenAI-compatible providers', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }], usage: {} }),
    );
    const provider = createOpenAiProvider({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://my-llm.example.com/v1',
    });
    await provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://my-llm.example.com/v1/chat/completions');
  });

  it('maps a non-OK response to ExternalServiceError with the provider error message', async () => {
    // A fresh `Response` per call (not `mockResolvedValue` with one shared instance) — a `Response` body can
    // only be read once, and this test reads it twice (once per assertion below).
    fetchMock.mockImplementation(async () => jsonResponse(401, { error: { message: 'Invalid API key' } }));
    const provider = createOpenAiProvider({ apiKey: 'bad', model: 'm' });
    await expect(provider.complete({ system: 's', messages: [], maxTokens: 10 })).rejects.toThrow(
      ExternalServiceError,
    );
    await expect(provider.complete({ system: 's', messages: [], maxTokens: 10 })).rejects.toThrow(
      /Invalid API key/,
    );
  });

  it('maps a network failure to ExternalServiceError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    const provider = createOpenAiProvider({ apiKey: 'k', model: 'm' });
    await expect(provider.complete({ system: 's', messages: [], maxTokens: 10 })).rejects.toThrow(
      ExternalServiceError,
    );
  });

  it('rejects a plain-http baseUrl (SSRF guard) before ever calling fetch', async () => {
    const provider = createOpenAiProvider({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'http://my-llm.example.com/v1',
    });
    await expect(provider.complete({ system: 's', messages: [], maxTokens: 10 })).rejects.toThrow(
      ExternalServiceError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never uses the default OpenAI base URL as an SSRF vector (no baseUrl override means no extra DNS/SSRF check)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }], usage: {} }),
    );
    const provider = createOpenAiProvider({ apiKey: 'k', model: 'm' });
    await provider.complete({ system: 's', messages: [], maxTokens: 10 });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });
});

describe('anthropic provider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds a messages request with x-api-key and anthropic-version headers, and maps the response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'claude-3-5-sonnet',
        content: [{ type: 'text', text: 'hi there' }],
        usage: { input_tokens: 20, output_tokens: 5 },
      }),
    );

    const provider = createAnthropicProvider({ apiKey: 'anthropic-key', model: 'claude-3-5-sonnet' });
    const result = await provider.complete({
      system: 'be nice',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
    });

    expect(result).toEqual({
      text: 'hi there',
      promptTokens: 20,
      completionTokens: 5,
      model: 'claude-3-5-sonnet',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('anthropic-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('be nice');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('maps a non-OK response to ExternalServiceError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: 'bad request' } }));
    const provider = createAnthropicProvider({ apiKey: 'k', model: 'm' });
    await expect(provider.complete({ system: 's', messages: [], maxTokens: 10 })).rejects.toThrow(
      /bad request/,
    );
  });
});
