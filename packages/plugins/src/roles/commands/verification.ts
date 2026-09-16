import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { assertStaffLevel, errorEmbed, listEmbed, successEmbed, type PluginCommand } from '../../sdk';
import type { RolesConfig, VerificationConfig } from '../manifest';

const MODE_CHOICES = [
  { name: 'Button (instant)', value: 'button' },
  { name: 'Modal (staff-approved questions)', value: 'modal' },
  { name: 'CAPTCHA (requires CAPTCHA_PROVIDER)', value: 'captcha' },
] as const;

/**
 * Choices for what happens when the minimum-account-age gate rejects someone.
 *
 * Named "age gate" rather than "underage" on every surface Discord can read. Discord's App
 * Directory check scans registered command and option names for "harmful or bad language" and
 * flagged `/verification` on the word "underage" alone, which blocked discovery for the whole app
 * — an automated filter catching a minor-safety feature because of the word it used to describe
 * itself. The stored config key stays `underageAction` (see manifest.ts): it is persisted per
 * guild and exposed in the dashboard API, Discord never sees it, and renaming it would mean a
 * data migration for no benefit. Do not rename this option back.
 */
const AGE_GATE_ACTION_CHOICES = [
  { name: 'None', value: 'none' },
  { name: 'Quarantine', value: 'quarantine' },
  { name: 'Kick', value: 'kick' },
] as const;

