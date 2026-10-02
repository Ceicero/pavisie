import { test, expect } from '@playwright/test';
import commands from '../src/data/commands.json';

/**
 * Smoke tests for the public website (ARCHITECTURE.md §17). No API and no auth needed: these pages are public,
 * and the ones that do call the API (donate) are written to degrade gracefully when it's unreachable — which is
 * exactly the environment this suite runs in (nothing listens on `NEXT_PUBLIC_API_URL` here). Unlike the
 * dashboard suite these tests never skip; they don't depend on `E2E_API_URL`.
 */

test.describe('home page', () => {
  test('renders the hero and primary nav links', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Commands' })).toHaveAttribute('href', '/features');
    await expect(nav.getByRole('link', { name: 'Enforcer' })).toHaveAttribute('href', '/enforcer');
    await expect(nav.getByRole('link', { name: 'Donate' })).toHaveAttribute('href', '/donate');
    await expect(nav.getByRole('link', { name: 'Streamers' })).toHaveAttribute('href', '/creator');
  });

  test('offers both entry points: Discord servers and streamers', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'For Discord servers', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'For streamers', level: 2 }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Twitch' }).first()).toHaveAttribute(
      'href',
      /\/creator\/auth\/twitch\/login$/,
    );
  });
});

test.describe('features page', () => {
  test('lists all registered plugins', async ({ page }) => {
    await page.goto('/features');

    // Generated straight from the plugin registry (see apps/web/src/data/commands.json, produced by
    // `pnpm commands:export`) — this assertion can't drift from what plugins actually exist.
    expect(commands.plugins.length).toBeGreaterThan(0);

    for (const plugin of commands.plugins) {
      await expect(
        page.locator(`#${plugin.id}`).getByRole('heading', { name: plugin.name, level: 2 }),
      ).toBeVisible();
    }
  });
});

test.describe('donate page', () => {
  test('shows the unavailable state when the API is down', async ({ page }) => {
    await page.goto('/donate');

    await expect(page.getByRole('heading', { name: /donations aren.t set up yet/i })).toBeVisible();
  });
});
