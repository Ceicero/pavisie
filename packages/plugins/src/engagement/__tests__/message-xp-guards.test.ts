import { describe, expect, it } from 'vitest';
import type { Message, OmitPartialGroupDMChannel } from 'discord.js';
import { createTestContext } from '../../sdk/testing';
import { messageCreateHandler } from '../events/message-create';
import { configSchema } from '../manifest';

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

interface MessageSpec {
  bot?: boolean;
  system?: boolean;
  webhookId?: string | null;
  guildId?: string;
  channelId?: string;
  userId?: string;
  /** Set when the message is a thread or forum post; this is the parent channel id. */
  parentChannelId?: string | null;
  roleIds?: string[];
}

function buildMessage(spec: MessageSpec = {}): OmitPartialGroupDMChannel<Message> {
  const guildId = spec.guildId ?? GUILD_ID;
  const channelId = spec.channelId ?? 'channel-1';
  const userId = spec.userId ?? USER_ID;
  const channel =
    spec.parentChannelId !== undefined
      ? { id: channelId, isThread: () => true, parentId: spec.parentChannelId }
      : undefined;

  return {
    guild: { id: guildId },
    guildId,
    channelId,
    channel,
    author: { id: userId, bot: spec.bot ?? false },
    member: spec.roleIds ? { roles: { cache: new Map(spec.roleIds.map((id) => [id, { id }])) } } : null,
    system: spec.system ?? false,
    webhookId: spec.webhookId ?? null,
  } as unknown as OmitPartialGroupDMChannel<Message>;
}

// ioredis-mock shares its in-memory keyspace across instances, so without a flush the first test's XP
// cooldown would suppress every later one and the guards would look like they worked.
async function buildContext() {
  const cfg = configSchema.parse({});
  const test = createTestContext({
    config: cfg,
    prismaOverrides: {
      levelProfile: {
        upsert: async () => ({ id: 'p1', guildId: GUILD_ID, userId: USER_ID, xp: 20, level: 0 }),
      },
    },
  });
  await test.redis.flushall();
  return test;
}

describe('engagement messageCreate XP guard', () => {
  it('awards XP for an ordinary member message (control)', async () => {
    const { ctx, prismaCalls } = await buildContext();
    await messageCreateHandler.handler(ctx, buildMessage());

    expect(prismaCalls.map((call) => `${call.model}.${call.method}`)).toContain('levelProfile.upsert');
  });

  // Join/boost/pin notices carry the real member as `author` with `bot: false`, so a member could farm XP
  // by rejoining without ever typing.
  it('ignores system messages (join/boost/pin notices)', async () => {
    const { ctx, prismaCalls } = await buildContext();
    await messageCreateHandler.handler(ctx, buildMessage({ system: true }));

    expect(prismaCalls).toHaveLength(0);
  });

  it('ignores webhook posts', async () => {
    const { ctx, prismaCalls } = await buildContext();
    await messageCreateHandler.handler(ctx, buildMessage({ webhookId: '444444444444444444' }));

    expect(prismaCalls).toHaveLength(0);
  });

  it('ignores bot messages', async () => {
    const { ctx, prismaCalls } = await buildContext();
    await messageCreateHandler.handler(ctx, buildMessage({ bot: true }));

    expect(prismaCalls).toHaveLength(0);
  });

  // A thread or forum post has its own channel id. Ignoring the parent must still block XP there.
  // Each new case uses its own guild id: ioredis-mock shares one keyspace, and awarding XP writes
  // cooldown keys. These cases do not flush, so they cannot wipe another file's keys.
  it('does not award XP for a thread or forum post under an ignored parent channel', async () => {
    const guildId = 'g-msg-thread-ignored-parent-20261113';
    const parentId = 'parent-ignored-20261113';
    const cfg = configSchema.parse({ leveling: { ignoredChannelIds: [parentId] } });
    const { ctx, prismaCalls } = createTestContext({
      config: cfg,
      prismaOverrides: {
        levelProfile: {
          upsert: async () => ({
            id: 'p-thread-ignored',
            guildId,
            userId: 'user-thread-ignored-20261113',
            xp: 20,
            level: 0,
          }),
        },
      },
    });

    await messageCreateHandler.handler(
      ctx,
      buildMessage({
        guildId,
        channelId: 'thread-under-ignored-20261113',
        userId: 'user-thread-ignored-20261113',
        parentChannelId: parentId,
      }),
    );

    expect(prismaCalls).toHaveLength(0);
  });

  it('awards XP for a thread or forum post whose parent channel is not ignored', async () => {
    const guildId = 'g-msg-thread-open-parent-20261113';
    const cfg = configSchema.parse({ leveling: { ignoredChannelIds: ['other-channel-20261113'] } });
    const { ctx, prismaCalls } = createTestContext({
      config: cfg,
      prismaOverrides: {
        levelProfile: {
          upsert: async () => ({
            id: 'p-thread-open',
            guildId,
            userId: 'user-thread-open-20261113',
            xp: 20,
            level: 0,
          }),
        },
      },
    });

    await messageCreateHandler.handler(
      ctx,
      buildMessage({
        guildId,
        channelId: 'thread-under-open-20261113',
        userId: 'user-thread-open-20261113',
        parentChannelId: 'parent-open-20261113',
      }),
    );

    expect(prismaCalls.map((call) => `${call.model}.${call.method}`)).toContain('levelProfile.upsert');
  });
});