const data = new SlashCommandBuilder()
  .setName('verification')
  .setDescription('Configure and manage member verification.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Configure verification.')
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Verification method')
          .addChoices(...MODE_CHOICES),
      )
      .addRoleOption((opt) =>
        opt.setName('verified-role').setDescription('Role granted on successful verification'),
      )
      .addChannelOption((opt) =>
        opt
          .setName('staff-channel')
          .setDescription('Channel for the modal-mode approval queue')
          .addChannelTypes(ChannelType.GuildText),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('min-account-age-days')
          .setDescription('Minimum Discord account age required (0 = off)')
          .setMinValue(0)
          .setMaxValue(3650),
      )
      .addStringOption((opt) =>
        opt
          .setName('age-gate-action')
          .setDescription('Action when the account-age gate fails')
          .addChoices(...AGE_GATE_ACTION_CHOICES),
      )
      .addRoleOption((opt) =>
        opt.setName('quarantine-role').setDescription('Role applied by the quarantine action'),
      )
      .addStringOption((opt) =>
        opt.setName('question1').setDescription('Modal-mode question 1').setMaxLength(300),
      )
      .addStringOption((opt) =>
        opt.setName('question2').setDescription('Modal-mode question 2').setMaxLength(300),
      )
      .addStringOption((opt) =>
        opt.setName('question3').setDescription('Modal-mode question 3').setMaxLength(300),
      )
      .addStringOption((opt) =>
        opt.setName('question4').setDescription('Modal-mode question 4').setMaxLength(300),
      )
      .addStringOption((opt) =>
        opt.setName('question5').setDescription('Modal-mode question 5').setMaxLength(300),
      )
      .addBooleanOption((opt) =>
        opt.setName('clear-questions').setDescription('Clear all configured questions'),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('queue').setDescription('List pending (modal-mode) verification requests.'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('approve')
      .setDescription('Approve a pending verification request.')
      .addStringOption((opt) =>
        opt.setName('request').setDescription('Request id').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('deny')
      .setDescription('Deny a pending verification request.')
      .addStringOption((opt) =>
        opt.setName('request').setDescription('Request id').setRequired(true).setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt.setName('note').setDescription('Optional note sent to the member').setMaxLength(500),
      ),
  );

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'moderator', guildOnly: true },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);

    if (sub === 'setup') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);
      const mode = c.interaction.options.getString('mode') as VerificationConfig['mode'] | null;
      if (mode === 'captcha' && (!c.ctx.env.CAPTCHA_PROVIDER || c.ctx.env.CAPTCHA_PROVIDER === 'none')) {
        await c.interaction.reply({
          embeds: [
            errorEmbed(
              'CAPTCHA mode requires `CAPTCHA_PROVIDER` to be set to `hcaptcha` or `turnstile` on the bot host.',
            ),
          ],
          ephemeral: true,
        });
        return;
      }

      const current = await c.config<RolesConfig>();
      const clearQuestions = c.interaction.options.getBoolean('clear-questions') ?? false;
      const questionInputs = ['question1', 'question2', 'question3', 'question4', 'question5']
        .map((key) => c.interaction.options.getString(key))
        .filter((q): q is string => Boolean(q));

      const nextVerification: VerificationConfig = {
        ...current.verification,
        mode: mode ?? current.verification.mode,
        verifiedRoleId:
          c.interaction.options.getRole('verified-role')?.id ?? current.verification.verifiedRoleId,
        staffChannelId:
          c.interaction.options.getChannel('staff-channel')?.id ?? current.verification.staffChannelId,
        minAccountAgeDays:
          c.interaction.options.getInteger('min-account-age-days') ?? current.verification.minAccountAgeDays,
        underageAction:
          (c.interaction.options.getString('age-gate-action') as
            VerificationConfig['underageAction'] | null) ?? current.verification.underageAction,
        quarantineRoleId:
          c.interaction.options.getRole('quarantine-role')?.id ?? current.verification.quarantineRoleId,
        questions: clearQuestions
          ? []
          : questionInputs.length > 0
            ? questionInputs
            : current.verification.questions,
      };

      const after = await c.ctx.setConfig<RolesConfig>(
        c.guildId,
        { verification: nextVerification },
        { id: c.interaction.user.id, source: 'bot' },
      );

      await c.ctx.audit({
        guildId: c.guildId,
        actorId: c.interaction.user.id,
        actorType: 'user',
        action: 'verification.settings.update',
        targetType: 'plugin_config',
        targetId: 'roles',
        source: 'bot',
      });

      await c.interaction.reply({
        embeds: [
          successEmbed(
            [
              `Mode: **${after.verification.mode}**`,
              `Verified role: ${after.verification.verifiedRoleId ? `<@&${after.verification.verifiedRoleId}>` : '_not set_'}`,
              `Staff queue channel: ${after.verification.staffChannelId ? `<#${after.verification.staffChannelId}>` : '_not set_'}`,
              `Min account age: ${after.verification.minAccountAgeDays} day(s)`,
              `Age-gate action: ${after.verification.underageAction}`,
              `Questions: ${after.verification.questions.length}`,
            ].join('\n'),
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'queue') {
      const pending = await c.ctx.prisma.verificationRequest.findMany({
        where: { guildId: c.guildId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: 25,
      });
      const lines = pending.map(
        (r) =>
          `\`${r.id}\` — <@${r.userId}> · ${r.method.toLowerCase()} · submitted <t:${Math.floor(r.createdAt.getTime() / 1000)}:R>`,
      );
      await c.interaction.reply({ embeds: [listEmbed('Verification queue', lines)], ephemeral: true });
      return;
    }

    if (sub === 'approve' || sub === 'deny') {
      const requestId = c.interaction.options.getString('request', true);
      const note = sub === 'deny' ? (c.interaction.options.getString('note') ?? undefined) : undefined;

      const roles = c.ctx.services.get('roles');
      if (!roles) {
        await c.interaction.reply({
          embeds: [errorEmbed('The roles service is not available right now.')],
          ephemeral: true,
        });
        return;
      }

      const request = await c.ctx.prisma.verificationRequest.findFirst({
        where: { id: requestId, guildId: c.guildId },
      });
      if (!request || request.status !== 'PENDING') {
        await c.interaction.reply({
          embeds: [errorEmbed('That request was not found or has already been decided.')],
          ephemeral: true,
        });
        return;
      }

      await roles.verificationDecision({
        guildId: c.guildId,
        requestId,
        approve: sub === 'approve',
        reviewerId: c.interaction.user.id,
        note,
      });
      await c.interaction.reply({
        embeds: [successEmbed(`Request ${sub === 'approve' ? 'approved' : 'denied'}.`)],
        ephemeral: true,
      });
    }
  },
  async autocomplete(c) {
    const query = String(c.interaction.options.getFocused()).toLowerCase();
    const pending = await c.ctx.prisma.verificationRequest.findMany({
      where: { guildId: c.guildId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
    const matches = pending.filter((r) => r.id.toLowerCase().includes(query) || r.userId.includes(query));
    await c.interaction.respond(matches.map((r) => ({ name: `${r.id} — user ${r.userId}`, value: r.id })));
  },
};
