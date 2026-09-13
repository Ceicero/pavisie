import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError } from '@pavisie/core';
import { fetchWithTimeout } from '../providers/fetch-with-timeout';

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('aborts and throws ExternalServiceError when the request exceeds timeoutMs', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithTimeout('https://example.com', { timeoutMs: 100 });
    const assertion = expect(promise).rejects.toThrow(ExternalServiceError);
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });

  it('resolves normally when the request completes before the timeout', async () => {
    const response = new Response('ok', { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithTimeout('https://example.com', { timeoutMs: 5000 });
    expect(result.status).toBe(200);
  });
});
