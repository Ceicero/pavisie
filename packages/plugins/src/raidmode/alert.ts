// The staff-facing raid alert: one message per incident, edited as it changes, with the one-click buttons.
// Counts only; it never names or mentions the joining members.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { RaidModeIncident } from '@pavisie/database';
import { BRAND } from '@pavisie/core';
import { buildCustomId } from '../sdk';

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const LOCKDOWN_TEXT: Record<RaidModeIncident['lockdownState'], string> = {
  NONE: 'Not locked down.',
  LOCKED: 'Locked down. Press **Restore permissions** to put back exactly what changed.',
  PARTIALLY_RESTORED:
    'Partly restored: some changes could not be put back yet. Press **Restore permissions** again to retry.',
  RESTORED: 'Restored.',
};

export function incidentEmbed(incident: RaidModeIncident): EmbedBuilder {
  const ended = incident.status === 'ENDED';
  const title = `${incident.dryRun ? '[DRY RUN] ' : ''}Raid mode: ${ended ? 'raid ended' : 'raid in progress'}`;
  const status = ended
    ? `Ended <t:${seconds(incident.endedAt ?? incident.lastJoinAt)}:R>.`
    : 'In progress. This message updates every few seconds.';
  const actions = incident.lockdownActions.length > 0 ? ` (${incident.lockdownActions.join(', ')})` : '';
  return new EmbedBuilder()
    .setColor(incident.dryRun ? BRAND.color : 0xef4444)
    .setTitle(title)
    .addFields(
      { name: 'Joins', value: String(incident.joinsTotal), inline: true },
      { name: 'Flagged', value: String(incident.joinsFlagged), inline: true },
      { name: 'Started', value: `<t:${seconds(incident.startedAt)}:R>`, inline: true },
      {
        name: 'Risk (joins since detection)',
        value: `High ${incident.riskHigh} · Medium ${incident.riskMedium} · Low ${incident.riskLow}`,
      },
      { name: 'Status', value: status },
      { name: 'Lockdown', value: `${LOCKDOWN_TEXT[incident.lockdownState]}${actions}` },
    )
    .setTimestamp(incident.startedAt);
}

/** "Lock down now" while not locked; "Restore permissions" while anything is still locked. */
export function incidentButtons(incident: RaidModeIncident): ActionRowBuilder<ButtonBuilder>[] {
  const locked = incident.lockdownState === 'LOCKED' || incident.lockdownState === 'PARTIALLY_RESTORED';
  if (locked) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildCustomId('raidmode', 'restore', incident.id))
          .setLabel('Restore permissions')
          .setStyle(ButtonStyle.Success),
      ),
    ];
  }
  if (incident.status === 'ACTIVE') {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildCustomId('raidmode', 'lockdown', incident.id))
          .setLabel('Lock down now')
          .setStyle(ButtonStyle.Danger),
      ),
    ];
  }
  return [];
}

export function reminderText(incident: RaidModeIncident): string {
  return (
    `The raid has gone quiet, but the lockdown from <t:${seconds(incident.lockdownAppliedAt ?? incident.startedAt)}:R> ` +
    'is still on. Raid mode never lifts it by itself. Press **Restore permissions** when you are ready.'
  );
}
