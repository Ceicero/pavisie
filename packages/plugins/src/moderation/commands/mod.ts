import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
  type Role,
} from 'discord.js';
import { ValidationError } from '@pavisie/core';
import type { ModerationCase, ModerationCaseType } from '@pavisie/database';
import {
  assertBotPermissions,
  assertStaffLevel,
  errorEmbed,
  fetchMemberSafe,
  hierarchyGuard,
  infoEmbed,
  isSnowflake,
  listEmbed,
  paginatedReply,
  requestConfirmation,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import { buildCaseLogEmbed, caseTypeLabel } from '../embeds';
import type { ModerationConfig } from '../manifest';
import { validatePurgeCount } from '../purge';
import { parseTempBanDuration, parseTimeoutDuration } from '../duration';
import { parseEvidenceUrls } from '../validators';
import { getFastActions, moderationService } from './shared';

const CASE_TYPES = [
  'WARN',
  'TIMEOUT',
  'UNTIMEOUT',
  'KICK',
  'BAN',
  'UNBAN',
  'SOFTBAN',
  'PURGE',
  'LOCK',
  'UNLOCK',
  'SLOWMODE',
  'NICK',
  'ROLE_ADD',
  'ROLE_REMOVE',
  'QUARANTINE',
  'NOTE',
] as const satisfies readonly ModerationCaseType[];

const ELEVATED_PERMISSION_FLAGS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.MentionEveryone,
] as const;

function isElevatedRole(role: Role): boolean {
  return ELEVATED_PERMISSION_FLAGS.some((flag) => role.permissions.has(flag));
}

