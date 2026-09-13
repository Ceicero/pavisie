import type { ModalSubmitInteraction } from 'discord.js';
import { AuditAction } from '@pavisie/core';
import { errorEmbed, successEmbed, type ComponentHandler } from '../../sdk';
import { normalizeEmbedColor } from '../engine';
import type { RolesConfig } from '../manifest';

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function buildEmbedModalHandler(section: 'welcome' | 'goodbye'): ComponentHandler {
  return {
    action: `${section}-embed-modal`,
    kind: 'modal',
    ownerOnly: true,
    async handler(c) {
      const interaction = c.interaction as unknown as ModalSubmitInteraction<'cached'>;
      const title = interaction.fields.getTextInputValue('title') || undefined;
      const description = interaction.fields.getTextInputValue('description') || undefined;
      const color = interaction.fields.getTextInputValue('color') || undefined;
      const footer = interaction.fields.getTextInputValue('footer') || undefined;

      if (color && !HEX_COLOR_PATTERN.test(color)) {
        await interaction.reply({
          embeds: [errorEmbed('Color must be a hex code like #e5e5e5.')],
          ephemeral: true,
        });
        return;
      }

      if (!title && !description) {
        await interaction.reply({
          embeds: [errorEmbed('Set at least a title or a description.')],
          ephemeral: true,
        });
        return;
      }

      const current = await c.config<RolesConfig>();
      // Discord's API wants `color` as an integer and rejects the whole message for a string, so the hex the
      // member typed is converted here rather than at send time.
      const colorInt = normalizeEmbedColor(color);
      const embed = {
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(colorInt !== undefined ? { color: colorInt } : {}),
        ...(footer ? { footer: { text: footer } } : {}),
      };

      await c.ctx.setConfig<RolesConfig>(
        c.guildId,
        { [section]: { ...current[section], enabled: true, embed } } as Partial<RolesConfig>,
        { id: interaction.user.id, source: 'bot' },
      );
      await c.ctx.audit({
        guildId: c.guildId,
        actorId: interaction.user.id,
        actorType: 'user',
        action: AuditAction.RolesWelcomeUpdate,
        targetType: 'plugin_config',
        targetId: 'roles',
        source: 'bot',
      });

      await interaction.reply({
        embeds: [successEmbed(`Saved the ${section} embed. Run \`/${section} test\` to preview it.`)],
        ephemeral: true,
      });
    },
  };
}

export const welcomeEmbedModalHandler = buildEmbedModalHandler('welcome');
export const goodbyeEmbedModalHandler = buildEmbedModalHandler('goodbye');
