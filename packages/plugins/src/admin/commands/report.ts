import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { assertStaffLevel, brandEmbed, buildCustomId, type PluginCommand } from '../../sdk';
import { REPORT_KIND_CHOICES } from '../report-shared';

const data = new SlashCommandBuilder()
  .setName('pavisie')
  .setDescription('Bot-level tools for talking to the Pavisie developer.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('report')
      .setDescription('Send a bug report, feedback, or question to the Pavisie developer.')
      .addStringOption((opt) =>
        opt
          .setName('kind')
          .setDescription('What kind of report is this?')
          .setRequired(true)
          .addChoices(...REPORT_KIND_CHOICES),
      ),
  );

/**
 * `/pavisie report kind:<bug|feedback|question>` — step 1 of 2. Admin-only for now (Brandon's explicit call:
 * start narrow, widen once real volume is known — see the `admin` README's "Developer reports" section). Never
 * opens the modal directly off the slash command: Discord interactions can only be acknowledged once, so
 * showing the privacy disclosure *and* the subject/body modal both requires an intermediate step — this replies
 * ephemerally with the disclosure + a "Write report" button; `components/report.ts`'s `report-continue` handler
 * opens the modal from that button click.
 */
export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'admin', guildOnly: true },
  async execute(c) {
    assertStaffLevel(c.staffLevel, 'admin', c.t);
    const sub = c.interaction.options.getSubcommand(true);
    if (sub !== 'report') return; // only one subcommand today; guards silently against future additions

    const kind = c.interaction.options.getString('kind', true);
    const ownerId = c.interaction.user.id;

    const embed = brandEmbed()
      .setTitle(c.t('report.discloseTitle'))
      .setDescription(c.t('report.discloseBody'));

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('admin', 'report-continue', ownerId, kind))
        .setLabel('Write report')
        .setStyle(ButtonStyle.Primary),
    );

    await c.interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  },
};
