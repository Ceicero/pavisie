import { apiFetch, type ApiFetchInit } from '@/lib/dashboard/api';

/**
 * API client for the creator dashboard (`/creator/*` on the Pavisie API). Same transport as the Discord
 * dashboard's `apiFetch` (cookies included, JSON in/out, `ApiClientError` on failure), but every mutating request
 * carries the CREATOR session's CSRF token — never the Discord dashboard session's. The two session types are
 * separate on the API (own cookie `csid`, own token) and a browser can hold both at once, so the creator token
 * lives in its own module variable here, set by `CreatorSessionProvider`.
 */
let creatorCsrfToken: string | null = null;

/** Updates the CSRF token `creatorFetch` attaches to mutating requests. Called by `CreatorSessionProvider`. */
export function setCreatorCsrfToken(token: string | null): void {
  creatorCsrfToken = token;
}

export function creatorFetch<T = unknown>(path: string, init: ApiFetchInit = {}): Promise<T> {
  return apiFetch<T>(path, { ...init, csrfToken: creatorCsrfToken });
}
