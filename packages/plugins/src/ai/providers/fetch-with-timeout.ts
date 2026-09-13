import { ExternalServiceError } from '@pavisie/core';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * `fetch` with a hard timeout, combined with a caller-supplied `AbortSignal` if given. Network failures and
 * timeouts are both mapped to `ExternalServiceError` so provider code has one error shape to throw on transport
 * failure (HTTP-status failures are mapped separately by each provider, which can read the response body).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  externalSignal?: AbortSignal,
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);

  try {
    // `redirect: 'error'` unless the caller explicitly overrides it — providers must never silently follow a
    // redirect to a different (potentially private/internal) host after the URL has already passed SSRF checks.
    return await fetch(url, { redirect: 'error', ...rest, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ExternalServiceError('The AI provider took too long to respond. Try again in a moment.');
    }
    throw new ExternalServiceError(
      `Could not reach the AI provider: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
