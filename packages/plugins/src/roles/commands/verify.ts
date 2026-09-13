import { ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { redisKey, shortId } from '@pavisie/core';
import { buildCustomId, errorEmbed, infoEmbed, successEmbed, type PluginCommand } from '../../sdk';
import type { RolesConfig } from '../manifest';

const CAPTCHA_TOKEN_TTL_SECONDS = 600;

const data = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Verify yourself to get access to the rest of the server.')
  .setDMPermission(false);

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true, cooldown: { seconds: 10, scope: 'user' } },
  async execute(c) {
    const config = await c.config<RolesConfig>();
    const { verification } = config;

    if (verification.verifiedRoleId && c.interaction.member.roles.cache.has(verification.verifiedRoleId)) {
      await c.interaction.reply({ embeds: [successEmbed("You're already verified.")], ephemeral: true });
      return;
    }

    if (verification.mode === 'button') {
      const roles = c.ctx.services.get('roles');
      if (!roles) {
        await c.interaction.reply({
          embeds: [errorEmbed('Verification is not available right now — please try again shortly.')],
          ephemeral: true,
        });
        return;
      }
      await roles.verifyMember({ guildId: c.guildId, userId: c.interaction.user.id, method: 'button' });
      await c.interaction.reply({ embeds: [successEmbed("You're verified! Welcome in.")], ephemeral: true });
      return;
    }

    if (verification.mode === 'modal') {
      if (verification.questions.length === 0) {
        await c.interaction.reply({
          embeds: [
            errorEmbed(
              'Verification is set to modal mode but has no questions configured yet — ask staff to run `/verification setup`.',
            ),
          ],
          ephemeral: true,
        });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(buildCustomId('roles', 'verify-modal', c.interaction.user.id))
        .setTitle('Verification')
        .addComponents(
          verification.questions.map(
            (question, i) =>
              ({
                type: 1,
                components: [
                  new TextInputBuilder()
                    .setCustomId(`q${i}`)
                    .setLabel(question.slice(0, 45))
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1000)
                    .toJSON(),
                ],
              }) as never,
          ),
        );
      await c.interaction.showModal(modal);
      return;
    }

    // mode === 'captcha'
    if (c.ctx.env.CAPTCHA_PROVIDER === 'none' || !c.ctx.env.CAPTCHA_PROVIDER) {
      await c.interaction.reply({
        embeds: [
          errorEmbed(
            'CAPTCHA verification is not configured on this bot instance — ask staff to switch verification mode.',
          ),
        ],
        ephemeral: true,
      });
      return;
    }
    if (!c.ctx.env.API_BASE_URL) {
      await c.interaction.reply({
        embeds: [
          errorEmbed(
            'CAPTCHA verification is not fully configured (missing API base URL) — ask staff to switch verification mode.',
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    const token = shortId(24);
    await c.ctx.redis.set(
      redisKey('verify', 'pending', token),
      JSON.stringify({ guildId: c.guildId, userId: c.interaction.user.id }),
      'EX',
      CAPTCHA_TOKEN_TTL_SECONDS,
    );

    await c.interaction.reply({
      embeds: [
        infoEmbed(
          'Verify',
          `Complete the CAPTCHA here (link expires in 10 minutes):\n${c.ctx.env.API_BASE_URL}/verify/${token}`,
        ),
      ],
      ephemeral: true,
    });
  },
};
