import { ChannelType, type SlashCommandBuilder } from 'discord.js';
import {
  assertStaffLevel,
  classifyDiscordFailure,
  discordErrorCode,
  discordFailureKey,
  errorEmbed,
  successEmbed,
  type CommandContext,
} from '../../sdk';
import {
  applyFlagQueueOverwrites,
  applyLedgerOverwrites,
  applyMuteRoleToChannels,
  ensureMuteRole,
  ensureTextChannel,
} from '../channels';
import { buildLedgerEmbed } from '../embeds';
import type { EnforcerConfig } from '../manifest';

export function addSetupSubcommand(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Set up (or repair) the ledger channel, flag-queue channel, and mute role.')
      .addChannelOption((opt) =>
        opt
          .setName('ledger_channel')
          .setDescription('Existing channel to use as the ledger (created as #mod-ledger if omitted).')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName('ledger_visibility')
          .setDescription('Who can read the ledger channel (default: staff only).')
          .addChoices(
            { name: 'Staff only', value: 'staff' },
            { name: 'Everyone (transparency mode)', value: 'everyone' },
          )
          .setRequired(false),
      )
      .addChannelOption((opt) =>
        opt
          .setName('flag_channel')
          .setDescription(
            'Existing channel to use as the flag queue (created as #enforcer-queue if omitted).',
          )
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      )
      .addRoleOption((opt) =>
        opt
          .setName('mute_role')
          .setDescription('Existing role to use for Mute decisions (a "Muted" role is created if omitted).')
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('capture_context')
          .setDescription('Store a short context snapshot with every flag (default: on).')
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('repair')
          .setDescription(
            'Only re-apply channel permission overwrites from the current config — no other changes.',
          )
          .setRequired(false),
      ),
  ) as SlashCommandBuilder;
}

type Translate = CommandContext['t'];

/** Shared Discord-failure sentence, or `errors.generic` for any other numeric Discord code. Never reads `err.message`. */
function discordRestReply(t: Translate, err: unknown): string | null {
  const key = discordFailureKey(err);
  if (key) return t(key);
  if (classifyDiscordFailure(err) !== null || discordErrorCode(err) !== null) return t('errors.generic');
  return null;
}

/**
 * The permission sentence inside `setup.report.muteHint` (`({count} failed — …)`). Repair uses that whole
 * sentence. The per-channel report lists failed and skipped counts, then this same guidance: Manage Roles and
 * Manage Channels are the usual cause, but Discord also rejects an overwrite that denies a permission the bot
 * does not hold itself (Speak, or any other permission the mute role denies).
 */
function mutePermissionHint(t: Translate): string {
  const wrapped = t('setup.report.muteHint', { count: 0 });
  const dash = wrapped.indexOf(' \u2014 ');
  if (dash === -1) return wrapped;
  const body = wrapped.slice(dash + ' \u2014 '.length);
  return body.endsWith(')') ? body.slice(0, -1) : body;
}

/**
 * One sentence describing a bulk mute-role apply. Channels that failed and channels the bot cannot manage at all
 * are both named: a mute that silently doesn't reach part of the server is the failure mode this command has to
 * make visible, not summarise away.
 */
function describeMuteApply(
  t: Translate,
  result: { applied: number; failed: number; skipped: number },
): string {
  const problems: string[] = [];
  if (result.failed > 0) problems.push(t('setup.report.failed', { failed: result.failed }));
  if (result.skipped > 0) problems.push(t('setup.report.skipped', { skipped: result.skipped }));
  const suffix = problems.length > 0 ? ` (${problems.join(', ')}; ${mutePermissionHint(t)})` : '';
  return `${t('setup.report.applied', { applied: result.applied })}${suffix}`;
}

export async function executeSetup(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'admin', c.t);

  const moderationEnabled = await c.ctx.isEnabled(c.guildId, 'moderation');
  if (!moderationEnabled) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('setup.moderationRequired'))], ephemeral: true });
    return;
  }

  await c.interaction.deferReply({ ephemeral: true });

  try {
    await runSetup(c);
  } catch (err) {
    const text = discordRestReply(c.t, err);
    if (!text) throw err;
    c.ctx.logger.warn(
      { code: discordErrorCode(err), guildId: c.guildId },
      'enforcer: setup hit a Discord error',
    );
    await c.interaction.editReply({ embeds: [errorEmbed(text)] });
  }
}

