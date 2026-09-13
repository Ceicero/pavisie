import { EmbedBuilder, type ActionRowBuilder, type ButtonBuilder, type ButtonInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginId } from '@pavisie/types';
import { parseCustomId } from '../custom-id';
import { PAGINATION_ACTION, handlePaginationInteraction, paginatedReply } from '../pagination';
import type { ConfirmationInteraction } from '../confirm';

const OWNER_ID = 'owner-user-1';
const PLUGIN_ID: PluginId = 'admin';

function makePages(count: number): EmbedBuilder[] {
  return Array.from({ length: count }, (_, i) => new EmbedBuilder().setTitle(`Page ${i + 1}`));
}

interface ReplyPayload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  ephemeral?: boolean;
}

function fakeCommandInteraction() {
  const reply = vi.fn(async (_payload: unknown) => undefined);
  const editReply = vi.fn(async () => undefined);
  return {
    interaction: { reply, editReply } as unknown as ConfirmationInteraction,
    reply,
    editReply,
    payload: () => reply.mock.calls[0][0] as unknown as ReplyPayload,
  };
}

function fakeButtonInteraction(customId: string, userId = OWNER_ID) {
  const update = vi.fn(async (_payload: unknown) => undefined);
  const reply = vi.fn(async (_payload: unknown) => undefined);
  const deferUpdate = vi.fn(async () => undefined);
  return {
    interaction: { customId, user: { id: userId }, update, reply, deferUpdate } as unknown as ButtonInteraction,
    update,
    reply,
    deferUpdate,
    updatePayload: () => update.mock.calls[0][0] as unknown as ReplyPayload,
  };
}

/** Reads the `[previousId, nextId]` custom ids and `[previousDisabled, nextDisabled]` flags off a page row. */
function readRow(row: ActionRowBuilder<ButtonBuilder>) {
  const json = row.toJSON().components as { custom_id?: string; disabled?: boolean }[];
  return {
    ids: [json[0].custom_id ?? '', json[1].custom_id ?? ''],
    disabled: [json[0].disabled === true, json[1].disabled === true],
  };
}

/** Runs `paginatedReply` and hands back the buttons it actually rendered. */
async function openView(pages: EmbedBuilder[]) {
  const command = fakeCommandInteraction();
  await paginatedReply({
    interaction: command.interaction,
    pages,
    ownerId: OWNER_ID,
    pluginId: PLUGIN_ID,
  });
  const payload = command.payload();
  return { command, payload, row: readRow(payload.components[0]) };
}

describe('paginatedReply — button custom ids', () => {
  it('builds both buttons under the reserved pagination action so the host router can find them', async () => {
    const { row } = await openView(makePages(3));

    for (const id of row.ids) {
      const parsed = parseCustomId(id);
      expect(parsed.pluginId).toBe(PLUGIN_ID);
      // The whole defect was that this action had no responder anywhere; assert the exact contract the
      // router keys off, not just "some action".
      expect(parsed.action).toBe(PAGINATION_ACTION);
      expect(parsed.args[0]).toBe(OWNER_ID);
      expect(parsed.args).toHaveLength(3); // ownerId, target index, session id
      expect(parsed.args[2]).not.toBe('');
    }
  });

  it('gives every page button a custom id that the pagination handler answers with an update', async () => {
    const pages = makePages(3);
    const { row } = await openView(pages);
    const button = fakeButtonInteraction(row.ids[1]);

    await handlePaginationInteraction(button.interaction);

    expect(button.reply).not.toHaveBeenCalled();
    expect(button.update).toHaveBeenCalledTimes(1);
  });

  it('replies without buttons for a single page', async () => {
    const command = fakeCommandInteraction();
    await paginatedReply({
      interaction: command.interaction,
      pages: makePages(1),
      ownerId: OWNER_ID,
      pluginId: PLUGIN_ID,
    });

    expect(command.payload().components).toEqual([]);
  });
});

