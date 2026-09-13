// Builds the Discord message payload (embed + components, or embed + reaction list) for a posted role panel.
// discord.js-dependent, but takes plain data in and returns builders/plain values out — no live API calls — so
// it's still directly unit-testable (customId shapes/lengths, option counts, chunking).
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import type { RolePanel, RolePanelOption } from '@pavisie/database';
import type { PluginId } from '@pavisie/types';
import { brandEmbed, buildCustomId, chunk } from '../sdk';

const ROLES_PLUGIN_ID: PluginId = 'roles';
const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;

export type PanelWithOptions = RolePanel & { options: RolePanelOption[] };

/** Renders the panel's embed: title, description, and (for buttons/select styles) a bullet list of what each option grants. */
export function buildPanelEmbed(panel: PanelWithOptions) {
  const embed = brandEmbed().setTitle(panel.title);
  const lines = panel.options.map((opt) => {
    const emojiPrefix = opt.emoji ? `${opt.emoji} ` : '';
    const desc = opt.description ? ` — ${opt.description}` : '';
    return `${emojiPrefix}**${opt.label}** → <@&${opt.roleId}>${desc}`;
  });
  const body = [panel.description, lines.length > 0 ? lines.join('\n') : null].filter(Boolean).join('\n\n');
  if (body) embed.setDescription(body.slice(0, 4096));
  return embed;
}

/** Builds one action row per up-to-5-button chunk (buttons style), customId `roles:toggle:<panelId>:<optionId>`. */
export function buildPanelButtonRows(panel: PanelWithOptions): ActionRowBuilder<ButtonBuilder>[] {
  const rows = chunk(panel.options, MAX_BUTTONS_PER_ROW).slice(0, MAX_ROWS);
  return rows.map((rowOptions) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      rowOptions.map((opt) => {
        const button = new ButtonBuilder()
          .setCustomId(buildCustomId(ROLES_PLUGIN_ID, 'toggle', panel.id, opt.id))
          .setLabel(opt.label.slice(0, 80))
          .setStyle(ButtonStyle.Secondary);
        if (opt.emoji) button.setEmoji(opt.emoji);
        return button;
      }),
    ),
  );
}

/** Builds the single string-select row (select style), customId `roles:select:<panelId>`. */
export function buildPanelSelectRow(panel: PanelWithOptions): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = panel.options.slice(0, 25);
  const maxValues =
    panel.maxSelections && panel.maxSelections > 0
      ? Math.min(panel.maxSelections, options.length)
      : options.length;

  const select = new StringSelectMenuBuilder()
    .setCustomId(buildCustomId(ROLES_PLUGIN_ID, 'select', panel.id))
    .setPlaceholder('Choose your roles…')
    .setMinValues(0)
    .setMaxValues(Math.max(1, maxValues));

  for (const opt of options) {
    const built = {
      label: opt.label.slice(0, 100),
      value: opt.roleId,
      description: opt.description?.slice(0, 100),
    };
    select.addOptions(opt.emoji ? { ...built, emoji: opt.emoji } : built);
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

export interface PanelMessagePayload {
  embeds: ReturnType<typeof buildPanelEmbed>[];
  components: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[];
}

/** Builds the full message payload for `panel.style` — everything except REACTIONS, which has no components (reactions are added separately after send). */
export function buildPanelMessagePayload(panel: PanelWithOptions): PanelMessagePayload {
  const embed = buildPanelEmbed(panel);
  if (panel.style === 'BUTTONS') {
    return { embeds: [embed], components: buildPanelButtonRows(panel) };
  }
  if (panel.style === 'SELECT') {
    return { embeds: [embed], components: [buildPanelSelectRow(panel)] };
  }
  return { embeds: [embed], components: [] };
}

/**
 * The key format `RolePanelOption.emoji` is stored in: unicode emoji as-is, custom emoji as `<:name:id>` /
 * `<a:name:id>`. Shared so the reaction listener and the panel-post reconciler compare a live reaction against
 * a stored option the same way.
 */
export function panelEmojiKey(emoji: {
  id?: string | null;
  name?: string | null;
  animated?: boolean | null;
}): string {
  if (emoji.id) {
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
  }
  return emoji.name ?? '';
}

/** For REACTIONS-style panels: the ordered list of `{ emoji, roleId }` pairs to react with after posting, skipping options with no emoji set. */
export function reactionRoleMap(panel: PanelWithOptions): { emoji: string; roleId: string }[] {
  return panel.options
    .filter((opt): opt is RolePanelOption & { emoji: string } => Boolean(opt.emoji))
    .map((opt) => ({ emoji: opt.emoji, roleId: opt.roleId }));
}
