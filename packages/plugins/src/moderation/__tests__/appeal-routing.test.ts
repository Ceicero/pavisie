import { describe, expect, it, vi } from 'vitest';
import type { EmbedBuilder, ModalSubmitInteraction } from 'discord.js';
import type { ComponentContext, PluginContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { appealComponents } from '../components/appeal';
import { ModerationServiceImpl } from '../service';
import { CHANNEL_ID, GUILD_ID, createFakeGuild } from './fakes';
import en from '../locales/en.json';

const APPEALER_ID = '444444444444444444';

const appealModalHandler = appealComponents.find((h) => h.action === 'appeal-modal')!;

function realT(key: string): string {
  const parts = key.split('.');
  let node: unknown = en;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  return typeof node === 'string' ? node : key;
}

/** `appealsChannelId: null` (the default) vs. an appeals channel the bot can actually post in. */
function buildContext(appealsChannelId: string | null) {
  const { guild, channel } = createFakeGuild();
  const replies: { embeds?: EmbedBuilder[] }[] = [];

  const client = {
    guilds: { fetch: async () => guild, cache: new Map([[GUILD_ID, guild]]) },
    users: { fetch: async () => null },
  } as unknown as PluginContext['client'];

  const { ctx, services } = createTestContext({
    config: { appealsChannelId },
    overrides: { client },
    prismaOverrides: {
      moderationAppeal: {
        create: async (...args: unknown[]) => {
          const { data } = args[0] as { data: Record<string, unknown> };
          return { id: 'appeal-1', ...data };
        },
        update: async () => undefined,
      },
    },
  });
  services.register('moderation', new ModerationServiceImpl(ctx) as never);

  const interaction = {
    isModalSubmit: () => true,
    user: { id: APPEALER_ID },
    fields: { getTextInputValue: () => 'Please reconsider, it was a misunderstanding.' },
    reply: vi.fn(async (payload: { embeds?: EmbedBuilder[] }) => {
      replies.push(payload);
    }),
  };

  const c: ComponentContext<ModalSubmitInteraction<'cached'>> = {
    interaction: interaction as unknown as ModalSubmitInteraction<'cached'>,
    ctx,
    guildId: GUILD_ID,
    staffLevel: 'member',
    locale: 'en-US' as never,
    t: realT,
    config: async <T>() => ({ appealsChannelId }) as T,
    args: [APPEALER_ID, '7'],
  };

  return { c, replies, channel };
}

function replyText(replies: { embeds?: EmbedBuilder[] }[]): string {
  const embed = replies[0]?.embeds?.[0]?.data;
  return `${embed?.title ?? ''} ${embed?.description ?? ''}`;
}

describe('/appeal submission feedback', () => {
  it('tells the user staff were not notified when no appeals channel is configured', async () => {
    const { c, replies, channel } = buildContext(null);

    await appealModalHandler.handler(c as never);

    expect(channel.sent).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replyText(replies)).not.toContain('Staff will review it soon');
    expect(replyText(replies)).toContain("staff weren't notified");
  });

  it('confirms normally once the appeal actually reaches a staff channel', async () => {
    const { c, replies, channel } = buildContext(CHANNEL_ID);

    await appealModalHandler.handler(c as never);

    expect(channel.sent).toHaveLength(1);
    expect(replyText(replies)).toContain('Staff will review it soon');
  });
});
