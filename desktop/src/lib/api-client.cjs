'use strict';

/**
 * The only requests the window is allowed to make through the main process. Every one is a read (GET): this app
 * shows numbers, it never changes anything on the server.
 */
const ALLOWED_PATHS = new Set([
  '/auth/me',
  '/owner/metrics/overview',
  '/owner/metrics/guilds',
  '/owner/metrics/errors',
  '/owner/metrics/growth',
  '/owner/metrics/usage',
  '/owner/metrics/twitch',
  '/owner/metrics/twitch/channels',
  '/owner/metrics/integrations',
]);

const ALLOWED_QUERY_KEYS = new Set(['days', 'limit', 'cursor', 'query', 'botPresent', 'status', 'source']);
const REQUEST_TIMEOUT_MS = 20_000;

/** Builds the request URL, refusing any path or query key that is not on the allowlists above. */
function buildRequestUrl(apiUrl, path, query = {}) {
  if (!ALLOWED_PATHS.has(path)) throw new Error(`Request not allowed: ${path}`);
  const url = new URL(path, apiUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (!ALLOWED_QUERY_KEYS.has(key)) throw new Error(`Query parameter not allowed: ${key}`);
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

/** Turns an HTTP failure into one plain sentence that says what to do about it. */
function describeFailure(status, path, serverMessage) {
  if (status === 401)
    return { code: 'signed_out', message: 'You are signed out. Sign in with Discord to continue.' };
  if (status === 403) {
    return {
      code: 'not_owner',
      message:
        'This Discord account is not a Pavisie bot owner. Add its user ID to BOT_OWNER_IDS on the API, or sign in with the owner account.',
    };
  }
  if (status === 404) {
    return {
      code: 'not_deployed',
      message: `The API at this address does not have ${path} yet. Deploy the latest Pavisie API to see this section.`,
    };
  }
  if (status === 429)
    return { code: 'rate_limited', message: 'The API is rate-limiting this app. Wait a minute and refresh.' };
  return {
    code: 'server_error',
    message: serverMessage || `The API answered with an error (HTTP ${status}).`,
  };
}

/**
 * GETs one allowlisted path with the session cookie attached and resolves to `{ ok: true, data }` or
 * `{ ok: false, code, message }`. Never throws for a network or HTTP failure, so one broken section cannot take
 * the whole window down.
 */
async function apiGet({ apiUrl, path, query, cookieHeader, fetchImpl = fetch }) {
  let url;
  try {
    url = buildRequestUrl(apiUrl, path, query);
  } catch (error) {
    return { ok: false, code: 'not_allowed', message: error.message };
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...(cookieHeader ? { cookie: cookieHeader } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      code: 'unreachable',
      ok: false,
      message: `Could not reach ${url.origin}. Check the API address and your internet connection.`,
    };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const serverMessage = typeof body?.error?.message === 'string' ? body.error.message : '';
    return { ok: false, ...describeFailure(response.status, path, serverMessage) };
  }
  if (body === null) {
    return {
      ok: false,
      code: 'bad_response',
      message: 'The API sent a reply this app could not read. Is the address right?',
    };
  }
  return { ok: true, data: body };
}

module.exports = { ALLOWED_PATHS, apiGet, buildRequestUrl, describeFailure };
