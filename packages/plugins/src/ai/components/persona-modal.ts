import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { ValidationError } from '@pavisie/core';
import { buildCustomId, successEmbed, type ComponentHandler } from '../../sdk';
import type { AiConfig } from '../manifest';

const MODAL_ACTION = 'config-chat-persona-modal';
const PERSONA_FIELD = 'persona';
const PERSONA_MAX_LENGTH = 1500;

/** Opens the "set mention-chat persona" modal from `/ai config chat persona set` — a paragraph field since personas run long. */
export async function openPersonaModal(
  interaction: ChatInputCommandInteraction<'cached'>,
  ownerId: string,
  currentPersona: string | null,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(buildCustomId('ai', MODAL_ACTION, ownerId))
    .setTitle('Set mention-chat persona');

  // Discord caps a text input's label at 45 chars — the "safety rules always apply, tone/name only" nuance
  // lives in the placeholder and in `/ai chat persona set`'s command description instead.
  const input = new TextInputBuilder()
    .setCustomId(PERSONA_FIELD)
    .setLabel('Persona (tone/name only)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(PERSONA_MAX_LENGTH)
    .setPlaceholder('A laid-back, witty coach for our speedrunning community.');

  if (currentPersona) {
    input.setValue(currentPersona.slice(0, PERSONA_MAX_LENGTH));
  }

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

export const personaModalHandler: ComponentHandler = {
  action: MODAL_ACTION,
  kind: 'modal',
  ownerOnly: true,
  requirement: { staffLevel: 'admin' },
  async handler(c) {
    const interaction = c.interaction as ModalSubmitInteraction<'cached'>;
    const persona = interaction.fields.getTextInputValue(PERSONA_FIELD).trim();
    if (persona.length === 0) {
      throw new ValidationError(c.t('errors.emptyPersona'));
    }

    // `setConfig` shallow-merges at the top level, so `chat` (a nested object) has to be spread over its
    // current value here — patching `{ chat: { persona } }` directly would silently reset `chat.enabled`,
    // `chat.channelIds`, etc. back to their schema defaults (see `config-store.ts`'s `setConfig` doc comment).
    const config = await c.config<AiConfig>();
    await c.ctx.setConfig<AiConfig>(
      c.guildId,
      { chat: { ...config.chat, persona } },
      { id: c.interaction.user.id, source: 'bot' },
    );

    await interaction.reply({ embeds: [successEmbed(c.t('config.chat.personaSet'))], ephemeral: true });
  },
};
