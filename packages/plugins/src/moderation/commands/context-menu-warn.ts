import {
  ActionRowBuilder,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { assertStaffLevel, buildCustomId, errorEmbed, hierarchyGuard, type PluginCommand } from '../../sdk';

const data = new ContextMenuCommandBuilder()
  .setName('Warn user')
  .setType(ApplicationCommandType.User)
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'moderator', guildOnly: true },
  async execute(c) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('errors.not_found', { thing: 'Command' }))],
      ephemeral: true,
    });
  },
  async executeContextMenu(c) {
    assertStaffLevel(c.staffLevel, 'moderator', c.t);
    // Same umbrella-type narrowing as context-menu-cases.ts — this command is only ever registered as a User
    // context menu.
    if (!c.interaction.isUserContextMenuCommand()) {
      throw new Error('moderation: expected a user context menu interaction');
    }
    const target = c.interaction.targetMember;
    if (!target) {
      await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.notAMember'))], ephemeral: true });
      return;
    }
    hierarchyGuard(
      { guild: c.interaction.guild, member: c.interaction.member },
      target,
      c.ctx.botOwnerIds,
      c.t,
    );

    const modal = new ModalBuilder()
      .setCustomId(buildCustomId('moderation', 'warn-modal', c.interaction.user.id, target.id))
      .setTitle(`Warn ${target.user.tag}`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1000)
            .setRequired(false),
        ),
      );

    await c.interaction.showModal(modal);
  },
};
