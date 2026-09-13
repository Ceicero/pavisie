import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';

function makeRequest(path: string, opts: { cookie?: string } = {}): NextRequest {
  return new NextRequest(`https://pavisie.com${path}`, {
    headers: opts.cookie ? { cookie: opts.cookie } : {},
  });
}

/**
 * Ported from the old apps/dashboard/src/middleware.test.ts as part of the dashboard→web merge.
 * The old middleware's `/` → Discord-login redirect is intentionally not covered here — `/` is
 * the marketing homepage in this app, not a login gate — see src/middleware.ts's doc comment.
 */
describe('web middleware (dashboard fast-redirect)', () => {
  const originalCookieDomain = process.env.COOKIE_DOMAIN;

  afterEach(() => {
    if (originalCookieDomain === undefined) delete process.env.COOKIE_DOMAIN;
    else process.env.COOKIE_DOMAIN = originalCookieDomain;
  });

  describe('when COOKIE_DOMAIN is unset (local dev — sid not trustworthy on this origin)', () => {
    it('never redirects, for any path or cookie state, leaving it to the client-side session gate', () => {
      delete process.env.COOKIE_DOMAIN;

      for (const req of [
        makeRequest('/'),
        makeRequest('/dashboard/123'),
        makeRequest('/dashboard/123', { cookie: 'sid=abc' }),
      ]) {
        const res = middleware(req);
        expect(res.headers.get('location')).toBeNull();
      }
    });
  });

  describe('when COOKIE_DOMAIN is configured (production — sid is trustworthy here)', () => {
    it('redirects a cookie-less /dashboard/* visit to /', () => {
      process.env.COOKIE_DOMAIN = '.pavisie.com';
      const res = middleware(makeRequest('/dashboard/123'));
      expect(res.headers.get('location')).toBe('https://pavisie.com/');
    });

    it('does NOT redirect /dashboard/* when a sid cookie is present, even though the session behind it is unverified here', () => {
      process.env.COOKIE_DOMAIN = '.pavisie.com';
      const res = middleware(makeRequest('/dashboard/123', { cookie: 'sid=abc' }));
      expect(res.headers.get('location')).toBeNull();
    });

    it('never touches marketing routes like / — it is not a login gate here', () => {
      process.env.COOKIE_DOMAIN = '.pavisie.com';
      const res = middleware(makeRequest('/'));
      expect(res.headers.get('location')).toBeNull();
    });
  });
});
