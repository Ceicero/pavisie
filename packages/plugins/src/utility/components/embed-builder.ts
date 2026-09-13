import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type EmbedBuilder,
  type ModalSubmitInteraction,
} from 'discord.js';
import { assertPublicHttpUrl, SsrfError } from '@pavisie/core';
import {
  assertBotPermissions,
  brandEmbed,
  buildCustomId,
  errorEmbed,
  PendingStore,
  type ComponentContext,
  type ComponentHandler,
} from '../../sdk';
import { buildEmbedModal } from '../commands/embed';
import {
  embedPayloadFromJson,
  EmbedPayloadError,
  isPayloadEmpty,
  parseColorHex,
  sanitizeEmbedPayload,
  type EmbedBuilderPayload,
} from '../embed-payload';

const PENDING_TTL_SECONDS = 600;

function buildPreviewEmbed(payload: EmbedBuilderPayload): EmbedBuilder {
  const embed = brandEmbed();
  if (payload.title) embed.setTitle(payload.title);
  if (payload.description) embed.setDescription(payload.description);
  if (payload.footer) embed.setFooter({ text: payload.footer });
  if (payload.imageUrl) embed.setImage(payload.imageUrl);
  const color = parseColorHex(payload.colorHex);
  if (color !== undefined) embed.setColor(color);
  return embed;
}

function buildPreviewComponents(ownerId: string, pendingId: string) {
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(buildCustomId('utility', 'embed-channel', ownerId, pendingId))
    .setPlaceholder('Send to channel…')
    .setChannelTypes(
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    );

  const editButton = new ButtonBuilder()
    .setCustomId(buildCustomId('utility', 'embed-edit', ownerId, pendingId))
    .setLabel('Edit')
    .setStyle(ButtonStyle.Secondary);
  const importButton = new ButtonBuilder()
    .setCustomId(buildCustomId('utility', 'embed-import', ownerId, pendingId))
    .setLabel('Import JSON')
    .setStyle(ButtonStyle.Secondary);

  return [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect),
    new ActionRowBuilder<ButtonBuilder>().addComponents(editButton, importButton),
  ];
}

async function validateImageUrl(imageUrl: string | undefined): Promise<void> {
  if (!imageUrl) return;
  try {
    await assertPublicHttpUrl(imageUrl);
  } catch (err) {
    const message = err instanceof SsrfError ? err.message : 'That image URL is not allowed.';
    throw new EmbedPayloadError(`Image URL rejected: ${message}`);
  }
}

/** Shared by the "create" and "import" modal submit handlers: sanitize + validate, store, and reply with the preview. */
async function finishModalSubmit(
  c: ComponentContext,
  ownerId: string,
  rawPayload: EmbedBuilderPayload,
): Promise<void> {
  const interaction = c.interaction as unknown as ModalSubmitInteraction<'cached'>;

  let payload: EmbedBuilderPayload;
  try {
    payload = sanitizeEmbedPayload(rawPayload);
    await validateImageUrl(payload.imageUrl);
  } catch (err) {
    const message = err instanceof EmbedPayloadError ? err.message : 'Could not build that embed.';
    await interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
    return;
  }

  if (isPayloadEmpty(payload)) {
    await interaction.reply({ embeds: [errorEmbed(c.t('embed.emptyPayload'))], ephemeral: true });
    return;
  }

  const pendingStore = new PendingStore(c.ctx.redis);
  const pendingId = await pendingStore.put(payload, PENDING_TTL_SECONDS);

  await interaction.reply({
    embeds: [buildPreviewEmbed(payload)],
    components: buildPreviewComponents(ownerId, pendingId),
    ephemeral: true,
  });
}

const createOrEditModalHandler: ComponentHandler = {
  action: 'embed-modal',
  kind: 'modal',
  ownerOnly: true,
  async handler(c) {
    const interaction = c.interaction as unknown as ModalSubmitInteraction<'cached'>;
    const [ownerId] = c.args;

    const raw: EmbedBuilderPayload = {
      title: interaction.fields.getTextInputValue('title') || undefined,
      description: interaction.fields.getTextInputValue('description') || undefined,
      colorHex: interaction.fields.getTextInputValue('colorHex') || undefined,
      imageUrl: interaction.fields.getTextInputValue('imageUrl') || undefined,
      footer: interaction.fields.getTextInputValue('footer') || undefined,
    };

    await finishModalSubmit(c, ownerId as string, raw);
  },
};

