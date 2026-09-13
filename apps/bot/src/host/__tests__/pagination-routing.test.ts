import { EmbedBuilder, type ActionRowBuilder, type ButtonBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { Cooldowns, MemoryRateLimiter, createPlatformEvents } from '@pavisie/core';
import {
  DEFAULT_GUILD_CONFIG,
  ServiceRegistry,
  paginatedReply,
  type ConfirmationInteraction,
  type GuildConfigData,
  type PluginRegistry,
} from '@pavisie/plugins';
import type { PluginId } from '@pavisie/types';
import { routeInteraction } from '../router';
import type { LoadedHost } from '../loader';

const GUILD_ID = 'guild-1';
const OWNER_ID = 'owner-user-1';
const PLUGIN_ID: PluginId = 'admin';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as import('pino').Logger;

interface ReplyPayload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

/** `[previousId, nextId]` for a rendered page row. */
function rowIds(row: ActionRowBuilder<ButtonBuilder>): [string, string] {
  const json = row.toJSON().components as { custom_id?: string }[];
  return [json[0].custom_id ?? '', json[1].custom_id ?? ''];
}

/**
 * A host with **no** registered components at all — the point of the fix is that the shared pagination row
 * works without every calling plugin re-declaring a `page` handler.
 */
function fakeHost() {
  const getGuildConfig = vi.fn(
    async (): Promise<GuildConfigData> => ({ guildId: GUILD_ID, ...DEFAULT_GUILD_CONFIG }),
  );
  const host = {
    registry: {} as unknown as PluginRegistry,
    configStore: { getGuildConfig, isEnabled: async () => true } as unknown as LoadedHost['configStore'],
    services: new ServiceRegistry(),
    events: createPlatformEvents(),
    contexts: new Map(),
    commands: new Map(),
    components: new Map(),
    availability: new Map(),
    botOwnerIds: [],
    cooldowns: new Cooldowns('memory'),
    globalRateLimiter: new MemoryRateLimiter(),
    queueCache: new Map(),
  } as unknown as LoadedHost;
  return { host, getGuildConfig };
}

function fakeButtonInteraction(customId: string, userId = OWNER_ID) {
  const update = vi.fn(async (_payload: unknown) => undefined);
  const reply = vi.fn(async (_payload: unknown) => undefined);
  const deferUpdate = vi.fn(async () => undefined);
  return {
    customId,
    isButton: () => true,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    isContextMenuCommand: () => false,
    isAutocomplete: () => false,
    inCachedGuild: () => true,
    locale: 'en-US',
    user: { id: userId },
    guildId: GUILD_ID,
    guild: { ownerId: 'guild-owner' },
    member: {
      id: userId,
      roles: { cache: new Map(), highest: { position: 1 } },
      permissions: { bitfield: 0n },
      user: { bot: false },
    },
    channel: null,
    deferred: false,
    replied: false,
    update,
    reply,
    deferUpdate,
    followUp: vi.fn(async () => undefined),
    updatePayload: () => update.mock.calls[0][0] as unknown as ReplyPayload,
  };
}

/** Opens a real paginated view and returns the pages plus the custom ids of the buttons it rendered. */
async function openView(pageCount: number) {
  const pages = Array.from({ length: pageCount }, (_, i) => new EmbedBuilder().setTitle(`Page ${i + 1}`));
  const reply = vi.fn(async (_payload: unknown) => undefined);
  await paginatedReply({
    interaction: { reply, editReply: vi.fn(async () => undefined) } as unknown as ConfirmationInteraction,
    pages,
    ownerId: OWNER_ID,
    pluginId: PLUGIN_ID,
  });
  const payload = reply.mock.calls[0][0] as unknown as ReplyPayload;
  return { pages, ids: rowIds(payload.components[0]) };
}

describe('routeInteraction — shared pagination row', () => {
  it('routes a page button even though no plugin registers a `page` component handler', async () => {
    const { pages, ids } = await openView(3);
    const { host, getGuildConfig } = fakeHost();
    const interaction = fakeButtonInteraction(ids[1]); // Next ▶

    await routeInteraction(interaction as never, host, logger);

    // Before the fix the router fell through to its unknown-component branch and answered
    // "Interaction was not found", so the page never advanced.
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledTimes(1);
    expect(interaction.updatePayload().embeds[0]).toBe(pages[1]);
    // Answered ahead of the requirement pipeline, so the ack owes nothing to Redis/Postgres.
    expect(getGuildConfig).not.toHaveBeenCalled();
  });

  it('walks next/next/previous across the first, middle and last page', async () => {
    const { pages, ids } = await openView(3);
    const { host } = fakeHost();

    const toMiddle = fakeButtonInteraction(ids[1]);
    await routeInteraction(toMiddle as never, host, logger);
    expect(toMiddle.updatePayload().embeds[0]).toBe(pages[1]);

    const toLast = fakeButtonInteraction(rowIds(toMiddle.updatePayload().components[0])[1]);
    await routeInteraction(toLast as never, host, logger);
    expect(toLast.updatePayload().embeds[0]).toBe(pages[2]);

    const back = fakeButtonInteraction(rowIds(toLast.updatePayload().components[0])[0]);
    await routeInteraction(back as never, host, logger);
    expect(back.updatePayload().embeds[0]).toBe(pages[1]);
  });

  it('refuses a page click from anyone but the user who ran the command', async () => {
    const { ids } = await openView(3);
    const { host } = fakeHost();
    const interaction = fakeButtonInteraction(ids[1], 'someone-else');

    await routeInteraction(interaction as never, host, logger);

    expect(interaction.update).not.toHaveBeenCalled();
    // Asserting the count alone would pass on the unfixed router too, which answered every page click —
    // owner or not — with its generic "Interaction was not found" embed. Assert the pagination handler's own
    // refusal so this test can only pass when the click actually reached it.
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply.mock.calls[0][0]).toMatchObject({
      content: 'Only the person who ran this command can page through it.',
      ephemeral: true,
    });
  });
});
