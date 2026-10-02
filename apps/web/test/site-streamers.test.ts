import { describe, expect, it } from 'vitest';
import { SITE_LINKS } from '../src/components/TopBar';
import { siteCopy } from '../src/content/site';
import { pluginCopy } from '../src/content/plugins';
import { creatorLoginUrl } from '../src/lib/creator/login-url';
import { creatorLoginUrl as sessionLoginUrl } from '../src/lib/creator/session';
import sitemap from '../src/app/sitemap';

/**
 * The public site has two entry points (Discord servers, and streamers at /creator). These guard that the
 * streamer path stays discoverable and that the copy stays honest about what is and is not live.
 */
describe('streamer entry point on the public site', () => {
  it('the top bar nav (and so the hamburger) links to /creator', () => {
    expect(SITE_LINKS).toContainEqual({ href: '/creator', label: 'Streamers' });
  });

  it('the homepage sign-in link is the same URL the creator dashboard uses', () => {
    expect(creatorLoginUrl('twitch')).toBe(sessionLoginUrl('twitch'));
    expect(creatorLoginUrl('twitch')).toMatch(/\/creator\/auth\/twitch\/login$/);
  });

  it('/creator is in the sitemap', () => {
    expect(sitemap().some((entry) => entry.url.endsWith('/creator'))).toBe(true);
  });

  it('explains the live features and the three start steps, and says a Discord server is optional', () => {
    const { features, steps } = siteCopy.streamers;
    expect(features.map((f) => f.title).join(' ')).toMatch(/chat bot/i);
    expect(features.map((f) => f.title).join(' ')).toMatch(/channel-point/i);
    expect(features.map((f) => f.title).join(' ')).toMatch(/currency/i);
    expect(features.some((f) => /optional/i.test(f.title))).toBe(true);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatch(/sign in with twitch/i);
  });

  it('only mentions the Extension and Kick as coming soon', () => {
    const everything = JSON.stringify(siteCopy.streamers.features) + JSON.stringify(siteCopy.streamers.steps);
    expect(everything).not.toMatch(/extension|kick/i);
    expect(siteCopy.streamers.comingSoon).toMatch(/^Coming soon/);
  });

  it('the Integrations copy points Twitch chat at /creator instead of the Discord dashboard', () => {
    expect(pluginCopy.integrations.whyGaming.join(' ')).toContain('/creator');
  });
});
