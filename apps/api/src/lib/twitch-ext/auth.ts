// Bearer-JWT auth for `/twitch-ext/*` (the Twitch Extension Backend Service) — a completely separate identity
// model from the dashboard's cookie session: no cookie, no CSRF token, just `Authorization: Bearer <JWT>` from
// the Twitch Extensions Helper (ARCHITECTURE.md §19d).

import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, env } from '@pavisie/core';
import { UnauthenticatedError } from '../guild-access';
import { verifyTwitchExtensionJwt } from './jwt';

/** True once both extension env vars are set — every `/twitch-ext` route gates on this first. */
export function isTwitchExtensionConfigured(): boolean {
  return Boolean(env.TWITCH_EXTENSION_CLIENT_ID) && Boolean(env.TWITCH_EXTENSION_SECRET);
}

/** Thrown by every `/twitch-ext` route before auth when the extension's env vars aren't set. Mirrors the
 * existing `twitch_not_configured` 503 in `routes/webhooks.ts` for the chat-bot EventSub endpoint. */
export function extensionNotConfiguredError(): AppError {
  return new AppError('extension_not_configured', 'Extension not configured', { status: 503, expose: true });
}

function bearerTokenFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * `preHandler` for every `/twitch-ext` route: 503s if the extension isn't configured, then verifies the
 * `Authorization: Bearer <JWT>` header and decorates `request.twitchExt`. A 401 here is intentionally generic
 * (`UnauthenticatedError`'s fixed "Authentication required." message) — the verifier's specific `reason`
 * (expired vs. bad signature vs. malformed, etc.) is logged, never sent to the client, so a caller probing for
 * a working secret can't distinguish "close" from "way off."
 */
export async function requireTwitchExtensionAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!isTwitchExtensionConfigured()) {
    throw extensionNotConfiguredError();
  }

  const token = bearerTokenFrom(request);
  if (!token) {
    throw new UnauthenticatedError();
  }

  const result = verifyTwitchExtensionJwt(token, env.TWITCH_EXTENSION_SECRET!);
  if (!result.ok) {
    request.log.info({ reason: result.reason }, 'Twitch extension JWT rejected');
    throw new UnauthenticatedError();
  }

  request.twitchExt = result.payload;
}

/**
 * Rate-limit key for `/twitch-ext/*` routes: per-viewer (`opaque_user_id`), not per-IP — many viewers of the
 * same stream share a broadcaster's IP-adjacent CDN/proxy pool, so per-IP limiting would either starve
 * legitimate viewers sharing an egress IP or be too loose to matter. Deliberately re-verifies the JWT itself
 * (cheap, pure, no I/O) rather than reading `request.twitchExt` — `@fastify/rate-limit`'s default hook runs at
 * `onRequest`, which fires BEFORE the `requireTwitchExtensionAuth` preHandler below, so that decoration doesn't
 * exist yet when this runs. Falls back to `request.ip` for a request with no usable token, so an
 * unauthenticated flood still gets *some* limiting instead of colliding on one shared bucket.
 */
export function twitchExtensionRateLimitKey(request: FastifyRequest): string {
  const token = bearerTokenFrom(request);
  if (token && env.TWITCH_EXTENSION_SECRET) {
    const result = verifyTwitchExtensionJwt(token, env.TWITCH_EXTENSION_SECRET);
    if (result.ok) return `twitchext:${result.payload.opaqueUserId}`;
  }
  return `twitchext-anon:${request.ip}`;
}
