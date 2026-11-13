import { test, expect, type Page } from '@playwright/test';
import {
  EMPTY_LEADERBOARD_MESSAGE,
  INVALID_GUILD_MESSAGE,
  NOT_PUBLIC_MESSAGE,
} from '../src/lib/public/leaderboard';

const DEMO_GUILD_ID = '000000000000000000';
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function isPublicLeaderboardRequest(url: string, guildId = DEMO_GUILD_ID): boolean {
  try {
    const parsed = new URL(url);
    const expected = new URL(
      `/guilds/${guildId}/engagement/leaderboard/public`,
      API_ORIGIN.endsWith('/') ? API_ORIGIN : `${API_ORIGIN}/`,
    );
    return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
  } catch {
    return false;
  }
}

async function mockPublicLeaderboard(
  page: Page,
  body: unknown,
  status = 200,
): Promise<void> {
  await page.route(
    (url) => isPublicLeaderboardRequest(url.toString()),
    async (route) => {
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    },
  );
}

test.describe('public XP leaderboard', () => {
  test('shows a friendly message for an invalid guild id without calling the API', async ({
    page,
  }) => {
    let leaderboardCalled = false;
    await page.route(
      (url) => url.toString().includes('/engagement/leaderboard/public'),
      async (route) => {
        leaderboardCalled = true;
        await route.abort();
      },
    );

    await page.goto('/leaderboard/not-a-guild');

    await expect(page.getByRole('heading', { name: 'XP Leaderboard', level: 1 })).toBeVisible();
    await expect(page.getByText(INVALID_GUILD_MESSAGE)).toBeVisible();
    expect(leaderboardCalled).toBe(false);
  });

  test('shows the not-public state when the API returns 404', async ({ page }) => {
    await mockPublicLeaderboard(
      page,
      { error: { code: 'not_found', message: 'Leaderboard not found.' } },
      404,
    );

    await page.goto(`/leaderboard/${DEMO_GUILD_ID}`);

    await expect(page.getByRole('heading', { name: 'XP Leaderboard', level: 1 })).toBeVisible();
    await expect(page.getByText(NOT_PUBLIC_MESSAGE)).toBeVisible();
    await expect(page.getByText('Leaderboard not found.')).toHaveCount(0);
  });

  test('shows the empty state when the leaderboard is public but has no members', async ({
    page,
  }) => {
    await mockPublicLeaderboard(page, {
      guildId: DEMO_GUILD_ID,
      items: [],
      nextCursor: null,
      total: 0,
    });

    await page.goto(`/leaderboard/${DEMO_GUILD_ID}`);

    await expect(page.getByRole('heading', { name: 'XP Leaderboard', level: 1 })).toBeVisible();
    await expect(page.getByText(EMPTY_LEADERBOARD_MESSAGE)).toBeVisible();
  });

  test('renders a public row', async ({ page }) => {
    await mockPublicLeaderboard(page, {
      guildId: DEMO_GUILD_ID,
      items: [
        {
          rank: 1,
          userId: '111111111111111111',
          username: 'ada',
          globalName: 'Ada Lovelace',
          avatarUrl: null,
          xp: 1500,
          level: 8,
        },
        {
          rank: 2,
          userId: '222222222222222222',
          username: null,
          globalName: null,
          avatarUrl: null,
          xp: 200,
          level: 2,
        },
      ],
      nextCursor: null,
      total: 2,
    });

    await page.goto(`/leaderboard/${DEMO_GUILD_ID}`);

    await expect(page.getByRole('heading', { name: 'XP Leaderboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
    await expect(page.getByText('1,500')).toBeVisible();
    await expect(page.getByText('Unknown user')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Messages' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Voice' })).toHaveCount(0);
  });
});