const data = new SlashCommandBuilder()
  .setName('mod')
  .setDescription('Moderation actions: warnings, timeouts, kicks, bans, cases, and more.')
  .setDMPermission(false)
  // Discord-side visibility gate on top of (not instead of) the `staffLevel: 'helper'` requirement below.
  // ModerateMembers would hide the whole command from helper-level staff, yet `warnings`/`note`/`case`/`cases`
  // are deliberately helper-level — ManageMessages is the permission a Helper role actually carries.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName('warn')
      .setDescription('Warn a member. Repeated warnings can trigger automatic escalation.')
      .addUserOption((o) => o.setName('user').setDescription('The member to warn').setRequired(true))
      .addStringOption((o) =>
        o.setName('reason').setDescription('Reason (optional)').setRequired(false).setMaxLength(1000),
      )
      .addStringOption((o) =>
        o.setName('evidence').setDescription('Evidence links, comma-separated (optional)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('warnings')
      .setDescription("List a member's warnings, or every active warning if no member is given.")
      .addUserOption((o) => o.setName('user').setDescription('Filter to this member').setRequired(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('clearwarns')
      .setDescription("Clear a member's active warnings.")
      .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('id')
          .setDescription('Clear only this warning id (optional — clears all if omitted)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('timeout')
      .setDescription('Time out a member (up to 28 days).')
      .addUserOption((o) => o.setName('user').setDescription('The member to time out').setRequired(true))
      .addStringOption((o) =>
        o.setName('duration').setDescription('e.g. 10m, 2h, 1d, 1h30m').setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('reason').setDescription('Reason (optional)').setRequired(false).setMaxLength(1000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('untimeout')
      .setDescription("Remove a member's timeout.")
      .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
      .addStringOption((o) =>
        o.setName('reason').setDescription('Reason (optional)').setRequired(false).setMaxLength(1000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('kick')
      .setDescription('Kick a member from the server.')
      .addUserOption((o) => o.setName('user').setDescription('The member to kick').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('reason')
          .setDescription('Reason (optional unless required by settings)')
          .setRequired(false)
          .setMaxLength(1000),
      )
      .addStringOption((o) =>
        o.setName('evidence').setDescription('Evidence links, comma-separated (optional)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('ban')
      .setDescription('Ban a user from the server.')
      .addUserOption((o) => o.setName('user').setDescription('The user to ban').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('reason')
          .setDescription('Reason (optional unless required by settings)')
          .setRequired(false)
          .setMaxLength(1000),
      )
      .addIntegerOption((o) =>
        o
          .setName('delete-days')
          .setDescription('Delete this many days of their recent messages (0-7)')
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(7),
      )
      .addStringOption((o) =>
        o
          .setName('duration')
          .setDescription('Temporary ban duration, e.g. 7d, 30d (optional — omit for permanent)')
          .setRequired(false),
      )
      .addStringOption((o) =>
        o.setName('evidence').setDescription('Evidence links, comma-separated (optional)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unban')
      .setDescription('Unban a user by id.')
      .addStringOption((o) => o.setName('user-id').setDescription("The user's Discord id").setRequired(true))
      .addStringOption((o) =>
        o.setName('reason').setDescription('Reason (optional)').setRequired(false).setMaxLength(1000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('softban')
      .setDescription(
        'Ban and immediately unban a user — clears their recent messages without a lasting ban.',
      )
      .addUserOption((o) => o.setName('user').setDescription('The user to softban').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('reason')
          .setDescription('Reason (optional unless required by settings)')
          .setRequired(false)
          .setMaxLength(1000),
      )
      .addIntegerOption((o) =>
        o
          .setName('delete-days')
          .setDescription('Delete this many days of their recent messages (0-7, default 1)')
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(7),
      )
      .addStringOption((o) =>
        o.setName('evidence').setDescription('Evidence links, comma-separated (optional)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('purge')
      .setDescription('Bulk-delete recent messages in this channel.')
      .addIntegerOption((o) =>
        o
          .setName('count')
          .setDescription('How many messages (1-100)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100),
      )
      .addUserOption((o) =>
        o.setName('user').setDescription('Only delete messages from this user (optional)').setRequired(false),
      )
      .addStringOption((o) =>
        o
          .setName('contains')
          .setDescription('Only delete messages containing this text (requires message content access)')
          .setRequired(false),
      )
      .addStringOption((o) =>
        o.setName('reason').setDescription('Reason (optional)').setRequired(false).setMaxLength(1000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('lock')
      .setDescription('Lock a channel (prevent @everyone from sending messages).')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Channel to lock (defaults to this channel)').setRequired(false),
      )
      .addStringOption((o) =>
        o.setName('reason').setDescription('Reason (optional)').setRequired(false).setMaxLength(1000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unlock')
      .setDescription('Unlock a previously locked channel.')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Channel to unlock (defaults to this channel)')
          .setRequired(false),
      )
      .addStringOption((o) =>
        o.setName('reason').setDescription('Reason (optional)').setRequired(false).setMaxLength(1000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('slowmode')
      .setDescription('Set (or turn off) a channel slowmode.')
      .addStringOption((o) =>
        o.setName('seconds').setDescription('Seconds between messages, or "off"').setRequired(true),
      )
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Channel (defaults to this channel)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('nick')
      .setDescription("Change a member's nickname.")
      .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('nickname')
          .setDescription('New nickname, or "reset" to clear it')
          .setRequired(true)
          .setMaxLength(32),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('note')
      .setDescription('Add a staff note about a member (visible to staff only).')
      .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
      .addStringOption((o) =>
        o.setName('text').setDescription('Note text').setRequired(true).setMaxLength(2000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('case')
      .setDescription('Show a moderation case by number.')
      .addIntegerOption((o) =>
        o.setName('number').setDescription('Case number').setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('cases')
      .setDescription('List moderation cases, optionally filtered.')
      .addUserOption((o) =>
        o.setName('user').setDescription('Filter by target user (optional)').setRequired(false),
      )
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('Filter by case type (optional)')
          .setRequired(false)
          .addChoices(...CASE_TYPES.map((t) => ({ name: caseTypeLabel(t), value: t }))),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('appeal-setup')
      .setDescription('Set the staff channel where appeals are posted (admin).')
      .addChannelOption((o) => o.setName('channel').setDescription('Appeals channel').setRequired(true)),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('role')
      .setDescription('Add or remove a single role from a member.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a role to a member.')
          .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
          .addRoleOption((o) => o.setName('role').setDescription('The role to add').setRequired(true))
          .addStringOption((o) =>
            o.setName('reason').setDescription('Reason (optional)').setRequired(false).setMaxLength(1000),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a role from a member.')
          .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
          .addRoleOption((o) => o.setName('role').setDescription('The role to remove').setRequired(true))
          .addStringOption((o) =>
            o.setName('reason').setDescription('Reason (optional)').setRequired(false).setMaxLength(1000),
          ),
      ),
  );

function requireReason(
  config: ModerationConfig,
  action: 'kick' | 'ban' | 'softban',
  reason: string | null,
  t: CommandContext['t'],
): void {
  if (config.requireReasonFor.includes(action) && (!reason || reason.trim().length === 0)) {
    throw new ValidationError(t('errors.reasonRequired', { action }));
  }
}

async function resolveTargetMember(c: CommandContext, optionName = 'user'): Promise<GuildMember> {
  const member = c.interaction.options.getMember(optionName) as GuildMember | null;
  if (member) return member;
  const user = c.interaction.options.getUser(optionName, true);
  const fetched = await fetchMemberSafe(c.interaction.guild, user.id);
  if (!fetched) {
    throw new ValidationError(c.t('errors.notAMember'));
  }
  return fetched;
}

function guardHierarchy(c: CommandContext, target: GuildMember): void {
  hierarchyGuard(
    { guild: c.interaction.guild, member: c.interaction.member as GuildMember },
    target,
    c.ctx.botOwnerIds,
    c.t,
  );
}

async function replyCase(c: CommandContext, row: ModerationCase, note?: string): Promise<void> {
  await c.interaction.reply({ content: note, embeds: [buildCaseLogEmbed(row)], ephemeral: true });
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function handleWarn(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const target = await resolveTargetMember(c);
  guardHierarchy(c, target);
  const reason = c.interaction.options.getString('reason') ?? undefined;
  const evidence = parseEvidenceUrls(c.interaction.options.getString('evidence'));
  if (!evidence.ok) throw new ValidationError(evidence.error);

  const service = moderationService(c.ctx);
  const row = await service.warn({
    guildId: c.guildId,
    targetId: target.id,
    moderatorId: c.interaction.user.id,
    reason,
    source: 'BOT',
  });
  await replyCase(c, row);
}

async function handleWarnings(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'helper', c.t);
  const user = c.interaction.options.getUser('user');
  const service = moderationService(c.ctx);
  const rows = await service.listWarnings(
    user ? { guildId: c.guildId, userId: user.id } : { guildId: c.guildId, activeOnly: true },
  );
  const lines = rows.map(
    (w) =>
      `${w.active ? '🟡' : '⚪'} \`${w.id}\` <@${w.userId}> — ${w.reason ? w.reason : '_No reason_'} (${w.active ? 'active' : 'cleared'})`,
  );
  await c.interaction.reply({
    embeds: [listEmbed(user ? `Warnings — <@${user.id}>` : 'Active warnings', lines)],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function handleClearwarns(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const user = c.interaction.options.getUser('user', true);
  const warningId = c.interaction.options.getString('id') ?? undefined;
  const service = moderationService(c.ctx);
  const count = await service.clearWarnings(c.guildId, user.id, c.interaction.user.id, warningId);
  await c.interaction.reply({
    embeds: [successEmbed(c.t('clearwarns.success', { count }))],
    ephemeral: true,
  });
}

async function handleTimeout(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const target = await resolveTargetMember(c);
  guardHierarchy(c, target);
  assertBotPermissions(c.interaction.guild, [PermissionFlagsBits.ModerateMembers], c.t);

  const durationInput = c.interaction.options.getString('duration', true);
  const parsed = parseTimeoutDuration(durationInput);
  if (!parsed.ok) throw new ValidationError(parsed.error);
  const reason = c.interaction.options.getString('reason') ?? undefined;

  const service = moderationService(c.ctx);
  const row = await service.timeout({
    guildId: c.guildId,
    targetId: target.id,
    moderatorId: c.interaction.user.id,
    durationMs: parsed.ms,
    reason,
    source: 'BOT',
  });
  await replyCase(c, row);
}

async function handleUntimeout(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const target = await resolveTargetMember(c);
  guardHierarchy(c, target);
  assertBotPermissions(c.interaction.guild, [PermissionFlagsBits.ModerateMembers], c.t);
  const reason = c.interaction.options.getString('reason') ?? undefined;

  const service = moderationService(c.ctx);
  const row = await service.untimeout({
    guildId: c.guildId,
    targetId: target.id,
    moderatorId: c.interaction.user.id,
    reason,
    source: 'BOT',
  });
  await replyCase(c, row);
}

async function handleKick(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const target = await resolveTargetMember(c);
  guardHierarchy(c, target);
  assertBotPermissions(c.interaction.guild, [PermissionFlagsBits.KickMembers], c.t);

  const reason = c.interaction.options.getString('reason') ?? null;
  const config = await c.config<ModerationConfig>();
  requireReason(config, 'kick', reason, c.t);
  const evidence = parseEvidenceUrls(c.interaction.options.getString('evidence'));
  if (!evidence.ok) throw new ValidationError(evidence.error);

  const payload = { targetId: target.id, reason: reason ?? undefined, evidenceUrls: evidence.urls };
  const confirmed = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'moderation',
    action: 'kick',
    ownerId: c.interaction.user.id,
    embed: infoEmbed(c.t('confirm.title'), c.t('confirm.kick', { user: `<@${target.id}>` })),
    payload,
    fastActions: await getFastActions(c.ctx, c.guildId),
  });
  if (!confirmed.confirmed) return;

  const service = moderationService(c.ctx);
  const row = await service.kick({
    guildId: c.guildId,
    moderatorId: c.interaction.user.id,
    source: 'BOT',
    ...payload,
  });
  await replyCase(c, row);
}

async function handleBan(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const target = c.interaction.options.getUser('user', true);
  const targetMember = await fetchMemberSafe(c.interaction.guild, target.id);
  if (targetMember) guardHierarchy(c, targetMember);
  assertBotPermissions(c.interaction.guild, [PermissionFlagsBits.BanMembers], c.t);

  const reason = c.interaction.options.getString('reason') ?? null;
  const config = await c.config<ModerationConfig>();
  requireReason(config, 'ban', reason, c.t);
  const evidence = parseEvidenceUrls(c.interaction.options.getString('evidence'));
  if (!evidence.ok) throw new ValidationError(evidence.error);
  const deleteDays = c.interaction.options.getInteger('delete-days') ?? 0;
  const durationInput = c.interaction.options.getString('duration');

  let durationMs: number | undefined;
  if (durationInput) {
    if (!config.tempBanEnabled) {
      throw new ValidationError(c.t('errors.tempBanDisabled'));
    }
    const parsed = parseTempBanDuration(durationInput);
    if (!parsed.ok) throw new ValidationError(parsed.error);
    durationMs = parsed.ms;
  }

  const payload = {
    targetId: target.id,
    reason: reason ?? undefined,
    evidenceUrls: evidence.urls,
    deleteMessageSeconds: deleteDays * 86400,
    durationMs,
  };
  const confirmed = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'moderation',
    action: 'ban',
    ownerId: c.interaction.user.id,
    embed: infoEmbed(c.t('confirm.title'), c.t('confirm.ban', { user: `<@${target.id}>` })),
    payload,
    fastActions: await getFastActions(c.ctx, c.guildId),
  });
  if (!confirmed.confirmed) return;

  const service = moderationService(c.ctx);
  const row = await service.ban({
    guildId: c.guildId,
    moderatorId: c.interaction.user.id,
    source: 'BOT',
    ...payload,
  });
  await replyCase(c, row);
}

async function handleUnban(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const userId = c.interaction.options.getString('user-id', true);
  if (!isSnowflake(userId)) throw new ValidationError(c.t('errors.invalidUserId'));
  assertBotPermissions(c.interaction.guild, [PermissionFlagsBits.BanMembers], c.t);
  const reason = c.interaction.options.getString('reason') ?? undefined;

  const service = moderationService(c.ctx);
  const row = await service.unban({
    guildId: c.guildId,
    targetId: userId,
    moderatorId: c.interaction.user.id,
    reason,
    source: 'BOT',
  });
  await replyCase(c, row);
}

async function handleSoftban(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const target = c.interaction.options.getUser('user', true);
  const targetMember = await fetchMemberSafe(c.interaction.guild, target.id);
  if (targetMember) guardHierarchy(c, targetMember);
  assertBotPermissions(c.interaction.guild, [PermissionFlagsBits.BanMembers], c.t);

  const reason = c.interaction.options.getString('reason') ?? null;
  const config = await c.config<ModerationConfig>();
  requireReason(config, 'softban', reason, c.t);
  const evidence = parseEvidenceUrls(c.interaction.options.getString('evidence'));
  if (!evidence.ok) throw new ValidationError(evidence.error);
  const deleteDays = c.interaction.options.getInteger('delete-days') ?? 1;

  const payload = {
    targetId: target.id,
    reason: reason ?? undefined,
    evidenceUrls: evidence.urls,
    deleteMessageSeconds: deleteDays * 86400,
  };
  const confirmed = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'moderation',
    action: 'softban',
    ownerId: c.interaction.user.id,
    embed: infoEmbed(c.t('confirm.title'), c.t('confirm.softban', { user: `<@${target.id}>` })),
    payload,
    fastActions: await getFastActions(c.ctx, c.guildId),
  });
  if (!confirmed.confirmed) return;

  const service = moderationService(c.ctx);
  const row = await service.softban({
    guildId: c.guildId,
    moderatorId: c.interaction.user.id,
    source: 'BOT',
    ...payload,
  });
  await replyCase(c, row);
}

async function handlePurge(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  assertBotPermissions(
    c.interaction.channel ?? c.interaction.guild,
    [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory],
    c.t,
  );

  const config = await c.config<ModerationConfig>();
  const requestedCount = c.interaction.options.getInteger('count', true);
  const validated = validatePurgeCount(requestedCount, config.purgeMax);
  if (!validated.ok) throw new ValidationError(validated.error);

  const user = c.interaction.options.getUser('user');
  const contains = c.interaction.options.getString('contains') ?? undefined;
  if (contains && !c.ctx.intentsEnabled.messageContent) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('errors.messageContentDisabled'))],
      ephemeral: true,
    });
    return;
  }
  const reason = c.interaction.options.getString('reason') ?? undefined;
  const channelId = c.interaction.channelId;

  const payload = { channelId, count: validated.count, userId: user?.id, contains, reason };
  const confirmed = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'moderation',
    action: 'purge',
    ownerId: c.interaction.user.id,
    embed: infoEmbed(c.t('confirm.title'), c.t('confirm.purge', { count: validated.count })),
    payload,
    fastActions: await getFastActions(c.ctx, c.guildId),
  });
  // A confirmation prompt was sent (it is the interaction's reply) and the purge itself runs later, in the
  // `confirm-purge` component handler.
  if (!confirmed.confirmed) return;

  // Only `fastActions` gets here, and it short-circuited `requestConfirmation` without replying — so this path
  // owns the acknowledgement. Defer first: the fetch + bulkDelete + case write can outrun Discord's 3s window,
  // and `followUp` on an unacknowledged interaction throws (the messages would be gone with only an error shown).
  await c.interaction.deferReply({ ephemeral: true });

  const service = moderationService(c.ctx);
  const result = await service.purge({
    guildId: c.guildId,
    moderatorId: c.interaction.user.id,
    source: 'BOT',
    ...payload,
  });
  await c.interaction.editReply({
    embeds: [successEmbed(c.t('purge.success', { count: result.deletedCount }))],
  });
}

async function handleLock(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const channel = c.interaction.options.getChannel('channel') ?? c.interaction.channel;
  if (!channel) throw new ValidationError(c.t('errors.noChannel'));
  assertBotPermissions(
    c.interaction.guild.channels.resolve(channel.id) ?? c.interaction.guild,
    [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    c.t,
  );
  const reason = c.interaction.options.getString('reason') ?? undefined;

  const service = moderationService(c.ctx);
  const row = await service.lock({
    guildId: c.guildId,
    channelId: channel.id,
    moderatorId: c.interaction.user.id,
    reason,
    source: 'BOT',
  });
  await replyCase(c, row);
}

async function handleUnlock(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const channel = c.interaction.options.getChannel('channel') ?? c.interaction.channel;
  if (!channel) throw new ValidationError(c.t('errors.noChannel'));
  assertBotPermissions(
    c.interaction.guild.channels.resolve(channel.id) ?? c.interaction.guild,
    [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    c.t,
  );
  const reason = c.interaction.options.getString('reason') ?? undefined;

  const service = moderationService(c.ctx);
  const row = await service.unlock({
    guildId: c.guildId,
    channelId: channel.id,
    moderatorId: c.interaction.user.id,
    reason,
    source: 'BOT',
  });
  await replyCase(c, row);
}

async function handleSlowmode(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const channel = c.interaction.options.getChannel('channel') ?? c.interaction.channel;
  if (!channel) throw new ValidationError(c.t('errors.noChannel'));
  assertBotPermissions(
    c.interaction.guild.channels.resolve(channel.id) ?? c.interaction.guild,
    [PermissionFlagsBits.ManageChannels],
    c.t,
  );

  const raw = c.interaction.options.getString('seconds', true).trim().toLowerCase();
  let seconds: number | null;
  if (raw === 'off' || raw === '0') {
    seconds = 0;
  } else {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 21600) {
      throw new ValidationError(c.t('errors.invalidSlowmode'));
    }
    seconds = parsed;
  }

  const service = moderationService(c.ctx);
  const row = await service.slowmode({
    guildId: c.guildId,
    channelId: channel.id,
    moderatorId: c.interaction.user.id,
    seconds,
    source: 'BOT',
  });
  await replyCase(c, row, c.t('slowmode.success', { seconds: String(seconds) }));
}

async function handleNick(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const target = await resolveTargetMember(c);
  guardHierarchy(c, target);
  assertBotPermissions(c.interaction.guild, [PermissionFlagsBits.ManageNicknames], c.t);

  const raw = c.interaction.options.getString('nickname', true);
  const nickname = raw.trim().toLowerCase() === 'reset' ? null : raw.trim();

  const service = moderationService(c.ctx);
  const row = await service.nick({
    guildId: c.guildId,
    targetId: target.id,
    moderatorId: c.interaction.user.id,
    nickname,
    source: 'BOT',
  });
  await replyCase(c, row);
}

async function handleNote(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'helper', c.t);
  const user = c.interaction.options.getUser('user', true);
  const text = c.interaction.options.getString('text', true);

  const service = moderationService(c.ctx);
  await service.addNote({
    guildId: c.guildId,
    userId: user.id,
    authorId: c.interaction.user.id,
    content: text,
  });
  await c.interaction.reply({ embeds: [successEmbed(c.t('note.success'))], ephemeral: true });
}

async function handleCase(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'helper', c.t);
  const number = c.interaction.options.getInteger('number', true);
  const service = moderationService(c.ctx);
  const row = await service.getCase(c.guildId, number);
  if (!row) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('errors.caseNotFound', { number }))],
      ephemeral: true,
    });
    return;
  }
  await replyCase(c, row);
}

async function handleCases(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'helper', c.t);
  const user = c.interaction.options.getUser('user');
  const type = c.interaction.options.getString('type') as ModerationCaseType | null;
  const service = moderationService(c.ctx);

  const pages: EmbedBuilder[] = [];
  let cursor: string | null = null;
  do {
    const page = await service.listCases({
      guildId: c.guildId,
      targetId: user?.id,
      type: type ?? undefined,
      cursor,
      limit: 10,
    });
    if (page.items.length === 0 && pages.length === 0) break;
    pages.push(
      listEmbed(
        'Cases',
        page.items.map(
          (row) =>
            `#${row.caseNumber} — ${caseTypeLabel(row.type)} — <@${row.targetId}> — ${row.reason ?? '_No reason_'}`,
        ),
      ),
    );
    cursor = page.nextCursor;
  } while (cursor && pages.length < 10);

  await paginatedReply({
    interaction: c.interaction,
    pages,
    ownerId: c.interaction.user.id,
    pluginId: 'moderation',
  });
}

async function handleAppealSetup(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'admin', c.t);
  const channel = c.interaction.options.getChannel('channel', true);
  await c.ctx.setConfig<ModerationConfig>(
    c.guildId,
    { appealsChannelId: channel.id },
    { id: c.interaction.user.id, source: 'bot' },
  );
  await c.interaction.reply({
    embeds: [successEmbed(c.t('appealSetup.success', { channel: `<#${channel.id}>` }))],
    ephemeral: true,
  });
}

async function handleRole(c: CommandContext, remove: boolean): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const target = await resolveTargetMember(c);
  guardHierarchy(c, target);
  const role = c.interaction.options.getRole('role', true) as Role;
  assertBotPermissions(c.interaction.guild, [PermissionFlagsBits.ManageRoles], c.t);

  const botHighest = c.interaction.guild.members.me?.roles.highest;
  if (botHighest && role.position >= botHighest.position) {
    throw new ValidationError(c.t('errors.roleTooHigh'));
  }

  const reason = c.interaction.options.getString('reason') ?? undefined;
  const elevated = isElevatedRole(role);

  const payload = { targetId: target.id, roleId: role.id, remove, reason };

  if (elevated) {
    const confirmed = await requestConfirmation({
      interaction: c.interaction,
      ctx: c.ctx,
      pluginId: 'moderation',
      action: 'role',
      ownerId: c.interaction.user.id,
      embed: infoEmbed(
        c.t('confirm.title'),
        c.t(remove ? 'confirm.roleRemove' : 'confirm.roleAdd', {
          user: `<@${target.id}>`,
          role: `<@&${role.id}>`,
        }),
      ),
      payload,
      fastActions: await getFastActions(c.ctx, c.guildId),
    });
    if (!confirmed.confirmed) return;
  }

  const service = moderationService(c.ctx);
  const row = await service.roleAction({
    guildId: c.guildId,
    moderatorId: c.interaction.user.id,
    source: 'BOT',
    ...payload,
  });
  await replyCase(c, row);
}

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'helper', guildOnly: true },
  async execute(c) {
    const group = c.interaction.options.getSubcommandGroup(false);
    const sub = c.interaction.options.getSubcommand(true);

    if (group === 'role') {
      await handleRole(c, sub === 'remove');
      return;
    }

    switch (sub) {
      case 'warn':
        return handleWarn(c);
      case 'warnings':
        return handleWarnings(c);
      case 'clearwarns':
        return handleClearwarns(c);
      case 'timeout':
        return handleTimeout(c);
      case 'untimeout':
        return handleUntimeout(c);
      case 'kick':
        return handleKick(c);
      case 'ban':
        return handleBan(c);
      case 'unban':
        return handleUnban(c);
      case 'softban':
        return handleSoftban(c);
      case 'purge':
        return handlePurge(c);
      case 'lock':
        return handleLock(c);
      case 'unlock':
        return handleUnlock(c);
      case 'slowmode':
        return handleSlowmode(c);
      case 'nick':
        return handleNick(c);
      case 'note':
        return handleNote(c);
      case 'case':
        return handleCase(c);
      case 'cases':
        return handleCases(c);
      case 'appeal-setup':
        return handleAppealSetup(c);
      default:
        await c.interaction.reply({
          embeds: [errorEmbed(c.t('errors.not_found', { thing: 'Subcommand' }))],
          ephemeral: true,
        });
    }
  },
};
