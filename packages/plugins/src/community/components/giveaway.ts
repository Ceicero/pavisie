import type { ButtonInteraction } from 'discord.js';
import { errorEmbed, publicEmbed, successEmbed, type ComponentHandler } from '../../sdk';
import { evaluateGiveawayEligibility } from '../actions';
import { buildGiveawayComponents, buildGiveawayEmbed } from '../render';

const REASON_MESSAGE: Record<string, string> = {
  ended: 'This giveaway has already ended.',
  missing_role: 'You need a specific role to enter this giveaway.',
  account_too_new: 'Your Discord account is too new to enter this giveaway.',
  below_min_level: 'You need a higher level to enter this giveaway.',
};

const enterButton: ComponentHandler = {
  action: 'gw-enter',
  kind: 'button',
  ownerOnly: false,
  async handler(c) {
    const interaction = c.interaction as ButtonInteraction<'cached'>;
    const [giveawayId] = c.args;
    if (!giveawayId) {
      await interaction.reply({ embeds: [errorEmbed('Malformed giveaway button.')], ephemeral: true });
      return;
    }

    const giveaway = await c.ctx.prisma.giveaway.findUnique({ where: { id: giveawayId } });
    if (!giveaway) {
      await interaction.reply({ embeds: [errorEmbed('This giveaway no longer exists.')], ephemeral: true });
      return;
    }

    const member = interaction.member;
    const eligibility = await evaluateGiveawayEligibility(c.ctx, giveaway, member);
    if (!eligibility.ok) {
      await interaction.reply({ embeds: [errorEmbed(REASON_MESSAGE[eligibility.reason])], ephemeral: true });
      return;
    }

    const existing = await c.ctx.prisma.giveawayEntry.findUnique({
      where: { giveawayId_userId: { giveawayId, userId: interaction.user.id } },
    });
    if (existing) {
      await c.ctx.prisma.giveawayEntry.delete({ where: { id: existing.id } });
      await interaction.reply({ embeds: [successEmbed('You left this giveaway.')], ephemeral: true });
    } else {
      await c.ctx.prisma.giveawayEntry.create({ data: { giveawayId, userId: interaction.user.id } });
      await interaction.reply({
        embeds: [successEmbed('You entered this giveaway. Good luck! 🍀')],
        ephemeral: true,
      });
    }

    const entryCount = await c.ctx.prisma.giveawayEntry.count({ where: { giveawayId } });
    await interaction.message
      .edit({
        embeds: [await publicEmbed(c.ctx, c.guildId, buildGiveawayEmbed(giveaway, entryCount))],
        components: buildGiveawayComponents(giveaway.id, giveaway.ended),
      })
      .catch(() => undefined);
  },
};

export const giveawayComponents: ComponentHandler[] = [enterButton];
