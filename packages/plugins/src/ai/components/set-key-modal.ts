import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { encryptSecret, ValidationError } from '@pavisie/core';
import { buildCustomId, successEmbed, type ComponentHandler } from '../../sdk';
import type { AiConfig } from '../manifest';

const MODAL_ACTION = 'config-set-key-modal';
const API_KEY_FIELD = 'api-key';

/** Opens the "set API key" modal from `/ai config set-key`. The key is never echoed back or logged — only encrypted and stored. */
export async function openSetKeyModal(
  interaction: ChatInputCommandInteraction<'cached'>,
  ownerId: string,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(buildCustomId('ai', MODAL_ACTION, ownerId))
    .setTitle('Set AI provider API key');

  const input = new TextInputBuilder()
    .setCustomId(API_KEY_FIELD)
    .setLabel('API key')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(8)
    .setMaxLength(400)
    .setPlaceholder('sk-...');

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

export const setKeyModalHandler: ComponentHandler = {
  action: MODAL_ACTION,
  kind: 'modal',
  ownerOnly: true,
  requirement: { staffLevel: 'admin' },
  async handler(c) {
    const interaction = c.interaction as ModalSubmitInteraction<'cached'>;
    const apiKey = interaction.fields.getTextInputValue(API_KEY_FIELD).trim();
    if (apiKey.length === 0) {
      throw new ValidationError(c.t('errors.emptyKey'));
    }

    const apiKeyEnc = encryptSecret(apiKey);
    await c.ctx.setConfig<AiConfig>(c.guildId, { apiKeyEnc }, { id: c.interaction.user.id, source: 'bot' });

    await interaction.reply({ embeds: [successEmbed(c.t('config.keySet'))], ephemeral: true });
  },
};
