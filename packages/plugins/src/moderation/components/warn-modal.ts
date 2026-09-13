import type { GuildMember, ModalSubmitInteraction } from 'discord.js';
import { NotFoundError } from '@pavisie/core';
import { fetchMemberSafe, hierarchyGuard, type ComponentHandler } from '../../sdk';
import { buildCaseLogEmbed } from '../embeds';
import { moderationService } from '../commands/shared';

/** Modal submitted from the "Warn user" context menu (see `commands/context-menu-warn.ts`). */
export const warnModalComponent: ComponentHandler = {
  action: 'warn-modal',
  kind: 'modal',
  ownerOnly: true,
  requirement: { staffLevel: 'moderator' },
  async handler(c) {
    const [, targetId] = c.args;
    const interaction = c.interaction as ModalSubmitInteraction<'cached'>;
    if (!targetId) throw new NotFoundError('Target user not found.');

    const target = await fetchMemberSafe(c.interaction.guild, targetId);
    if (!target) throw new NotFoundError('That member is no longer in this server.');
    hierarchyGuard(
      { guild: c.interaction.guild, member: c.interaction.member as GuildMember },
      target,
      c.ctx.botOwnerIds,
      c.t,
    );

    const reason = interaction.fields.getTextInputValue('reason') || undefined;
    const service = moderationService(c.ctx);
    const row = await service.warn({
      guildId: c.guildId,
      targetId,
      moderatorId: c.interaction.user.id,
      reason,
      source: 'BOT',
    });

    await interaction.reply({ embeds: [buildCaseLogEmbed(row)], ephemeral: true });
  },
};
