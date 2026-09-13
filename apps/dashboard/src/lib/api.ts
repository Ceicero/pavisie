import type { ApiError } from '@pavisie/types';

/** Base URL of the Pavisie API. Falls back to the local dev default (see docs/ARCHITECTURE.md §4). */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * The current session's CSRF token, mirrored here by `SessionProvider` so plain functions
 * (React Query `queryFn`/`mutationFn`, called outside component render) can attach it without
 * threading it through every call site.
 */
let csrfToken: string | null = null;

/** Updates the module-level CSRF token used by `apiFetch` for mutating requests. Called by `SessionProvider`. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export interface ApiClientErrorOptions {
  code: string;
  status: number;
  details?: unknown;
}

/** Thrown by `apiFetch` for any non-2xx response or network failure. */
export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, options: ApiClientErrorOptions) {
    super(message);
    this.name = 'ApiClientError';
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }
}

export interface ApiFetchInit extends Omit<RequestInit, 'body'> {
  /** JSON-serializable body. Strings, `FormData`, and `Blob` are passed through untouched. */
  body?: unknown;
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === 'string' ||
    value instanceof FormData ||
    value instanceof Blob ||
    value instanceof URLSearchParams
  );
}

/**
 * Fetch wrapper for the Pavisie API: sends cookies, JSON-encodes plain object bodies, attaches
 * `X-CSRF-Token` on mutating requests, parses JSON responses, and throws `ApiClientError` on failure.
 */
export async function apiFetch<T = unknown>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const isMutating = method !== 'GET' && method !== 'HEAD';

  let body: BodyInit | undefined;
  if (init.body !== undefined && init.body !== null) {
    if (isBodyInit(init.body)) {
      body = init.body;
    } else {
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      body = JSON.stringify(init.body);
    }
  }

  if (isMutating && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, method, headers, body, credentials: 'include' });
  } catch (err) {
    throw new ApiClientError('Could not reach the Pavisie API. Check your connection and try again.', {
      code: 'network_error',
      status: 0,
      details: err instanceof Error ? err.message : err,
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const payload: unknown = isJson
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);

  if (!response.ok) {
    const errorBody =
      payload && typeof payload === 'object' && 'error' in (payload as Record<string, unknown>)
        ? (payload as ApiError).error
        : null;
    throw new ApiClientError(errorBody?.message ?? `Request failed with status ${response.status}`, {
      code: errorBody?.code ?? 'unknown_error',
      status: response.status,
      details: errorBody?.details,
    });
  }

  return payload as T;
}

/** Builds a query string from a plain object, dropping `undefined`/`null`/empty-string values. */
export function toQueryString(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}
