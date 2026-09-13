import { afterEach, describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

/**
 * This service's config dashboard moved to apps/web; these two path families are the only ones
 * that need to keep resolving for old app.pavisie.com bookmarks/links (see next.config.ts's
 * `redirects()` doc comment) — everything else must fall through to the app normally so the
 * upcoming ops console can add routes without fighting a catch-all.
 */
describe('redirects', () => {
  const originalWebUrl = process.env.WEB_URL;

  afterEach(() => {
    if (originalWebUrl === undefined) delete process.env.WEB_URL;
    else process.env.WEB_URL = originalWebUrl;
  });

  it('is scoped to exactly the root and /dashboard path families, not a catch-all', async () => {
    process.env.WEB_URL = 'https://pavisie.com';
    const redirects = await nextConfig.redirects!();
    expect(redirects.map((r) => r.source).sort()).toEqual(['/', '/dashboard', '/dashboard/:path*'].sort());
  });

  it('permanently (308) redirects / to WEB_URL with no trailing path', async () => {
    process.env.WEB_URL = 'https://pavisie.com';
    const redirects = await nextConfig.redirects!();
    const rootRedirect = redirects.find((r) => r.source === '/');
    expect(rootRedirect).toEqual({ source: '/', destination: 'https://pavisie.com', permanent: true });
  });

  it('permanently redirects the bare /dashboard path, preserved under WEB_URL', async () => {
    process.env.WEB_URL = 'https://pavisie.com';
    const redirects = await nextConfig.redirects!();
    const bareRedirect = redirects.find((r) => r.source === '/dashboard');
    expect(bareRedirect).toEqual({
      source: '/dashboard',
      destination: 'https://pavisie.com/dashboard',
      permanent: true,
    });
  });

  it('permanently redirects every /dashboard/* path, preserving the rest of the path (e.g. /dashboard/123/automod)', async () => {
    process.env.WEB_URL = 'https://pavisie.com';
    const redirects = await nextConfig.redirects!();
    const wildcardRedirect = redirects.find((r) => r.source === '/dashboard/:path*');
    expect(wildcardRedirect).toEqual({
      source: '/dashboard/:path*',
      destination: 'https://pavisie.com/dashboard/:path*',
      permanent: true,
    });
  });

  it('strips a trailing slash from WEB_URL so the destination never ends up with a double slash', async () => {
    process.env.WEB_URL = 'https://pavisie.com/';
    const redirects = await nextConfig.redirects!();
    expect(redirects.find((r) => r.source === '/')?.destination).toBe('https://pavisie.com');
  });

  it('falls back to the local web dev URL (not the production domain) when WEB_URL is unset, so local dev never bounces to the real site', async () => {
    delete process.env.WEB_URL;
    const redirects = await nextConfig.redirects!();
    expect(redirects.find((r) => r.source === '/')?.destination).toBe('http://localhost:3003');
  });
});
