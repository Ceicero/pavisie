import type { ModalSubmitInteraction } from 'discord.js';
import { errorEmbed, successEmbed, PendingStore, type ComponentHandler } from '../../sdk';

interface PendingAppeal {
  recordId: string;
  caseId: string;
}

/** Submits the appeal opened via `/enforcer appeal`'s modal, through the moderation plugin's appeal workflow. */
const appealModalHandler: ComponentHandler = {
  action: 'appeal-modal',
  kind: 'modal',
  ownerOnly: true,
  async handler(c) {
    const [, pendingId] = c.args;
    const interaction = c.interaction as unknown as ModalSubmitInteraction<'cached'>;
    const content = interaction.fields.getTextInputValue('content').trim();

    const pendingStore = new PendingStore(c.ctx.redis);
    const pending = pendingId ? await pendingStore.take<PendingAppeal>(pendingId) : null;
    if (!pending) {
      await interaction.reply({
        embeds: [errorEmbed(c.t('appeal.sessionExpired'))],
        ephemeral: true,
      });
      return;
    }

    const moderation = c.ctx.services.get('moderation');
    if (!moderation) {
      await interaction.reply({
        embeds: [errorEmbed(c.t('appeal.moderationUnavailable'))],
        ephemeral: true,
      });
      return;
    }

    await moderation.openAppeal({
      guildId: c.guildId,
      userId: interaction.user.id,
      caseId: pending.caseId,
      content,
      source: 'bot',
    });

    await interaction.reply({ embeds: [successEmbed(c.t('appeal.opened'))], ephemeral: true });
  },
};

export const appealComponents: ComponentHandler[] = [appealModalHandler];
