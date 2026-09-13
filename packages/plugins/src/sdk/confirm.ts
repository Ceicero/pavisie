import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ContextMenuCommandInteraction,
  type EmbedBuilder,
  type Message,
} from 'discord.js';
import { PermissionError } from '@pavisie/core';
import type { PluginId } from '@pavisie/types';
import { buildCustomId } from './custom-id';
import { PendingStore } from './pending';
import type { ComponentContext, ComponentHandler, PluginContext } from './types';

const DEFAULT_TTL_SECONDS = 60;

export type ConfirmationInteraction =
  ChatInputCommandInteraction<'cached'> | ContextMenuCommandInteraction<'cached'>;

export interface RequestConfirmationOptions<T> {
  interaction: ConfirmationInteraction;
  ctx: PluginContext;
  pluginId: PluginId;
  /** The action name; buttons get custom ids `<plugin>:confirm-<action>:...` / `<plugin>:cancel-<action>:...`. */
  action: string;
  ownerId: string;
  embed: EmbedBuilder;
  payload: T;
  ttlSec?: number;
  /** When true (guild's `fastActions` config), skips the confirmation UI and resolves immediately as confirmed. */
  fastActions?: boolean;
}

export interface ConfirmationResult<T> {
  /** True only when `fastActions` short-circuited the flow. When false, a confirmation prompt was sent and the
   * real decision will arrive later via the handlers `registerConfirmHandlers` returns. */
  confirmed: boolean;
  payload: T;
}

/**
 * Sends (or skips, under `fastActions`) a destructive-action confirmation prompt (ARCHITECTURE.md §7.7).
 * Non-fast-actions path replies ephemerally with `embed` plus Confirm/Cancel buttons and stores `payload` in
 * Redis (via `PendingStore`) keyed by a short id embedded in both custom ids.
 */
export async function requestConfirmation<T>(
  options: RequestConfirmationOptions<T>,
): Promise<ConfirmationResult<T>> {
  const {
    interaction,
    ctx,
    pluginId,
    action,
    ownerId,
    embed,
    payload,
    ttlSec = DEFAULT_TTL_SECONDS,
    fastActions,
  } = options;

  if (fastActions) {
    return { confirmed: true, payload };
  }

  const pendingStore = new PendingStore(ctx.redis);
  const pendingId = await pendingStore.put(payload, ttlSec);

  const confirmId = buildCustomId(pluginId, `confirm-${action}`, ownerId, pendingId);
  const cancelId = buildCustomId(pluginId, `cancel-${action}`, ownerId, pendingId);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });

  return { confirmed: false, payload };
}

// discord.js's read-only `Message.components` (ActionRow<MessageActionRowComponent>[]) has no simple public type
// alias for `ActionRowBuilder.from()`'s accepted input; `any` narrows immediately to `ButtonBuilder` below.
function disableAllButtons(components: Message['components']): ActionRowBuilder<ButtonBuilder>[] {
  return components.map((row) => {
    const builder = ActionRowBuilder.from<ButtonBuilder>(row as any); // eslint-disable-line @typescript-eslint/no-explicit-any -- see above
    for (const component of builder.components) {
      if (component instanceof ButtonBuilder) {
        component.setDisabled(true);
      }
    }
    return builder;
  });
}

function assertOwner(interaction: ButtonInteraction<'cached'>, ownerId: string | undefined): void {
  if (ownerId && interaction.user.id !== ownerId) {
    throw new PermissionError('Only the user who started this action can respond to it.');
  }
}

/**
 * Builds the `confirm-<action>` / `cancel-<action>` `ComponentHandler`s for a `requestConfirmation` flow: loads
 * the pending payload, verifies the clicking user owns the prompt, disables the buttons, edits the original
 * message to a terminal "Confirmed"/"Cancelled" state, and (for confirm) invokes `onConfirm` with the payload.
 */
export function registerConfirmHandlers<T = unknown>(
  action: string,
  onConfirm: (c: ComponentContext<ButtonInteraction<'cached'>>, payload: T) => Promise<void>,
  onCancel?: (c: ComponentContext<ButtonInteraction<'cached'>>, payload: T | null) => Promise<void>,
): ComponentHandler[] {
  const confirmHandler: ComponentHandler = {
    action: `confirm-${action}`,
    kind: 'button',
    ownerOnly: true,
    async handler(c) {
      const interaction = c.interaction as ButtonInteraction<'cached'>;
      const [ownerId, pendingId] = c.args;
      assertOwner(interaction, ownerId);

      const pendingStore = new PendingStore(c.ctx.redis);
      const payload = pendingId ? await pendingStore.take<T>(pendingId) : null;
      const disabledRows = disableAllButtons(interaction.message.components);

      if (payload === null) {
        await interaction.update({
          content: 'This confirmation has expired. Please run the command again.',
          embeds: [],
          components: disabledRows,
        });
        return;
      }

      await interaction.update({ content: 'Confirmed.', components: disabledRows });
      await onConfirm(c as ComponentContext<ButtonInteraction<'cached'>>, payload);
    },
  };

  const cancelHandler: ComponentHandler = {
    action: `cancel-${action}`,
    kind: 'button',
    ownerOnly: true,
    async handler(c) {
      const interaction = c.interaction as ButtonInteraction<'cached'>;
      const [ownerId, pendingId] = c.args;
      assertOwner(interaction, ownerId);

      const pendingStore = new PendingStore(c.ctx.redis);
      const payload = pendingId ? await pendingStore.take<T>(pendingId) : null;
      const disabledRows = disableAllButtons(interaction.message.components);

      await interaction.update({ content: 'Cancelled.', embeds: [], components: disabledRows });
      if (onCancel) {
        await onCancel(c as ComponentContext<ButtonInteraction<'cached'>>, payload);
      }
    },
  };

  return [confirmHandler, cancelHandler];
}
