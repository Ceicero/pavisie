import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { publicLeaderboardHref } from '../src/components/dashboard/engagement/leveling-tab';

function sourceOf(relativeFromTest: string): string {
  return readFileSync(fileURLToPath(new URL(relativeFromTest, import.meta.url)), 'utf8');
}

describe('publicLeaderboardHref', () => {
  it('returns the public path only when the saved flag is exactly true', () => {
    expect(publicLeaderboardHref('123456789012345678', true)).toBe('/leaderboard/123456789012345678');
    expect(publicLeaderboardHref('guild/id', true)).toBe('/leaderboard/guild%2Fid');
    expect(publicLeaderboardHref('123456789012345678', false)).toBeNull();
    expect(publicLeaderboardHref('123456789012345678', undefined)).toBeNull();
  });
});

describe('Leveling tab public leaderboard link', () => {
  it('calls publicLeaderboardHref with the saved flag and never the draft', () => {
    const tab = sourceOf('../src/components/dashboard/engagement/leveling-tab.tsx');
    const calls = [...tab.matchAll(/publicLeaderboardHref\(([^)]*)\)/g)].map((match) =>
      match[1].replace(/\s+/g, ' ').trim(),
    );
    const invocations = calls.filter((args) => args.includes('data.leveling.publicLeaderboard'));

    expect(invocations).toEqual(['guildId, data.leveling.publicLeaderboard']);
    expect(calls.some((args) => args.includes('draft'))).toBe(false);
    expect(tab).toContain('asChild');
    expect(tab).toContain('target="_blank"');
    expect(tab).toContain('rel="noopener noreferrer"');
    expect(tab).toContain('Open public leaderboard');
    expect(tab).toContain('href={publicHref}');
  });
});
