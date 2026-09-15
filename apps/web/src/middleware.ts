import { NextResponse, type NextRequest } from 'next/server';

/**
 * Fast-path for signed-out visitors to `/dashboard/*`: redirects at the edge before any client JS
 * runs, avoiding a flash of the loading skeleton. `app/dashboard/layout.tsx` does the same check
 * client-side via `useSession()` (`GET /auth/me`) and is authoritative — this is purely an
 * optimization layered in front of it, ported from the old `apps/dashboard/src/middleware.ts` as
 * part of the dashboard→web merge.
 *
 * Signed-out visitors to `/dashboard/*` are sent to Discord login, NOT to `/`. Bouncing them to
 * the marketing homepage left them with no way in at all: there is no sign-in control anywhere on
 * the site, so "Open dashboard" silently returned you to the page you started on. That stayed
 * invisible only while sessions happened to remain valid.
 *
 * Still deliberately NOT ported: the old middleware's other half, which redirected signed-out
 * visitors to `/` itself. That made sense when `/` was exclusively the dashboard's login gate;
 * here `/` is the marketing homepage, so redirecting anonymous visitors away from it would be a
 * regression. Only `/dashboard/*` redirects.
 *
 * Conservative by design, same as the old middleware: only acts when `COOKIE_DOMAIN` is
 * configured, which is the only case where the `sid` cookie is guaranteed visible on this origin
 * (see docs/ARCHITECTURE.md §11, §21). And only in the "no cookie" direction — a *present* `sid`
 * cookie does not prove a still-valid session (it can be stale/expired server-side while the
 * browser still holds it), so this never redirects `/` → `/dashboard` on cookie presence alone;
 * only `dashboard/layout.tsx`'s `useSession()` is authoritative for that direction.
 */
/**
 * The public hostname this request was made to, lowercased and without any port.
 *
 * NOT `request.nextUrl.hostname`: behind Railway's edge proxy that is the internal address the
 * container was reached on, not the domain the visitor typed. Using it made the COOKIE_DOMAIN
 * check below fail closed on every request — the fast-redirect silently stopped firing in
 * production while still passing tests that construct requests directly. The forwarded headers
 * carry the real host; `x-forwarded-host` may be a comma-separated chain, so take the first.
 */
function publicHostname(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const raw = forwarded?.split(',')[0]?.trim();
  return (raw && raw.length > 0 ? raw : request.nextUrl.hostname).replace(/:\d+$/, '').toLowerCase();
}

/**
 * Hosts kept resolving only so existing links survive. entrophybot.com is being let go in 2027, so
 * every request to it is answered with a permanent redirect to the same path on pavisie.com rather
 * than serving a second copy of the site: that consolidates search traffic onto the new domain and
 * stops anyone settling back onto the one with an expiry date.
 *
 * Done here rather than as a Cloudflare redirect rule because entrophybot.com's DNS record is
 * DNS-only — it points straight at Railway, so an edge rule never sees the traffic — and proxying
 * the record purely to redirect it would put Cloudflare's TLS termination in front of a domain that
 * currently works. `api.entrophybot.com` is a different service and is deliberately NOT covered:
 * Twitch EventSub callbacks and user-configured webhooks still point at it and must keep resolving
 * until they are migrated.
 */
const LEGACY_HOSTS = new Set(['entrophybot.com', 'www.entrophybot.com']);
const CANONICAL_ORIGIN = 'https://pavisie.com';

export function middleware(request: NextRequest) {
  const host = publicHostname(request);

  if (LEGACY_HOSTS.has(host)) {
    // 301: the conventional permanent redirect, and what search engines consolidate on. Its one
    // wrinkle — clients may turn a POST into a GET — costs nothing here, because nothing POSTs to
    // the marketing host: the dashboard's writes all go to api.pavisie.com.
    return NextResponse.redirect(
      new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, CANONICAL_ORIGIN),
      301,
    );
  }

  const cookieDomain = process.env.COOKIE_DOMAIN;
  if (!cookieDomain) {
    return NextResponse.next();
  }

  // The `sid` cookie is only visible to this middleware when THIS origin sits inside COOKIE_DOMAIN.
  // Where it does not, the cookie is missing from the *request* rather than from the browser, so a
  // `sid` check would read "signed out" for every visitor and bounce them all into a login loop.
  // That is precisely the state a domain move passes through — the site served from pavisie.com
  // while the session cookie is still scoped to .entrophybot.com — and it holds for any preview
  // host outside COOKIE_DOMAIN too. Defer to the client-side gate, which asks the API directly and
  // is authoritative either way.
  const bare = (cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain).toLowerCase();
  const cookieVisibleHere = host === bare || host.endsWith(`.${bare}`);
  if (!cookieVisibleHere) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has('sid');
  const { pathname } = request.nextUrl;

  if (!hasSession && pathname.startsWith('/dashboard')) {
    // Straight into the OAuth flow; the API's callback lands the user back on /dashboard.
    // Fall back to the homepage only if the API URL isn't configured, so a misconfiguration
    // degrades to the old behaviour rather than redirecting to a broken URL.
    const apiBase = process.env.NEXT_PUBLIC_API_URL;
    if (apiBase) {
      return NextResponse.redirect(`${apiBase}/auth/discord/login`);
    }
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // No longer scoped to /dashboard: the legacy-domain redirect above has to answer every URL on
  // the old host, not just the dashboard ones. Next's build output and the favicon are excluded —
  // they are never worth a middleware hop, and no person lands on them directly.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
