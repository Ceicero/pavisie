import { SlashCommandBuilder, userMention } from 'discord.js';
import {
  assertStaffLevel,
  brandEmbed,
  errorEmbed,
  listEmbed,
  successEmbed,
  type PluginCommand,
} from '../../sdk';
import type { EngagementConfig } from '../manifest';
import { canGiveRep, takeRepCooldown } from '../service';

const data = new SlashCommandBuilder()
  .setName('rep')
  .setDescription('Reputation: thank members whose help you appreciated.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('give')
      .setDescription('Give a member reputation.')
      .addUserOption((opt) => opt.setName('user').setDescription('Who to thank.').setRequired(true))
      .addStringOption((opt) =>
        opt.setName('reason').setDescription('Optional short reason.').setMaxLength(200),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('check')
      .setDescription("Check a member's reputation total.")
      .addUserOption((opt) => opt.setName('user').setDescription('Defaults to you.')),
  )
  .addSubcommand((sub) => sub.setName('leaderboard').setDescription('Show the reputation leaderboard.'))
  .addSubcommand((sub) =>
    sub
      .setName('revoke')
      .setDescription('Remove reputation from a member (admin).')
      .addUserOption((opt) => opt.setName('user').setDescription('Member to adjust.').setRequired(true))
      .addIntegerOption((opt) =>
        opt.setName('amount').setDescription('Amount to remove.').setMinValue(1).setRequired(true),
      )
      .addStringOption((opt) => opt.setName('reason').setDescription('Why.').setMaxLength(200)),
  );

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    const config = await c.config<EngagementConfig>();

    if (!config.rep.enabled && sub !== 'revoke') {
      await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.repDisabled'))], ephemeral: true });
      return;
    }

    if (sub === 'give') {
      const target = c.interaction.options.getUser('user', true);
      const reason = c.interaction.options.getString('reason') ?? undefined;

      const eligibility = canGiveRep(c.interaction.user.id, target.id);
      if (!eligibility.ok) {
        await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.selfRep'))], ephemeral: true });
        return;
      }
      if (target.bot) {
        await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.repBot'))], ephemeral: true });
        return;
      }

      const cooldown = await takeRepCooldown(
        c.ctx.redis,
        c.guildId,
        c.interaction.user.id,
        config.rep.cooldownHours,
      );
      if (!cooldown.ok) {
        const resetAt = Math.floor((Date.now() + cooldown.retryAfterMs) / 1000);
        await c.interaction.reply({
          embeds: [errorEmbed(c.t('errors.repCooldown', { resetAt }))],
          ephemeral: true,
        });
        return;
      }

      await c.ctx.prisma.reputationEvent.create({
        data: {
          guildId: c.guildId,
          fromUserId: c.interaction.user.id,
          toUserId: target.id,
          amount: 1,
          reason: reason ?? null,
        },
      });

      await c.interaction.reply({
        embeds: [successEmbed(c.t('rep.give.success', { user: userMention(target.id) }))],
        ephemeral: false,
      });
      return;
    }

    if (sub === 'check') {
      const target = c.interaction.options.getUser('user') ?? c.interaction.user;
      const agg = await c.ctx.prisma.reputationEvent.aggregate({
        where: { guildId: c.guildId, toUserId: target.id },
        _sum: { amount: true },
        _count: true,
      });
      const total = agg._sum.amount ?? 0;
      const embed = brandEmbed()
        .setTitle(c.t('rep.check.title', { name: target.username }))
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: c.t('rep.check.fieldTotal'), value: String(total), inline: true },
          { name: c.t('rep.check.fieldCount'), value: String(agg._count), inline: true },
        );
      await c.interaction.reply({ embeds: [embed], ephemeral: false });
      return;
    }

    if (sub === 'leaderboard') {
      const grouped = await c.ctx.prisma.reputationEvent.groupBy({
        by: ['toUserId'],
        where: { guildId: c.guildId },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 10,
      });
      const positive = grouped.filter((g) => (g._sum.amount ?? 0) > 0);
      const lines =
        positive.length > 0
          ? positive.map((g, i) =>
              c.t('rep.leaderboard.row', {
                rank: i + 1,
                user: userMention(g.toUserId),
                amount: g._sum.amount ?? 0,
              }),
            )
          : [c.t('rep.leaderboard.empty')];
      await c.interaction.reply({
        embeds: [listEmbed(c.t('rep.leaderboard.title'), lines)],
        ephemeral: false,
      });
      return;
    }

    // sub === 'revoke'
    assertStaffLevel(c.staffLevel, 'admin', c.t);
    const target = c.interaction.options.getUser('user', true);
    const amount = c.interaction.options.getInteger('amount', true);
    const reason = c.interaction.options.getString('reason') ?? undefined;

    await c.ctx.prisma.reputationEvent.create({
      data: {
        guildId: c.guildId,
        fromUserId: c.interaction.user.id,
        toUserId: target.id,
        amount: -amount,
        reason: reason ? `Revoked: ${reason}` : 'Revoked by staff',
      },
    });
    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: 'engagement.rep.revoke',
      targetType: 'reputation',
      targetId: target.id,
      after: { amount: -amount, reason },
      source: 'bot',
    });

    await c.interaction.reply({
      embeds: [successEmbed(c.t('rep.revoke.success', { amount, user: userMention(target.id) }))],
      ephemeral: true,
    });
  },
};
