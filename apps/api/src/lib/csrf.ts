import type { FastifyReply, FastifyRequest } from 'fastify';
import { PermissionError, env, timingSafeEqualStr } from '@pavisie/core';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_HEADER = 'x-csrf-token';

// Routes that legitimately have no session/csrf token yet when the mutating request arrives
// (starting a login flow) or that aren't session-authenticated at all (external webhooks).
// `/twitch-ext/` (the Twitch Extension Backend Service, ARCHITECTURE.md §19d) is bearer-JWT authenticated —
// there is no dashboard cookie/session in play, so there is no session csrf token to check. It's also served
// to a different origin than the dashboard, with `credentials: false` (see routes/twitch-ext.ts's own CORS),
// so it never carries the session cookie CSRF actually protects. Belt-and-suspenders: `csrfProtection` below
// already no-ops on any request with no `request.session`, which a cross-origin bearer-only call always is —
// this exemption just makes that explicit rather than relying on that fallthrough.
const EXEMPT_PREFIXES = ['/webhooks/', '/verify/', '/twitch-ext/'];
const EXEMPT_EXACT_PATHS = new Set(['/auth/test-login']);

function isExempt(url: string): boolean {
  const path = url.split('?')[0];
  if (EXEMPT_EXACT_PATHS.has(path)) return true;
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function allowedOrigins(): string[] {
  const origins: string[] = [];
  if (env.DASHBOARD_URL) origins.push(env.DASHBOARD_URL);
  if (env.WEB_URL) origins.push(env.WEB_URL);
  return origins;
}

function isAllowedOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return allowedOrigins().some((allowed) => {
      try {
        return new URL(allowed).origin === url.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Global preHandler: for mutating HTTP methods (outside the small exemption list), requires the
 * `X-CSRF-Token` header to match the session's csrf token, and — when present — the `Origin`/`Referer`
 * header to be in the dashboard/web origin allowlist (ARCHITECTURE.md §10).
 */
export async function csrfProtection(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!MUTATING_METHODS.has(request.method)) return;
  if (isExempt(request.url)) return;
  if (!request.session) return; // let route-level requireAuth produce the 401 for unauthenticated mutating calls

  const origin = request.headers.origin;
  const referer = request.headers.referer;
  if (origin && !isAllowedOrigin(origin)) {
    throw new PermissionError('Request origin is not allowed.');
  }
  if (!origin && referer && !isAllowedOrigin(referer)) {
    throw new PermissionError('Request origin is not allowed.');
  }

  const headerToken = request.headers[CSRF_HEADER];
  const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!token || !timingSafeEqualStr(token, request.session.csrfToken)) {
    throw new PermissionError('Missing or invalid CSRF token.');
  }
}
