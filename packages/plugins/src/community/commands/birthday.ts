import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { AuditAction, hasStaffLevel } from '@pavisie/core';
import {
  assertStaffLevel,
  errorEmbed,
  infoEmbed,
  listEmbed,
  resolveTextChannel,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import { checkRoleAssignable } from '../../roles/engine';
import {
  findUnknownMessageTokens,
  formatBirthday,
  formatBirthdayShort,
  localNow,
  parseBirthday,
  upcomingSorted,
} from '../birthdays';
import type { CommunityConfig } from '../manifest';

const MONTH_CHOICES = [
  { name: 'January', value: 1 },
  { name: 'February', value: 2 },
  { name: 'March', value: 3 },
  { name: 'April', value: 4 },
  { name: 'May', value: 5 },
  { name: 'June', value: 6 },
  { name: 'July', value: 7 },
  { name: 'August', value: 8 },
  { name: 'September', value: 9 },
  { name: 'October', value: 10 },
  { name: 'November', value: 11 },
  { name: 'December', value: 12 },
];

// One top-level `/birthday` command: member self-service (set/remove/view/upcoming) plus staff config
// subcommands. Discord's default-member-permissions is per top-level command, so it stays open to everyone and
// the config subcommands enforce staff level in code (`hasStaffLevel`) instead.
const data = new SlashCommandBuilder()
  .setName('birthday')
  .setDescription('Share your birthday (month + day only) and see upcoming ones.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Set your birthday in this server (month and day only — never a year).')
      .addIntegerOption((opt) =>
        opt
          .setName('month')
          .setDescription('Month')
          .setRequired(true)
          .addChoices(...MONTH_CHOICES),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('day')
          .setDescription('Day of the month')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(31),
      )
      .addUserOption((opt) =>
        opt
          .setName('user')
          .setDescription("Admin only: set another member's birthday instead of your own")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove your birthday from this server.')
      .addUserOption((opt) =>
        opt
          .setName('user')
          .setDescription("Admin only: remove another member's birthday instead of your own")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription("View your birthday (or another member's, if the server allows it).")
      .addUserOption((opt) => opt.setName('user').setDescription('Member to look up').setRequired(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('upcoming')
      .setDescription('List the next upcoming birthdays.')
      .addBooleanOption((opt) =>
        opt
          .setName('ephemeral')
          .setDescription('Only you can see the reply (default: true; staff may post it publicly)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('config')
      .setDescription('Admin: configure birthday announcements.')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel birthdays are announced in')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('hour')
          .setDescription("Hour of the day to announce, in the server's timezone (0-23)")
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(23),
      )
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('Role given for ~24 hours on a birthday').setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName('message')
          .setDescription('Announcement text; tokens: {mention} {user} {server}')
          .setRequired(false)
          .setMaxLength(500),
      )
      .addBooleanOption((opt) =>
        opt.setName('enabled').setDescription('Turn birthday announcements on or off').setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('public_list')
          .setDescription("Let members list upcoming birthdays and view each other's")
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('allow_self_service')
          .setDescription('Let members set/remove their own birthday (off = admins only)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('config-view').setDescription('Staff: show the current birthday settings.'),
  );

async function guildTimezone(c: CommandContext): Promise<string> {
  const host = c.ctx.services.get('host');
  return host ? (await host.getGuildConfig(c.guildId)).timezone : 'UTC';
}

async function handleSet(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t, staffLevel } = c;
  const config = await c.config<CommunityConfig>();
  // `enabled:false` blocks everything below — including an admin setting it for someone else — since there's
  // nowhere to announce it.
  if (!config.birthdays.enabled) {
    await interaction.reply({ embeds: [errorEmbed(t('birthday.disabled'))], ephemeral: true });
    return;
  }
  const targetUser = interaction.options.getUser('user') ?? interaction.user;
  const isSelf = targetUser.id === interaction.user.id;

  if (isSelf) {
    if (!config.birthdays.allowSelfService && !hasStaffLevel(staffLevel, 'admin')) {
      await interaction.reply({ embeds: [errorEmbed(t('birthday.selfServiceDisabled'))], ephemeral: true });
      return;
    }
  } else {
    // Admin-on-behalf: cleaner than a manual hasStaffLevel + errorEmbed pair — orthogonal to `allowSelfService`.
    assertStaffLevel(staffLevel, 'admin', t);
  }

  const parsed = parseBirthday({
    month: interaction.options.getInteger('month', true),
    day: interaction.options.getInteger('day', true),
  });
  if (!parsed.ok) {
    await interaction.reply({
      embeds: [errorEmbed(t(parsed.reason === 'month' ? 'birthday.badMonth' : 'birthday.badDay'))],
      ephemeral: true,
    });
    return;
  }

  if (isSelf) {
    // Member self-service data: deliberately not audited (no audit trail of personal data).
    await ctx.prisma.birthday.upsert({
      where: { guildId_userId: { guildId, userId: targetUser.id } },
      create: { guildId, userId: targetUser.id, month: parsed.month, day: parsed.day },
      update: { month: parsed.month, day: parsed.day, lastAnnouncedYear: null },
    });
    await interaction.reply({
      embeds: [successEmbed(t('birthday.set', { date: formatBirthday(parsed) }))],
      ephemeral: true,
    });
    return;
  }

  await ctx.prisma.birthday.upsert({
    where: { guildId_userId: { guildId, userId: targetUser.id } },
    create: { guildId, userId: targetUser.id, month: parsed.month, day: parsed.day },
    update: { month: parsed.month, day: parsed.day, lastAnnouncedYear: null },
  });
  // Admin-on-behalf writes ARE audited — a deliberate departure from the self-service no-audit rule above.
  // Privacy: the payload records only that a birthday was set and for whom, never the month/day itself,
  // matching the dashboard's admin-removal audit (targetId only, never the date).
  await ctx.audit({
    guildId,
    actorId: interaction.user.id,
    actorType: 'user',
    action: AuditAction.CommunityBirthdaySet,
    targetType: 'birthday',
    targetId: targetUser.id,
    source: 'bot',
  });
  await interaction.reply({
    embeds: [
      successEmbed(t('birthday.setOther', { user: `<@${targetUser.id}>`, date: formatBirthday(parsed) })),
    ],
    ephemeral: true,
  });
}

async function handleRemove(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t, staffLevel } = c;
  const config = await c.config<CommunityConfig>();
  const targetUser = interaction.options.getUser('user') ?? interaction.user;
  const isSelf = targetUser.id === interaction.user.id;

  if (isSelf) {
    if (!config.birthdays.allowSelfService && !hasStaffLevel(staffLevel, 'admin')) {
      await interaction.reply({ embeds: [errorEmbed(t('birthday.selfServiceDisabled'))], ephemeral: true });
      return;
    }
    // Member self-service data: deliberately not audited (no audit trail of personal data).
    const result = await ctx.prisma.birthday.deleteMany({ where: { guildId, userId: targetUser.id } });
    await interaction.reply({
      embeds: [successEmbed(t(result.count > 0 ? 'birthday.removed' : 'birthday.nothingToRemove'))],
      ephemeral: true,
    });
    return;
  }

  // Admin-on-behalf: gated so admins can correct a wrong date but a member can't be locked out of clearing
  // their own; reuses the same audit action the dashboard's admin removal uses.
  assertStaffLevel(staffLevel, 'admin', t);
  const result = await ctx.prisma.birthday.deleteMany({ where: { guildId, userId: targetUser.id } });
  if (result.count > 0) {
    await ctx.audit({
      guildId,
      actorId: interaction.user.id,
      actorType: 'user',
      action: AuditAction.CommunityBirthdayRemove,
      targetType: 'birthday',
      targetId: targetUser.id,
      source: 'bot',
    });
  }
  await interaction.reply({
    embeds: [
      successEmbed(
        t(result.count > 0 ? 'birthday.removedOther' : 'birthday.nothingToRemoveOther', {
          user: `<@${targetUser.id}>`,
        }),
      ),
    ],
    ephemeral: true,
  });
}

async function handleView(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t, staffLevel } = c;
  const target = interaction.options.getUser('user') ?? interaction.user;
  const isSelf = target.id === interaction.user.id;
  if (!isSelf) {
    const config = await c.config<CommunityConfig>();
    if (!config.birthdays.publicList && !hasStaffLevel(staffLevel, 'helper')) {
      await interaction.reply({ embeds: [errorEmbed(t('birthday.private'))], ephemeral: true });
      return;
    }
  }
  const row = await ctx.prisma.birthday.findUnique({
    where: { guildId_userId: { guildId, userId: target.id } },
  });
  if (!row) {
    await interaction.reply({
      embeds: [
        errorEmbed(t(isSelf ? 'birthday.noneSelf' : 'birthday.noneOther', { user: `<@${target.id}>` })),
      ],
      ephemeral: true,
    });
    return;
  }
  const date = formatBirthday(row);
  await interaction.reply({
    embeds: [
      infoEmbed(
        t('birthday.viewTitle'),
        isSelf
          ? t('birthday.viewSelf', { date })
          : t('birthday.viewOther', { user: `<@${target.id}>`, date }),
      ),
    ],
    ephemeral: true,
  });
}

async function handleUpcoming(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t, staffLevel } = c;
  const config = await c.config<CommunityConfig>();
  const isStaff = hasStaffLevel(staffLevel, 'helper');
  if (!config.birthdays.publicList && !isStaff) {
    await interaction.reply({ embeds: [errorEmbed(t('birthday.private'))], ephemeral: true });
    return;
  }
  // Public replies are a staff-only option; members always get an ephemeral list.
  const ephemeral = isStaff ? (interaction.options.getBoolean('ephemeral') ?? true) : true;

  const rows = await ctx.prisma.birthday.findMany({
    where: { guildId },
    select: { userId: true, month: true, day: true },
  });
  const today = localNow(await guildTimezone(c));
  const upcoming = upcomingSorted(rows, today, 15);
  const lines = upcoming.map((b) => {
    const when =
      b.inDays === 0
        ? t('birthday.today')
        : b.inDays === 1
          ? t('birthday.tomorrow')
          : t('birthday.inDays', { days: b.inDays });
    return `<@${b.userId}> — ${formatBirthdayShort(b)} (${when})`;
  });
  await interaction.reply({
    embeds: [listEmbed(t('birthday.upcomingTitle'), lines)],
    ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleConfig(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t, staffLevel } = c;
  if (!hasStaffLevel(staffLevel, 'admin')) {
    await interaction.reply({ embeds: [errorEmbed(t('birthday.adminOnly'))], ephemeral: true });
    return;
  }
  const config = await c.config<CommunityConfig>();
  const channelOption = interaction.options.getChannel('channel', true);
  const hour = interaction.options.getInteger('hour');
  const roleOption = interaction.options.getRole('role');
  const message = interaction.options.getString('message');
  const enabled = interaction.options.getBoolean('enabled');
  const publicList = interaction.options.getBoolean('public_list');
  const allowSelfService = interaction.options.getBoolean('allow_self_service');

  const channel = await resolveTextChannel(interaction.guild, channelOption.id);
  if (!channel) {
    await interaction.reply({ embeds: [errorEmbed(t('birthday.badChannel'))], ephemeral: true });
    return;
  }

  if (message !== null) {
    const unknown = findUnknownMessageTokens(message);
    if (unknown.length > 0) {
      await interaction.reply({
        embeds: [
          errorEmbed(t('birthday.badTokens', { tokens: unknown.map((tok) => `{${tok}}`).join(', ') })),
        ],
        ephemeral: true,
      });
      return;
    }
  }

  if (roleOption) {
    const guildRole =
      interaction.guild.roles.cache.get(roleOption.id) ??
      (await interaction.guild.roles.fetch(roleOption.id).catch(() => null));
    const permissionsBitfield =
      typeof roleOption.permissions === 'string'
        ? BigInt(roleOption.permissions)
        : roleOption.permissions.bitfield;
    const assignable = checkRoleAssignable({
      permissionsBitfield,
      position: guildRole?.position ?? 0,
      managed: guildRole?.managed ?? false,
      botTopRolePosition: interaction.guild.members.me?.roles.highest.position ?? 0,
      allowElevatedRoles: false,
    });
    if (!assignable.ok) {
      await interaction.reply({
        embeds: [errorEmbed(t(`birthday.role.${assignable.reason}`))],
        ephemeral: true,
      });
      return;
    }
  }

  const next: CommunityConfig['birthdays'] = {
    ...config.birthdays,
    channelId: channel.id,
    // Configuring a channel implies turning the feature on unless `enabled:false` was passed explicitly.
    enabled: enabled ?? true,
    ...(hour !== null ? { announceHour: hour } : {}),
    ...(roleOption ? { roleId: roleOption.id } : {}),
    ...(message !== null ? { message } : {}),
    ...(publicList !== null ? { publicList } : {}),
    ...(allowSelfService !== null ? { allowSelfService } : {}),
  };
  // `setConfig` audits the change automatically (config changes are the only birthday audit trail).
  await ctx.setConfig<CommunityConfig>(
    guildId,
    { birthdays: next },
    { id: interaction.user.id, source: 'bot' },
  );

  await interaction.reply({
    embeds: [
      successEmbed(
        t('birthday.configSaved', {
          channel: `<#${channel.id}>`,
          hour: String(next.announceHour).padStart(2, '0'),
          state: next.enabled ? t('birthday.on') : t('birthday.off'),
        }),
      ),
    ],
    ephemeral: true,
  });
}

async function handleConfigView(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t, staffLevel } = c;
  if (!hasStaffLevel(staffLevel, 'moderator')) {
    await interaction.reply({ embeds: [errorEmbed(t('birthday.staffOnly'))], ephemeral: true });
    return;
  }
  const config = await c.config<CommunityConfig>();
  const b = config.birthdays;
  const count = await ctx.prisma.birthday.count({ where: { guildId } });
  const timezone = await guildTimezone(c);
  const lines = [
    `**${t('birthday.cfgEnabled')}:** ${b.enabled ? t('birthday.on') : t('birthday.off')}`,
    `**${t('birthday.cfgChannel')}:** ${b.channelId ? `<#${b.channelId}>` : '—'}`,
    `**${t('birthday.cfgHour')}:** ${String(b.announceHour).padStart(2, '0')}:00 (${timezone})`,
    `**${t('birthday.cfgRole')}:** ${b.roleId ? `<@&${b.roleId}>` : '—'}`,
    `**${t('birthday.cfgPublicList')}:** ${b.publicList ? t('birthday.on') : t('birthday.off')}`,
    `**${t('birthday.cfgAllowSelfService')}:** ${b.allowSelfService ? t('birthday.on') : t('birthday.off')}`,
    `**${t('birthday.cfgMessage')}:** ${b.message}`,
    `**${t('birthday.cfgCount')}:** ${count}`,
  ];
  await interaction.reply({
    embeds: [infoEmbed(t('birthday.configTitle'), lines.join('\n'))],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true, cooldown: { seconds: 10, scope: 'user' } },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'set') return handleSet(c);
    if (sub === 'remove') return handleRemove(c);
    if (sub === 'view') return handleView(c);
    if (sub === 'upcoming') return handleUpcoming(c);
    if (sub === 'config') return handleConfig(c);
    return handleConfigView(c);
  },
};
