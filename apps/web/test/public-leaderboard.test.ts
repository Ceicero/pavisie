import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_LEADERBOARD_MESSAGE,
  INVALID_GUILD_MESSAGE,
  NOT_PUBLIC_MESSAGE,
  PUBLIC_LEADERBOARD_LIMIT,
  PublicLeaderboardError,
  UNKNOWN_USER_NAME,
  fetchPublicLeaderboard,
  isGuildSnowflake,
  isNotPublicError,
  leaderboardAvatarInitial,
  leaderboardDisplayName,
  publicLeaderboardQueryKeys,
} from '../src/lib/public/leaderboard';

function sourceOf(relativeFromTest: string): string {
  return readFileSync(fileURLToPath(new URL(relativeFromTest, import.meta.url)), 'utf8');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('public leaderboard helpers', () => {
  it('accepts 17–20 digit guild ids only', () => {
    expect(isGuildSnowflake('000000000000000000')).toBe(true);
    expect(isGuildSnowflake('12345678901234567')).toBe(true);
    expect(isGuildSnowflake('12345678901234567890')).toBe(true);
    expect(isGuildSnowflake('1234567890123456')).toBe(false);
    expect(isGuildSnowflake('123456789012345678901')).toBe(false);
    expect(isGuildSnowflake('not-a-snowflake')).toBe(false);
    expect(isGuildSnowflake('')).toBe(false);
  });

  it('prefers global name, then username, then a fallback', () => {
    expect(leaderboardDisplayName({ globalName: 'Ada', username: 'ada' })).toBe('Ada');
    expect(leaderboardDisplayName({ globalName: '  ', username: 'ada' })).toBe('ada');
    expect(leaderboardDisplayName({ globalName: null, username: 'ada' })).toBe('ada');
    expect(leaderboardDisplayName({ globalName: null, username: null })).toBe(UNKNOWN_USER_NAME);
  });

  it('falls back when every identity field is null', () => {
    const row = { globalName: null, username: null, avatarUrl: null };
    expect(leaderboardDisplayName(row)).toBe(UNKNOWN_USER_NAME);
    expect(leaderboardAvatarInitial(leaderboardDisplayName(row))).toBe('?');
    expect(leaderboardAvatarInitial('')).toBe('?');
    expect(leaderboardAvatarInitial('Ada')).toBe('A');
  });

  it('builds stable query keys', () => {
    expect(publicLeaderboardQueryKeys.page('g1')).toEqual(['public-leaderboard', 'g1', null]);
    expect(publicLeaderboardQueryKeys.page('g1', 'abc')).toEqual(['public-leaderboard', 'g1', 'abc']);
  });

  it('treats only a 404 PublicLeaderboardError as not-public', () => {
    expect(isNotPublicError(new PublicLeaderboardError('missing', { status: 404, code: 'not_found' }))).toBe(
      true,
    );
    expect(isNotPublicError(new PublicLeaderboardError('oops', { status: 500, code: 'internal' }))).toBe(
      false,
    );
    expect(isNotPublicError(new Error('nope'))).toBe(false);
  });
});

describe('fetchPublicLeaderboard', () => {
  it('GETs the public route without cookies and returns the payload', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.pavisie.com');
    const body = {
      guildId: '000000000000000000',
      items: [],
      nextCursor: null,
      total: 0,
    };
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPublicLeaderboard('000000000000000000')).resolves.toEqual(body);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.pavisie.com/guilds/000000000000000000/engagement/leaderboard/public?limit=${PUBLIC_LEADERBOARD_LIMIT}`,
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' }),
    );
  });

  it('forwards the cursor on later pages', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.pavisie.com');
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            guildId: '000000000000000000',
            items: [],
            nextCursor: null,
            total: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchPublicLeaderboard('000000000000000000', 'cursor-token');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`cursor=cursor-token.*limit=${PUBLIC_LEADERBOARD_LIMIT}`)),
      expect.objectContaining({ credentials: 'omit' }),
    );
  });

  it('throws a 404 PublicLeaderboardError when the route is not public', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.pavisie.com');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'not_found', message: 'Leaderboard not found.' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );

    const err = await fetchPublicLeaderboard('000000000000000000').catch((error: unknown) => error);
    expect(err).toBeInstanceOf(PublicLeaderboardError);
    expect(isNotPublicError(err)).toBe(true);
    expect((err as PublicLeaderboardError).status).toBe(404);
    expect((err as PublicLeaderboardError).message).toBe('Leaderboard not found.');
  });

  it('throws a network error when the API is unreachable', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.pavisie.com');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );

    const err = await fetchPublicLeaderboard('000000000000000000').catch((error: unknown) => error);
    expect(err).toBeInstanceOf(PublicLeaderboardError);
    expect(isNotPublicError(err)).toBe(false);
    expect((err as PublicLeaderboardError).status).toBe(0);
    expect((err as PublicLeaderboardError).code).toBe('network_error');
  });
});

describe('public leaderboard page conventions', () => {
  it('is a public unauthenticated page titled XP Leaderboard', () => {
    const page = sourceOf('../src/app/leaderboard/[guildId]/page.tsx');
    expect(page).toContain('headingLevel={1}');
    expect(page).toContain('title="XP Leaderboard"');
    expect(page).toContain("title: 'XP Leaderboard'");
    expect(page).toContain('INVALID_GUILD_MESSAGE');
    expect(page).toContain('isGuildSnowflake');
    expect(page).not.toContain('apiFetch');
    expect(page).not.toContain('leveling-tab');
    expect(page).not.toContain('/engagement/rank/');
  });

  it('uses cursorStack pagination, the 404 copy, and a session-less fetch', () => {
    const panel = sourceOf('../src/components/leaderboard/public-leaderboard.tsx');
    const lib = sourceOf('../src/lib/public/leaderboard.ts');
    expect(panel).toContain('cursorStack');
    expect(panel).toContain('NOT_PUBLIC_MESSAGE');
    expect(panel).toContain('EMPTY_LEADERBOARD_MESSAGE');
    expect(panel).toContain('isNotPublicError');
    expect(panel).toContain('fetchPublicLeaderboard');
    expect(panel).not.toContain('apiFetch');
    expect(panel).not.toContain("credentials: 'include'");
    expect(panel).not.toContain('/engagement/rank/');
    expect(lib).toContain("credentials: 'omit'");
    expect(lib).toContain("cache: 'no-store'");
    expect(lib).toContain('/engagement/leaderboard/public');
    expect(lib).not.toContain('apiFetch');
    expect(lib).not.toContain("credentials: 'include'");
    expect(lib).not.toContain('messages');
    expect(lib).not.toContain('voiceMinutes');
    expect(lib).not.toContain('formatVoiceMinutes');
    expect(panel).not.toContain('messages');
    expect(panel).not.toContain('voiceMinutes');
    expect(panel).not.toContain('formatVoiceMinutes');
    expect(panel).toContain('leaderboardAvatarInitial');
    expect(NOT_PUBLIC_MESSAGE).toBe("This leaderboard isn't public.");
    expect(EMPTY_LEADERBOARD_MESSAGE).toBe('No ranked members yet.');
    expect(INVALID_GUILD_MESSAGE).toBe("This isn't a valid leaderboard link.");
  });

  it('does not link the page from the site chrome, nav, or leveling tab', () => {
    const files = [
      '../src/components/TopBar.tsx',
      '../src/components/Footer.tsx',
      '../src/components/dashboard/nav.ts',
      '../src/components/dashboard/engagement/leveling-tab.tsx',
      '../src/app/page.tsx',
    ];
    for (const file of files) {
      const src = sourceOf(file);
      expect(src).not.toContain('/leaderboard/');
    }
  });
});
