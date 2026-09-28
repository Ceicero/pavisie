import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyTwitchExtensionJwt } from '../src/lib/twitch-ext/jwt';

const SECRET_BASE64 = Buffer.from('super-secret-extension-key-bytes').toString('base64');

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

interface SignOptions {
  alg?: string;
  secretBase64?: string;
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
}

/** Builds a real (or deliberately broken) Twitch extension JWT for test fixtures. */
function makeToken(options: SignOptions = {}): string {
  const header = { alg: options.alg ?? 'HS256', typ: 'JWT', ...options.header };
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = {
    exp: nowSec + 300,
    channel_id: '123456789',
    opaque_user_id: 'AU1234567',
    role: 'viewer',
    ...options.claims,
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = Buffer.from(options.secretBase64 ?? SECRET_BASE64, 'base64');
  const sig = createHmac('sha256', key).update(signingInput).digest();
  return `${headerB64}.${payloadB64}.${b64url(sig)}`;
}

describe('verifyTwitchExtensionJwt', () => {
  it('accepts a validly-signed HS256 token and extracts its claims', () => {
    const token = makeToken({ claims: { user_id: '999888777' } });
    const result = verifyTwitchExtensionJwt(token, SECRET_BASE64);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.payload).toEqual({
      channelId: '123456789',
      opaqueUserId: 'AU1234567',
      userId: '999888777',
      role: 'viewer',
    });
  });

  it('sets userId to null when identity was not shared (no user_id claim)', () => {
    const token = makeToken();
    const result = verifyTwitchExtensionJwt(token, SECRET_BASE64);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.payload.userId).toBeNull();
  });

  it('rejects a token signed with the wrong secret (bad signature)', () => {
    const token = makeToken({ secretBase64: Buffer.from('a-totally-different-secret').toString('base64') });
    const result = verifyTwitchExtensionJwt(token, SECRET_BASE64);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token whose payload was tampered with after signing (bad signature)', () => {
    const token = makeToken({ claims: { role: 'viewer' } });
    const [headerB64, , sigB64] = token.split('.');
    const tamperedPayload = b64url(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 300,
        channel_id: '123456789',
        opaque_user_id: 'AU1234567',
        role: 'broadcaster', // escalated after the fact
      }),
    );
    const tampered = `${headerB64}.${tamperedPayload}.${sigB64}`;
    const result = verifyTwitchExtensionJwt(tampered, SECRET_BASE64);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects alg:none (unsigned token attack) even with an empty signature segment', () => {
    const header = { alg: 'none', typ: 'JWT' };
    const claims = { exp: Math.floor(Date.now() / 1000) + 300, channel_id: 'c1', opaque_user_id: 'o1', role: 'viewer' };
    const token = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}.`;
    const result = verifyTwitchExtensionJwt(token, SECRET_BASE64);
    // An empty third segment is caught by the "3 non-empty parts" structural check first — still a firm
    // rejection either way, but assert the exact reason via the non-empty-signature variant below too.
    expect(result.ok).toBe(false);
  });

  it('rejects alg:none with a non-empty (garbage) signature segment — the alg check runs before signature verification', () => {
    const header = { alg: 'none', typ: 'JWT' };
    const claims = { exp: Math.floor(Date.now() / 1000) + 300, channel_id: 'c1', opaque_user_id: 'o1', role: 'viewer' };
    const token = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}.${b64url('ignored')}`;
    const result = verifyTwitchExtensionJwt(token, SECRET_BASE64);
    expect(result).toEqual({ ok: false, reason: 'unsupported_alg' });
  });

  it('rejects an unsupported alg (e.g. HS384) even with a technically-correct signature shape', () => {
    const token = makeToken({ alg: 'HS384' });
    const result = verifyTwitchExtensionJwt(token, SECRET_BASE64);
    expect(result).toEqual({ ok: false, reason: 'unsupported_alg' });
  });

  it('rejects an expired token', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = makeToken({ claims: { exp: nowSec - 60 } });
    const result = verifyTwitchExtensionJwt(token, SECRET_BASE64);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a token exactly at the expiry boundary is rejected once past it (deterministic via nowMs)', () => {
    const expSec = 1_000_000;
    const token = makeToken({ claims: { exp: expSec } });
    const stillValid = verifyTwitchExtensionJwt(token, SECRET_BASE64, expSec * 1000 - 1000);
    const expired = verifyTwitchExtensionJwt(token, SECRET_BASE64, expSec * 1000 + 1);
    expect(stillValid.ok).toBe(true);
    expect(expired).toEqual({ ok: false, reason: 'expired' });
  });

  it.each([
    ['empty string', ''],
    ['not a JWT at all', 'not-a-jwt'],
    ['only two segments', 'aGVhZGVy.cGF5bG9hZA'],
    ['four segments', 'a.b.c.d'],
    ['header is not valid base64url JSON', `${'!!!not-base64!!!'}.${b64url('{}')}.${b64url('sig')}`],
    ['payload is not valid JSON', `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url('not-json')}.${b64url('sig')}`],
  ])('rejects malformed input: %s', (_label, malformed) => {
    const result = verifyTwitchExtensionJwt(malformed, SECRET_BASE64);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-string token (defensive — a route might pass through a bad header value)', () => {
    expect(verifyTwitchExtensionJwt(undefined, SECRET_BASE64)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyTwitchExtensionJwt(null, SECRET_BASE64)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyTwitchExtensionJwt(12345, SECRET_BASE64)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects when the configured secret is empty (missing/misconfigured env)', () => {
    const token = makeToken();
    const result = verifyTwitchExtensionJwt(token, '');
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token missing required claims (channel_id/opaque_user_id/role/exp)', () => {
    const missingChannel = verifyTwitchExtensionJwt(makeToken({ claims: { channel_id: undefined } }), SECRET_BASE64);
    expect(missingChannel).toEqual({ ok: false, reason: 'invalid_claims' });

    const missingOpaque = verifyTwitchExtensionJwt(makeToken({ claims: { opaque_user_id: undefined } }), SECRET_BASE64);
    expect(missingOpaque).toEqual({ ok: false, reason: 'invalid_claims' });

    const missingRole = verifyTwitchExtensionJwt(makeToken({ claims: { role: undefined } }), SECRET_BASE64);
    expect(missingRole).toEqual({ ok: false, reason: 'invalid_claims' });

    const missingExp = verifyTwitchExtensionJwt(makeToken({ claims: { exp: undefined } }), SECRET_BASE64);
    expect(missingExp).toEqual({ ok: false, reason: 'invalid_claims' });
  });

  it('never throws on wildly malformed input', () => {
    expect(() => verifyTwitchExtensionJwt('....', SECRET_BASE64)).not.toThrow();
    expect(() => verifyTwitchExtensionJwt('a.b.c', SECRET_BASE64)).not.toThrow();
    expect(() => verifyTwitchExtensionJwt('🙂.🙂.🙂', SECRET_BASE64)).not.toThrow();
  });
});
