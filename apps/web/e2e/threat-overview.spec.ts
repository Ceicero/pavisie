import { test, expect } from '@playwright/test';

/**
 * Requires the API running locally with `E2E_TEST_MODE=true`. Skipped automatically when
 * `E2E_API_URL` is not set, matching `dashboard-config.spec.ts`.
 */
const E2E_API_URL = process.env.E2E_API_URL;
const DEMO_GUILD_ID = '000000000000000000';

test.describe('threat overview', () => {
  test.skip(!E2E_API_URL, 'E2E_API_URL not set — skipping tests that require a running API');

  test('shows the Threat overview heading after a test-login', async ({ page, request }) => {
    const loginResponse = await request.post(`${E2E_API_URL}/auth/test-login`);
    expect(loginResponse.ok()).toBeTruthy();

    await page.goto(`/dashboard/${DEMO_GUILD_ID}/threats`);
    await expect(page.getByRole('heading', { name: 'Threat overview' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Live threats' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Moderation audit trail' })).toBeVisible();
  });
});
