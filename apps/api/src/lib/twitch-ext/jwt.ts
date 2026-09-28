// Verifier for the JWT the Twitch Extensions Helper (`twitch-ext.min.js`) attaches to every EBS request, per
// Twitch's "Extension Backend Service" auth spec: https://dev.twitch.tv/docs/extensions/reference/#anatomy-of-a-jwt
// A standalone, framework-free module (no Fastify/Prisma imports) so it can be unit-tested in isolation and
// reused by any future /twitch-ext route without re-deriving the crypto. Deliberately hand-rolled with
// `node:crypto` instead of a JWT library (CLAUDE.md "prefer Node built-ins"; HS256-only verification is a small,
// fully-auditable amount of code) — this is NOT a general-purpose JWT library: it only ever verifies HS256, only
// ever reads the handful of claims Twitch's extension JWT carries, and never *signs* anything.
//
// Security-critical: this is the only thing standing between an internet request and "acts as this Twitch
// viewer/broadcaster." Every failure path returns `{ ok: false }` and never throws, so a route can always do
// `if (!result.ok) return 401` without a try/catch. The `reason` field is for our own logs/tests only — the
// route must never echo it back to the caller (no detail leakage on a 401).

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Twitch's `role` claim values (broadcaster/moderator/viewer/external). Kept as `string` rather than a union
 * since Twitch may add roles later and we only ever compare it, never branch exhaustively on it. */
export interface TwitchExtJwtPayload {
  /** The Twitch channel (broadcaster) id the extension is installed/active on. */
  channelId: string;
  /** A per-viewer, per-extension pseudonymous id. Always present, even when identity isn't shared. */
  opaqueUserId: string;
  /** The viewer's real numeric Twitch user id — present ONLY when they've shared identity with the extension
   * (`Twitch.ext.actions.requestIdShare()` / "Request Identity Link" was granted). `null` otherwise. */
  userId: string | null;
  role: string;
}

export type VerifyTwitchExtensionJwtResult =
  | { ok: true; payload: TwitchExtJwtPayload }
  | {
      ok: false;
      /** Internal-only — for logs/tests. Never send this to the client (no detail leakage on 401). */
      reason: 'malformed' | 'unsupported_alg' | 'bad_signature' | 'expired' | 'invalid_claims';
    };

function decodeBase64UrlJson(segment: string): unknown {
  // `Buffer.from(str, 'base64url')` (Node >=15) accepts both padded and unpadded base64url — exactly what JWT
  // segments use (RFC 7515 §2: base64url-encoded, no padding).
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(json);
}

/**
 * Verifies a Twitch Extension Helper JWT. HS256 only — any other `alg` (including `none`) is rejected before
 * the signature is even inspected, which is what closes the classic "alg confusion" / "alg:none" JWT attack.
 * `secretBase64` is the extension's shared secret exactly as the Twitch dev console shows it (base64-encoded);
 * it is base64-decoded here to get the raw HMAC key bytes, per Twitch's own spec. Signature comparison uses
 * `node:crypto`'s constant-time `timingSafeEqual`. `nowMs` is injectable for deterministic expiry tests.
 */
export function verifyTwitchExtensionJwt(
  token: unknown,
  secretBase64: string,
  nowMs: number = Date.now(),
): VerifyTwitchExtensionJwtResult {
  try {
    if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'malformed' };

    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [headerB64, payloadB64, signatureB64] = parts;
    if (!headerB64 || !payloadB64 || !signatureB64) return { ok: false, reason: 'malformed' };

    let header: unknown;
    let payload: unknown;
    try {
      header = decodeBase64UrlJson(headerB64);
      payload = decodeBase64UrlJson(payloadB64);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!header || typeof header !== 'object') return { ok: false, reason: 'malformed' };
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };

    // Reject every alg except HS256 — explicitly, BEFORE any signature comparison. This is what stops both
    // `alg: none` (no signature to forge at all) and `alg: HS384`/anything else (a different, unintended
    // verification path) from ever reaching the crypto below.
    const alg = (header as { alg?: unknown }).alg;
    if (alg !== 'HS256') return { ok: false, reason: 'unsupported_alg' };

    let key: Buffer;
    try {
      key = Buffer.from(secretBase64, 'base64');
    } catch {
      return { ok: false, reason: 'bad_signature' };
    }
    if (key.length === 0) return { ok: false, reason: 'bad_signature' };

    const expectedSig = createHmac('sha256', key).update(`${headerB64}.${payloadB64}`).digest();
    let providedSig: Buffer;
    try {
      providedSig = Buffer.from(signatureB64, 'base64url');
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    // Buffers of different length would throw inside timingSafeEqual — check first rather than try/catch so a
    // length mismatch takes the exact same branch (and, as close as JS timing allows, the same shape) as a
    // same-length-but-wrong signature.
    if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
      return { ok: false, reason: 'bad_signature' };
    }

    const claims = payload as Record<string, unknown>;

    const exp = claims.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, reason: 'invalid_claims' };
    if (exp * 1000 < nowMs) return { ok: false, reason: 'expired' };

    const channelId = claims.channel_id;
    const opaqueUserId = claims.opaque_user_id;
    const role = claims.role;
    if (typeof channelId !== 'string' || channelId.length === 0) return { ok: false, reason: 'invalid_claims' };
    if (typeof opaqueUserId !== 'string' || opaqueUserId.length === 0) {
      return { ok: false, reason: 'invalid_claims' };
    }
    if (typeof role !== 'string' || role.length === 0) return { ok: false, reason: 'invalid_claims' };

    const userIdClaim = claims.user_id;
    const userId = typeof userIdClaim === 'string' && userIdClaim.length > 0 ? userIdClaim : null;

    return { ok: true, payload: { channelId, opaqueUserId, userId, role } };
  } catch {
    // Never throw — any unexpected shape (e.g. a non-object JSON payload, a Buffer decode edge case) is just
    // another malformed token from this function's point of view.
    return { ok: false, reason: 'malformed' };
  }
}
