import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction, type EmbedBuilder } from 'discord.js';
import { shortId } from '@pavisie/core';
import type { PluginId } from '@pavisie/types';
import { buildCustomId, parseCustomId } from './custom-id';
import { errorEmbed, infoEmbed } from './embeds';
import type { ConfirmationInteraction } from './confirm';

const SESSION_TTL_MS = 2 * 60 * 1000;

/**
 * Reserved component action for the shared pagination row. Unlike every other component action, this one is
 * answered by the host router itself (`apps/bot/src/host/router.ts` → `handlePaginationInteraction`) rather
 * than by a handler in some plugin's `components` array: the rendered pages live in this module's session
 * map, not in any plugin, so there is nothing per-plugin to register. Plugins must not use this action name.
 */
export const PAGINATION_ACTION = 'page';

export interface PaginatedReplyOptions {
  interaction: ConfirmationInteraction;
  pages: EmbedBuilder[];
  ownerId: string;
  pluginId: PluginId;
  /** Defaults to true (config views, moderation detail, etc. reply ephemerally per ARCHITECTURE.md §7.7). */
  ephemeral?: boolean;
}

interface PaginationSession {
  id: string;
  pages: EmbedBuilder[];
  ownerId: string;
  pluginId: PluginId;
  timer: NodeJS.Timeout;
}

/**
 * Live paginated views, keyed by the short session id carried in each button's custom id. In-process only —
 * a view does not survive a restart, exactly as the message-component collector it replaces did not.
 */
const sessions = new Map<string, PaginationSession>();

function buildPageRow(
  pluginId: PluginId,
  ownerId: string,
  sessionId: string,
  index: number,
  total: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId(pluginId, PAGINATION_ACTION, ownerId, String(index - 1), sessionId))
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index <= 0),
    new ButtonBuilder()
      .setCustomId(buildCustomId(pluginId, PAGINATION_ACTION, ownerId, String(index + 1), sessionId))
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index >= total - 1),
  );
}

/**
 * Replies with `pages[0]` plus Previous/Next buttons (custom id
 * `<pluginId>:page:<ownerId>:<index>:<sessionId>`) and registers the pages so the host router can flip them
 * for the owning user only. Buttons are removed when the session expires after two minutes.
 */
export async function paginatedReply(options: PaginatedReplyOptions): Promise<void> {
  const { interaction, pages, ownerId, pluginId, ephemeral = true } = options;

  if (pages.length === 0) {
    await interaction.reply({
      embeds: [infoEmbed('Nothing to show', 'There is nothing to display yet.')],
      ephemeral,
    });
    return;
  }

  if (pages.length === 1) {
    await interaction.reply({ embeds: [pages[0]], components: [], ephemeral });
    return;
  }

  const sessionId = shortId(8);
  const timer = setTimeout(() => {
    sessions.delete(sessionId);
    void interaction.editReply({ components: [] }).catch(() => {
      // The message may already be gone (e.g. deleted, or an expired ephemeral interaction token) — nothing to clean up.
    });
  }, SESSION_TTL_MS);
  timer.unref();

  // Registered before the reply is awaited: the button cannot be clicked until Discord has the message, but
  // the session must never be missing for a click that Discord already accepted.
  sessions.set(sessionId, { id: sessionId, pages, ownerId, pluginId, timer });

  try {
    await interaction.reply({
      embeds: [pages[0]],
      components: [buildPageRow(pluginId, ownerId, sessionId, 0, pages.length)],
      ephemeral,
    });
  } catch (err) {
    clearTimeout(timer);
    sessions.delete(sessionId);
    throw err;
  }
}

/**
 * Answers a click on a shared pagination button. Called by the host router for every `PAGINATION_ACTION`
 * component, ahead of the per-plugin component lookup and the requirement pipeline: flipping a page is a pure
 * in-memory re-render, so it must not wait on Redis/Postgres to stay inside Discord's 3s acknowledgement
 * window. Owner-only is enforced here against the session's recorded owner rather than by the router's
 * generic `args[0]` check.
 */
export async function handlePaginationInteraction(interaction: ButtonInteraction): Promise<void> {
  const { args } = parseCustomId(interaction.customId);
  const [, indexArg, sessionId] = args;
  const session = sessions.get(sessionId ?? '');

  if (!session) {
    await interaction.reply({
      embeds: [errorEmbed('This list has expired. Run the command again to see it.')],
      ephemeral: true,
    });
    return;
  }

  if (interaction.user.id !== session.ownerId) {
    await interaction.reply({
      content: 'Only the person who ran this command can page through it.',
      ephemeral: true,
    });
    return;
  }

  const nextIndex = Number(indexArg);
  if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= session.pages.length) {
    await interaction.deferUpdate();
    return;
  }

  await interaction.update({
    embeds: [session.pages[nextIndex]],
    components: [
      buildPageRow(session.pluginId, session.ownerId, session.id, nextIndex, session.pages.length),
    ],
  });
}
