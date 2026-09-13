import { test, expect } from '@playwright/test';

/**
 * Requires the API running locally with `E2E_TEST_MODE=true` (never enabled in production —
 * see docs/ARCHITECTURE.md §10). Skipped automatically when `E2E_API_URL` is not set so
 * `pnpm test:e2e` stays green on machines without the API up.
 */
const E2E_API_URL = process.env.E2E_API_URL;

test.describe('login', () => {
  test.skip(!E2E_API_URL, 'E2E_API_URL not set — skipping tests that require a running API');

  test('visiting /dashboard unauthenticated redirects to the landing page', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: /log in with discord/i })).toBeVisible();
  });

  test('test-login shows the guild selector', async ({ page, request }) => {
    const response = await request.post(`${E2E_API_URL}/auth/test-login`);
    expect(response.ok()).toBeTruthy();
    const setCookie = response.headers()['set-cookie'];
    expect(setCookie).toBeTruthy();

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: /your servers/i })).toBeVisible();
    await expect(page.getByText(/pavisie demo/i)).toBeVisible();
  });
});
