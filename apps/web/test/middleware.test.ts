import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';

function makeRequest(
  path: string,
  opts: { cookie?: string; host?: string; forwardedHost?: string; url?: string } = {},
): NextRequest {
  const host = opts.host ?? 'pavisie.com';
  const headers: Record<string, string> = { host };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.forwardedHost) headers['x-forwarded-host'] = opts.forwardedHost;
  return new NextRequest(opts.url ?? `https://${host}${path}`, { headers });
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

  /**
   * The guard that keeps a domain move from locking everyone out. `sid` reaches this middleware
   * only when the serving origin is inside COOKIE_DOMAIN; anywhere else its absence means "not
   * sent", not "not signed in", and acting on that would redirect every visitor — including
   * signed-in ones — straight back into the login flow.
   */
  describe('when this origin is outside COOKIE_DOMAIN (mid-move, or a preview host)', () => {
    it('does not redirect a signed-in visitor whose cookie is scoped to the old domain', () => {
      // The entrophybot.com -> pavisie.com cutover state: the browser holds a valid `.entrophybot.com`
      // sid, but it is never sent to pavisie.com, so a naive check reads "signed out" for everyone.
      process.env.COOKIE_DOMAIN = '.entrophybot.com';
      process.env.NEXT_PUBLIC_API_URL = 'https://api.pavisie.com';
      const res = middleware(makeRequest('/dashboard/123', { host: 'pavisie.com' }));
      expect(res.headers.get('location')).toBeNull();
    });

    it('does not treat a lookalike domain as being inside COOKIE_DOMAIN', () => {
      // notpavisie.com ends with "pavisie.com" as a raw string but is a different registrable
      // domain that never receives the cookie — the match must be on the dot boundary.
      process.env.COOKIE_DOMAIN = '.pavisie.com';
      process.env.NEXT_PUBLIC_API_URL = 'https://api.pavisie.com';
      const res = middleware(makeRequest('/dashboard/123', { host: 'notpavisie.com' }));
      expect(res.headers.get('location')).toBeNull();
    });

    it('still redirects on a subdomain that is genuinely inside COOKIE_DOMAIN', () => {
      process.env.COOKIE_DOMAIN = '.pavisie.com';
      process.env.NEXT_PUBLIC_API_URL = 'https://api.pavisie.com';
      const res = middleware(makeRequest('/dashboard/123', { host: 'app.pavisie.com' }));
      expect(res.headers.get('location')).toBe('https://api.pavisie.com/auth/discord/login');
    });

    /**
     * Regression: the guard originally read `request.nextUrl.hostname`, which behind Railway's
     * edge proxy is the internal address the container was reached on — not the domain the
     * visitor typed. That made the check fail closed on every production request and silently
     * killed the redirect, while tests that build a request straight from the public URL still
     * passed. The public host has to come from the forwarded headers.
     */
    it('reads the public host from x-forwarded-host, not the proxied URL', () => {
      process.env.COOKIE_DOMAIN = '.pavisie.com';
      process.env.NEXT_PUBLIC_API_URL = 'https://api.pavisie.com';
      const res = middleware(
        makeRequest('/dashboard/123', {
          url: 'http://10.0.1.7:8080/dashboard/123',
          forwardedHost: 'pavisie.com',
        }),
      );
      expect(res.headers.get('location')).toBe('https://api.pavisie.com/auth/discord/login');
    });

    it('takes the first entry of a chained x-forwarded-host and ignores the port', () => {
      process.env.COOKIE_DOMAIN = '.pavisie.com';
      process.env.NEXT_PUBLIC_API_URL = 'https://api.pavisie.com';
      const res = middleware(
        makeRequest('/dashboard/123', {
          url: 'http://10.0.1.7:8080/dashboard/123',
          forwardedHost: 'pavisie.com:443, inner.railway.internal',
        }),
      );
      expect(res.headers.get('location')).toBe('https://api.pavisie.com/auth/discord/login');
    });

    it('still refuses a forwarded host outside COOKIE_DOMAIN', () => {
      process.env.COOKIE_DOMAIN = '.pavisie.com';
      process.env.NEXT_PUBLIC_API_URL = 'https://api.pavisie.com';
      const res = middleware(
        makeRequest('/dashboard/123', {
          url: 'http://10.0.1.7:8080/dashboard/123',
          forwardedHost: 'entrophybot.com',
        }),
      );
      expect(res.headers.get('location')).toBeNull();
    });

    it('still redirects when COOKIE_DOMAIN is written without a leading dot', () => {
      process.env.COOKIE_DOMAIN = 'pavisie.com';
      process.env.NEXT_PUBLIC_API_URL = 'https://api.pavisie.com';
      const res = middleware(makeRequest('/dashboard/123', { host: 'pavisie.com' }));
      expect(res.headers.get('location')).toBe('https://api.pavisie.com/auth/discord/login');
    });
  });
});
