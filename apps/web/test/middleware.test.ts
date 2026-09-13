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
 * `/` itself is still never redirected — it is the marketing homepage in this app, not a login
 * gate. `/dashboard/*`, however, now starts the login flow rather than bouncing to `/`; see
 * src/middleware.ts's doc comment for why.
 */
describe('web middleware (dashboard fast-redirect)', () => {
  const originalCookieDomain = process.env.COOKIE_DOMAIN;
  const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

  afterEach(() => {
    if (originalCookieDomain === undefined) delete process.env.COOKIE_DOMAIN;
    else process.env.COOKIE_DOMAIN = originalCookieDomain;
    if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
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
    it('sends a cookie-less /dashboard/* visit into the Discord login flow', () => {
      // The whole point of the redirect: there is no sign-in control on the site, so sending
      // signed-out visitors to `/` left "Open dashboard" as a dead end with no way to log in.
      process.env.COOKIE_DOMAIN = '.pavisie.com';
      process.env.NEXT_PUBLIC_API_URL = 'https://api.pavisie.com';
      const res = middleware(makeRequest('/dashboard/123'));
      expect(res.headers.get('location')).toBe('https://api.pavisie.com/auth/discord/login');
    });

    it('falls back to / when the API URL is not configured, rather than redirecting to a broken URL', () => {
      process.env.COOKIE_DOMAIN = '.pavisie.com';
      delete process.env.NEXT_PUBLIC_API_URL;
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
