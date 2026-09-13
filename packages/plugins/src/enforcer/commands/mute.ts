import { parseDuration } from '@pavisie/core';
import type { SlashCommandBuilder } from 'discord.js';
import { assertStaffLevel, errorEmbed, successEmbed, type CommandContext } from '../../sdk';
import { flagRecord } from '../service';
import type { EnforcerConfig } from '../manifest';

export function addMuteSubcommands(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder
    .addSubcommand((sub) =>
      sub
        .setName('mute')
        .setDescription('Mute a user with the configured mute role, through the standard decision pipeline.')
        .addUserOption((opt) => opt.setName('user').setDescription('User').setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName('duration')
            .setDescription('e.g. 30m, 2h (default: server default, or indefinite).')
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName('reason').setDescription('Reason.').setRequired(false).setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('unmute')
        .setDescription('Remove the mute role from a user.')
        .addUserOption((opt) => opt.setName('user').setDescription('User').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('reason').setDescription('Reason.').setRequired(false).setMaxLength(1000),
        ),
    ) as SlashCommandBuilder;
}

async function muteOrUnmute(c: CommandContext, decision: 'MUTE' | 'UNMUTE'): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);

  const config = await c.config<EnforcerConfig>();
  if (!config.muteRoleId) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('mute.noRole'))], ephemeral: true });
    return;
  }

  const user = c.interaction.options.getUser('user', true);
  const reason = c.interaction.options.getString('reason') ?? undefined;
  const durationRaw = c.interaction.options.getString('duration');
  const durationMs = durationRaw ? (parseDuration(durationRaw) ?? undefined) : undefined;

  await c.interaction.deferReply({ ephemeral: true });

  // Mute/unmute shortcuts are "routed through decisions" (ARCHITECTURE.md §19): open a same-turn FLAG record for
  // bookkeeping, then immediately decide it, so the ledger/case/DM/audit machinery stays identical either way.
  const flagged = await flagRecord(c.ctx, {
    guildId: c.guildId,
    userId: user.id,
    content:
      reason ?? `Manual ${decision === 'MUTE' ? 'mute' : 'unmute'} via /enforcer ${decision.toLowerCase()}`,
    source: 'MANUAL',
    flaggedBy: c.interaction.user.id,
  });

  const enforcer = c.ctx.services.require('enforcer');
  await enforcer.decide({
    guildId: c.guildId,
    recordId: flagged.recordId,
    decision,
    moderatorId: c.interaction.user.id,
    reason,
    durationMs,
    source: 'bot',
  });

  await c.interaction.editReply({
    embeds: [successEmbed(c.t(decision === 'MUTE' ? 'mute.muted' : 'mute.unmuted', { userId: user.id }))],
  });
}

export async function executeMute(c: CommandContext): Promise<void> {
  await muteOrUnmute(c, 'MUTE');
}

export async function executeUnmute(c: CommandContext): Promise<void> {
  await muteOrUnmute(c, 'UNMUTE');
}
