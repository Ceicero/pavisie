import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';
import { API_BASE_URL, apiFetch, setCsrfToken } from '../src/lib/dashboard/api';
import { creatorFetch, setCreatorCsrfToken } from '../src/lib/creator/api';
import { creatorLoginUrl } from '../src/lib/creator/session';

/**
 * The creator dashboard (`/creator/**`, docs/ARCHITECTURE.md section 19e) is a separate surface from the Discord
 * dashboard: its own session (`csid`), its own CSRF token, and it must stay reachable to signed-out visitors
 * because `/creator` is also its public landing page.
 */

describe('creator dashboard and the web middleware', () => {
  const originalCookieDomain = process.env.COOKIE_DOMAIN;
  const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

  afterEach(() => {
    if (originalCookieDomain === undefined) delete process.env.COOKIE_DOMAIN;
    else process.env.COOKIE_DOMAIN = originalCookieDomain;
    if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
  });

  it('never redirects /creator for a signed-out visitor, even with COOKIE_DOMAIN configured', () => {
    process.env.COOKIE_DOMAIN = '.pavisie.com';
    process.env.NEXT_PUBLIC_API_URL = 'https://api.pavisie.com';

    for (const path of ['/creator', '/creator/anything']) {
      const noCookies = middleware(
        new NextRequest(`https://pavisie.com${path}`, { headers: { host: 'pavisie.com' } }),
      );
      expect(noCookies.headers.get('location')).toBeNull();

      // A Discord `sid` (or a creator `csid`) cookie makes no difference either: only /dashboard is gated.
      const withCookies = middleware(
        new NextRequest(`https://pavisie.com${path}`, {
          headers: { host: 'pavisie.com', cookie: 'sid=abc; csid=def' },
        }),
      );
      expect(withCookies.headers.get('location')).toBeNull();
    }
  });
});

describe('creator API client', () => {
  let calls: { url: string; headers: Headers; method: string }[];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, headers: new Headers(init.headers), method: String(init.method) });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
    setCreatorCsrfToken(null);
  });

  it('sends the CREATOR csrf token on creator mutations, never the Discord dashboard one', async () => {
    setCsrfToken('discord-token');
    setCreatorCsrfToken('creator-token');

    await creatorFetch('/creator/twitch/channel/commands', { method: 'POST', body: { name: 'a', response: 'b' } });
    expect(calls[0].headers.get('X-CSRF-Token')).toBe('creator-token');
    expect(calls[0].url).toBe(`${API_BASE_URL}/creator/twitch/channel/commands`);
  });

  it('does not fall back to the Discord token when there is no creator token', async () => {
    setCsrfToken('discord-token');
    setCreatorCsrfToken(null);

    await creatorFetch('/creator/logout', { method: 'POST' });
    expect(calls[0].headers.has('X-CSRF-Token')).toBe(false);
  });

  it('leaves the Discord dashboard client on its own token', async () => {
    setCsrfToken('discord-token');
    setCreatorCsrfToken('creator-token');

    await apiFetch('/guilds/1/config', { method: 'PATCH', body: { a: 1 } });
    expect(calls[0].headers.get('X-CSRF-Token')).toBe('discord-token');
  });

  it('does not attach any token to reads', async () => {
    setCreatorCsrfToken('creator-token');
    await creatorFetch('/creator/me');
    expect(calls[0].headers.has('X-CSRF-Token')).toBe(false);
  });

  it('builds the platform-scoped login URL', () => {
    expect(creatorLoginUrl('twitch')).toBe(`${API_BASE_URL}/creator/auth/twitch/login`);
  });
});

describe('creator dashboard: connect a Discord server (phase 3)', () => {
  it('"Connect a Discord server" is a plain link to the API, which starts the Discord sign-in', async () => {
    const { creatorDiscordConnectUrl } = await import('../src/lib/creator/queries');
    expect(creatorDiscordConnectUrl).toBe(`${API_BASE_URL}/creator/twitch/discord/connect`);
  });

  it('the Discord routes are creator-session routes: the creator token is attached, never the Discord dashboard one', async () => {
    setCsrfToken('discord-dashboard-token');
    setCreatorCsrfToken('creator-token');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await creatorFetch('/creator/twitch/discord/link', { method: 'DELETE' });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('creator-token');
    vi.unstubAllGlobals();
    setCsrfToken(null);
    setCreatorCsrfToken(null);
  });
});