const importModalHandler: ComponentHandler = {
  action: 'embed-import-modal',
  kind: 'modal',
  ownerOnly: true,
  async handler(c) {
    const interaction = c.interaction as unknown as ModalSubmitInteraction<'cached'>;
    const [ownerId] = c.args;
    const jsonText = interaction.fields.getTextInputValue('json');

    let payload: EmbedBuilderPayload;
    try {
      payload = embedPayloadFromJson(jsonText);
      await validateImageUrl(payload.imageUrl);
    } catch (err) {
      const message = err instanceof EmbedPayloadError ? err.message : 'Could not import that JSON.';
      await interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
      return;
    }

    if (isPayloadEmpty(payload)) {
      await interaction.reply({ embeds: [errorEmbed(c.t('embed.invalidJson'))], ephemeral: true });
      return;
    }

    const pendingStore = new PendingStore(c.ctx.redis);
    const pendingId = await pendingStore.put(payload, PENDING_TTL_SECONDS);

    await interaction.reply({
      embeds: [buildPreviewEmbed(payload)],
      components: buildPreviewComponents(ownerId as string, pendingId),
      ephemeral: true,
    });
  },
};

const editButtonHandler: ComponentHandler = {
  action: 'embed-edit',
  kind: 'button',
  ownerOnly: true,
  async handler(c) {
    const interaction = c.interaction as unknown as ButtonInteraction<'cached'>;
    const [ownerId, pendingId] = c.args;

    const pendingStore = new PendingStore(c.ctx.redis);
    const payload = pendingId ? await pendingStore.peek<EmbedBuilderPayload>(pendingId) : null;
    if (!payload) {
      await interaction.update({ content: c.t('embed.expired'), embeds: [], components: [] });
      return;
    }

    await interaction.showModal(buildEmbedModal(ownerId as string, pendingId as string, payload));
  },
};

const importButtonHandler: ComponentHandler = {
  action: 'embed-import',
  kind: 'button',
  ownerOnly: true,
  async handler(c) {
    const interaction = c.interaction as unknown as ButtonInteraction<'cached'>;
    const [ownerId, pendingId] = c.args;

    const modal = new ModalBuilder()
      .setCustomId(
        buildCustomId('utility', 'embed-import-modal', ownerId as string, (pendingId as string) ?? 'new'),
      )
      .setTitle('Import embed JSON');

    const jsonInput = new TextInputBuilder()
      .setCustomId('json')
      .setLabel('Embed JSON')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setPlaceholder(
        '{ "title": "...", "description": "...", "color": 5793266, "image": { "url": "..." }, "footer": { "text": "..." } }',
      )
      .setMaxLength(4000);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(jsonInput));

    await interaction.showModal(modal);
  },
};

const channelSelectHandler: ComponentHandler = {
  action: 'embed-channel',
  kind: 'select',
  ownerOnly: true,
  async handler(c) {
    const interaction = c.interaction as unknown as ChannelSelectMenuInteraction<'cached'>;
    const [, pendingId] = c.args;

    const pendingStore = new PendingStore(c.ctx.redis);
    const payload = pendingId ? await pendingStore.peek<EmbedBuilderPayload>(pendingId) : null;
    if (!payload) {
      await interaction.update({ content: c.t('embed.expired'), embeds: [], components: [] });
      return;
    }

    const embed = buildPreviewEmbed(payload);
    const channelId = interaction.values[0];
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);

    if (!channel || !channel.isTextBased()) {
      await interaction.update({
        content: 'That channel is not a text channel I can send to.',
        embeds: [embed],
        components: interaction.message.components,
      });
      return;
    }

    try {
      assertBotPermissions(
        channel,
        [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
        c.t,
      );
    } catch {
      await interaction.update({
        content: `I'm missing permissions to send in <#${channelId}>.`,
        embeds: [embed],
        components: interaction.message.components,
      });
      return;
    }

    await channel.send({ embeds: [embed] });
    c.ctx.logger.info(
      { guildId: c.guildId, channelId, userId: interaction.user.id },
      'utility: embed builder sent a message',
    );

    await interaction.update({ content: `Sent to <#${channelId}>.`, embeds: [embed], components: [] });
  },
};

export const embedBuilderComponents: ComponentHandler[] = [
  createOrEditModalHandler,
  importModalHandler,
  editButtonHandler,
  importButtonHandler,
  channelSelectHandler,
];