async function runSetup(c: CommandContext): Promise<void> {
  const guild = c.interaction.guild;
  const config = await c.config<EnforcerConfig>();
  const repairOnly = c.interaction.options.getBoolean('repair') ?? false;

  const guildConfig = await c.ctx.services.require('host').getGuildConfig(c.guildId);
  const staffRoleIds = [...guildConfig.adminRoleIds, ...guildConfig.modRoleIds, ...guildConfig.helperRoleIds];

  if (repairOnly) {
    const enforcer = c.ctx.services.get('enforcer');
    const { muteApplied, muteFailed } = enforcer
      ? await enforcer.repairChannels(c.guildId)
      : { muteApplied: 0, muteFailed: 0 };
    const muteSuffix =
      muteApplied > 0 || muteFailed > 0
        ? `${c.t('setup.repairedMuteSuffix', { count: muteApplied })}${
            muteFailed > 0 ? ` ${c.t('setup.report.muteHint', { count: muteFailed })}` : ''
          }`
        : '';
    await c.interaction.editReply({
      embeds: [successEmbed(c.t('setup.repaired', { muteSuffix }))],
    });
    return;
  }

  const ledgerChannelOpt = c.interaction.options.getChannel('ledger_channel');
  const ledgerVisibilityOpt = c.interaction.options.getString('ledger_visibility') as
    'staff' | 'everyone' | null;
  const flagChannelOpt = c.interaction.options.getChannel('flag_channel');
  const muteRoleOpt = c.interaction.options.getRole('mute_role');
  const captureContextOpt = c.interaction.options.getBoolean('capture_context');

  const ledgerChannel = await ensureTextChannel({
    guild,
    existingChannelId: ledgerChannelOpt?.id ?? config.ledgerChannelId,
    fallbackName: 'mod-ledger',
    reason: 'Enforcer setup: ledger channel',
  });
  const ledgerVisibility = ledgerVisibilityOpt ?? config.ledgerVisibility;
  await applyLedgerOverwrites(ledgerChannel, ledgerVisibility, staffRoleIds);

  const flagChannel = await ensureTextChannel({
    guild,
    existingChannelId: flagChannelOpt?.id ?? config.flagChannelId,
    fallbackName: 'enforcer-queue',
    reason: 'Enforcer setup: flag-queue channel',
  });
  await applyFlagQueueOverwrites(flagChannel, staffRoleIds);

  let muteRoleId = config.muteRoleId;
  let muteRoleReport = c.t('setup.report.unchanged');
  if (muteRoleOpt) {
    muteRoleId = muteRoleOpt.id;
    // A supplied role carries no permissions of its own — it silences people only once the deny-overwrites are
    // on the channels, exactly like the role this command creates below. Without this the setup reports success
    // and every later Mute decision is a no-op the ledger still records.
    const role = await guild.roles.fetch(muteRoleId).catch(() => null);
    muteRoleReport = role
      ? c.t('setup.report.usingRole', {
          roleId: muteRoleId,
          report: describeMuteApply(c.t, await applyMuteRoleToChannels(guild, role)),
        })
      : c.t('setup.report.roleUnreadable', { roleId: muteRoleId });
  } else if (!config.muteRoleId) {
    const role = await ensureMuteRole({ guild, existingRoleId: null, reason: 'Enforcer setup: mute role' });
    muteRoleId = role.id;
    muteRoleReport = c.t('setup.report.createdRole', {
      roleId: role.id,
      report: describeMuteApply(c.t, await applyMuteRoleToChannels(guild, role)),
    });
  }

  await c.ctx.setConfig<EnforcerConfig>(
    c.guildId,
    {
      ledgerChannelId: ledgerChannel.id,
      ledgerVisibility,
      flagChannelId: flagChannel.id,
      muteRoleId,
      captureContext: captureContextOpt ?? config.captureContext,
    },
    { id: c.interaction.user.id, source: 'bot' },
  );

  const ledgerEmbed = buildLedgerEmbed({
    recordNumber: 0,
    kind: 'NOTE',
    userId: c.interaction.user.id,
    createdAt: new Date(),
    action: 'Ledger opened',
    source: 'MANUAL',
  });
  await ledgerChannel.send({ embeds: [ledgerEmbed], allowedMentions: { parse: [] } }).catch(() => undefined);

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: 'enforcer.setup.complete',
    targetType: 'guild_config',
    targetId: c.guildId,
    after: { ledgerChannelId: ledgerChannel.id, flagChannelId: flagChannel.id, muteRoleId, ledgerVisibility },
    source: 'bot',
  });

  await c.interaction.editReply({
    embeds: [
      successEmbed(
        [
          c.t('setup.report.ledgerChannel', {
            channel: `<#${ledgerChannel.id}>`,
            visibility:
              ledgerVisibility === 'staff' ? c.t('setup.report.staffOnly') : c.t('setup.report.serverWide'),
          }),
          c.t('setup.report.flagQueueChannel', { channel: `<#${flagChannel.id}>` }),
          c.t('setup.report.muteRole', {
            role: muteRoleId ? `<@&${muteRoleId}> — ${muteRoleReport}` : c.t('setup.report.notSet'),
          }),
          (captureContextOpt ?? config.captureContext)
            ? c.t('setup.report.captureOn')
            : c.t('setup.report.captureOff'),
          '',
          c.t('setup.report.nextSteps'),
        ].join('\n'),
      ),
    ],
  });
}
