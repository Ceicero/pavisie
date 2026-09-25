import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('redirects', () => {
  it('permanently redirects /commands to /features, so the name Brandon actually calls this page by ("the command page") resolves to the canonical URL', async () => {
    expect(nextConfig.redirects).toBeDefined();
    const redirects = await nextConfig.redirects!();
    const commandsRedirect = redirects.find((r) => r.source === '/commands');
    expect(commandsRedirect).toEqual({
      source: '/commands',
      destination: '/features',
      permanent: true,
    });
  });

  it('permanently redirects /link to /dashboard/account — the short link the Twitch chat bot tells viewers to use', async () => {
    expect(nextConfig.redirects).toBeDefined();
    const redirects = await nextConfig.redirects!();
    const linkRedirect = redirects.find((r) => r.source === '/link');
    expect(linkRedirect).toEqual({
      source: '/link',
      destination: '/dashboard/account',
      permanent: true,
    });
  });
});