describe('handlePaginationInteraction — paging', () => {
  let pages: EmbedBuilder[];

  beforeEach(() => {
    pages = makePages(3);
  });

  it('advances from the first page and enables Previous', async () => {
    const { payload, row } = await openView(pages);
    expect(payload.embeds[0]).toBe(pages[0]);
    expect(row.disabled).toEqual([true, false]); // Previous disabled on the first page

    const button = fakeButtonInteraction(row.ids[1]);
    await handlePaginationInteraction(button.interaction);

    const updated = button.updatePayload();
    expect(updated.embeds[0]).toBe(pages[1]);
    expect(readRow(updated.components[0]).disabled).toEqual([false, false]);
  });

  it('advances from a middle page to the last page and disables Next', async () => {
    const { row } = await openView(pages);
    const toMiddle = fakeButtonInteraction(row.ids[1]);
    await handlePaginationInteraction(toMiddle.interaction);

    const middleRow = readRow(toMiddle.updatePayload().components[0]);
    const toLast = fakeButtonInteraction(middleRow.ids[1]);
    await handlePaginationInteraction(toLast.interaction);

    const updated = toLast.updatePayload();
    expect(updated.embeds[0]).toBe(pages[2]);
    expect(readRow(updated.components[0]).disabled).toEqual([false, true]); // Next disabled on the last page
  });

  it('goes back from the last page to the middle page', async () => {
    const { row } = await openView(pages);
    const toMiddle = fakeButtonInteraction(row.ids[1]);
    await handlePaginationInteraction(toMiddle.interaction);
    const toLast = fakeButtonInteraction(readRow(toMiddle.updatePayload().components[0]).ids[1]);
    await handlePaginationInteraction(toLast.interaction);

    const lastRow = readRow(toLast.updatePayload().components[0]);
    const back = fakeButtonInteraction(lastRow.ids[0]);
    await handlePaginationInteraction(back.interaction);

    const updated = back.updatePayload();
    expect(updated.embeds[0]).toBe(pages[1]);
    expect(readRow(updated.components[0]).disabled).toEqual([false, false]);
  });

  it('acknowledges without changing anything when the target index is out of range', async () => {
    const { row } = await openView(pages);
    // The Previous button on page 1 targets -1; it is rendered disabled, but Discord will still deliver a
    // click if the client is stale.
    const button = fakeButtonInteraction(row.ids[0]);

    await handlePaginationInteraction(button.interaction);

    expect(button.deferUpdate).toHaveBeenCalledTimes(1);
    expect(button.update).not.toHaveBeenCalled();
  });

  it('refuses a user who did not run the command', async () => {
    const { row } = await openView(pages);
    const button = fakeButtonInteraction(row.ids[1], 'someone-else');

    await handlePaginationInteraction(button.interaction);

    expect(button.update).not.toHaveBeenCalled();
    expect(button.reply).toHaveBeenCalledTimes(1);
    expect(button.reply.mock.calls[0][0]).toMatchObject({ ephemeral: true });
  });

  it('tells the user the view expired when the session is gone (e.g. after a restart)', async () => {
    const button = fakeButtonInteraction(`${PLUGIN_ID}:${PAGINATION_ACTION}:${OWNER_ID}:1:deadbeef`);

    await handlePaginationInteraction(button.interaction);

    expect(button.update).not.toHaveBeenCalled();
    expect(button.reply).toHaveBeenCalledTimes(1);
  });

  it('strips the buttons and drops the session when the view expires', async () => {
    vi.useFakeTimers();
    try {
      const { command, row } = await openView(pages);
      expect(command.editReply).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(command.editReply).toHaveBeenCalledWith({ components: [] });

      // The session is gone too, so a late click is answered as expired rather than silently paging.
      const button = fakeButtonInteraction(row.ids[1]);
      await handlePaginationInteraction(button.interaction);
      expect(button.update).not.toHaveBeenCalled();
      expect(button.reply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps two concurrent views independent', async () => {
    const otherPages = [new EmbedBuilder().setTitle('Other 1'), new EmbedBuilder().setTitle('Other 2')];
    const first = await openView(pages);
    const second = await openView(otherPages);

    const button = fakeButtonInteraction(second.row.ids[1]);
    await handlePaginationInteraction(button.interaction);

    expect(button.updatePayload().embeds[0]).toBe(otherPages[1]);
    expect(first.row.ids[1]).not.toBe(second.row.ids[1]);
  });
});
