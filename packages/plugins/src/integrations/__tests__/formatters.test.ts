import { describe, expect, it } from 'vitest';
import { formatTwitchStreamEmbed } from '../formatters/twitch';
import { formatYoutubeUploadEmbed } from '../formatters/youtube';
import { formatRedditPostEmbed, isRedditPostNsfw } from '../formatters/reddit';

describe('formatTwitchStreamEmbed', () => {
  it('builds a live alert with the default template', () => {
    const embed = formatTwitchStreamEmbed({
      id: '1',
      user_id: '10',
      user_login: 'shroud',
      user_name: 'shroud',
      game_name: 'Valorant',
      title: 'ranked grind',
    });
    expect(embed.title).toBe('ranked grind');
    expect(embed.url).toBe('https://twitch.tv/shroud');
    expect(embed.description).toContain('shroud');
    expect(embed.description).toContain('Valorant');
    expect(embed.fields?.[0]).toMatchObject({ name: 'Playing', value: 'Valorant' });
  });

  it('fills a custom template', () => {
    const embed = formatTwitchStreamEmbed(
      { id: '1', user_id: '10', user_login: 'x', user_name: 'X', title: 't' },
      { template: '{streamer} is live: {title}' },
    );
    expect(embed.description).toBe('X is live: t');
  });
});

describe('formatYoutubeUploadEmbed', () => {
  it('builds an upload alert', () => {
    const embed = formatYoutubeUploadEmbed({
      videoId: 'abc123',
      title: 'New video',
      channelTitle: 'MyChannel',
      publishedAt: '2026-01-01T00:00:00Z',
    });
    expect(embed.url).toBe('https://www.youtube.com/watch?v=abc123');
    expect(embed.title).toBe('New video');
    expect(embed.description).toContain('MyChannel');
  });
});

describe('formatRedditPostEmbed / isRedditPostNsfw', () => {
  const post = {
    id: 't3_1',
    title: 'Cool build',
    author: 'someone',
    subreddit: 'gaming',
    permalink: '/r/gaming/comments/1',
    over18: false,
  };

  it('builds a post alert', () => {
    const embed = formatRedditPostEmbed(post);
    expect(embed.url).toBe('https://reddit.com/r/gaming/comments/1');
    expect(embed.description).toContain('r/gaming');
    expect(embed.description).toContain('someone');
  });

  it('flags NSFW posts', () => {
    expect(isRedditPostNsfw(post)).toBe(false);
    expect(isRedditPostNsfw({ ...post, over18: true })).toBe(true);
  });
});
