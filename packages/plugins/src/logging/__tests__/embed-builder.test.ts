import { describe, expect, it } from 'vitest';
import { EMBED_LIMITS } from '@pavisie/core';
import { buildLogEmbed } from '../embed-builder';

const GUILD_ID = '111111111111111111';

describe('buildLogEmbed', () => {
  it('falls back to the kind label as title, and includes description/actor/target/channel fields', () => {
    const embed = buildLogEmbed({
      kind: 'member.join',
      guildId: GUILD_ID,
      payload: {
        actorId: '222222222222222222',
        targetId: '333333333333333333',
        channelId: '444444444444444444',
        description: 'hello',
      },
    });
    const json = embed.toJSON();

    expect(json.title).toBe('Member joined');
    expect(json.description).toBe('hello');
    const fieldNames = (json.fields ?? []).map((f) => f.name);
    expect(fieldNames).toContain('Actor');
    expect(fieldNames).toContain('Target');
    expect(fieldNames).toContain('Channel');
  });

  it('uses payload.title when given, over the kind default', () => {
    const embed = buildLogEmbed({
      kind: 'role.update',
      guildId: GUILD_ID,
      payload: { title: 'Role deleted' },
    });
    expect(embed.toJSON().title).toBe('Role deleted');
  });

  it('builds a message jump link when channelId + messageId are both present', () => {
    const embed = buildLogEmbed({
      kind: 'message.delete',
      guildId: GUILD_ID,
      payload: { channelId: '444444444444444444', messageId: '555555555555555555' },
    });
    const messageField = embed.toJSON().fields?.find((f) => f.name === 'Message');
    expect(messageField?.value).toContain(
      `https://discord.com/channels/${GUILD_ID}/444444444444444444/555555555555555555`,
    );
  });

  it('omits the Target field when target equals actor (avoids a redundant duplicate field)', () => {
    const embed = buildLogEmbed({
      kind: 'moderation.action',
      guildId: GUILD_ID,
      payload: { actorId: '222222222222222222', targetId: '222222222222222222' },
    });
    const fieldNames = (embed.toJSON().fields ?? []).map((f) => f.name);
    expect(fieldNames).toContain('Actor');
    expect(fieldNames).not.toContain('Target');
  });

  it('truncates an overlong title and description to Discord embed limits', () => {
    const embed = buildLogEmbed({
      kind: 'guild.update',
      guildId: GUILD_ID,
      payload: {
        title: 'x'.repeat(EMBED_LIMITS.title + 50),
        description: 'y'.repeat(EMBED_LIMITS.description + 50),
      },
    });
    const json = embed.toJSON();
    expect(json.title!.length).toBeLessThanOrEqual(EMBED_LIMITS.title);
    expect(json.description!.length).toBeLessThanOrEqual(EMBED_LIMITS.description);
  });

  it('caps the number of fields at the Discord embed limit', () => {
    const fields = Array.from({ length: EMBED_LIMITS.fields + 10 }, (_, i) => ({
      name: `f${i}`,
      value: 'v',
    }));
    const embed = buildLogEmbed({ kind: 'automod.trigger', guildId: GUILD_ID, payload: { fields } });
    expect(embed.toJSON().fields!.length).toBeLessThanOrEqual(EMBED_LIMITS.fields);
  });

  it('never puts anything in a top-level message `content` — only the embed, so log posts can never trigger a mention ping even if a payload contains @everyone text', () => {
    const embed = buildLogEmbed({
      kind: 'message.delete',
      guildId: GUILD_ID,
      payload: { contentBefore: '@everyone hi <@123456789012345678>' },
    });
    // buildLogEmbed only ever returns an EmbedBuilder (no `content` string) — the caller (LoggingServiceImpl.sendBatch)
    // sends it via `channel.send({ embeds, allowedMentions: { parse: [] } })`, so raw mention text landing in an
    // embed field is inert (Discord does not resolve pings from embed text, only from message `content`).
    expect(typeof embed).not.toBe('string');
    expect('content' in embed.toJSON()).toBe(false);
  });
});
