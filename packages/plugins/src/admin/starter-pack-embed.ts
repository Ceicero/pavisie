import type { EmbedBuilder } from 'discord.js';
import { EMBED_LIMITS, truncate } from '@pavisie/core';
import type { StreamerStarterReportDto, StreamerStarterStepStatus } from '@pavisie/types';
import { brandEmbed } from '../sdk';

const STATUS_ICON: Record<StreamerStarterStepStatus, string> = {
  enabled: '✅',
  already: '☑️',
  skipped: '⚠️',
  failed: '❌',
};

/** The summary a finished run is replied with: one field per step (what happened + where to change it), then any notes. */
export function starterReportEmbed(
  report: StreamerStarterReportDto,
  t: (key: string, vars?: Record<string, string | number>) => string,
): EmbedBuilder {
  const embed = brandEmbed()
    .setTitle(t('setup.streamer.embedTitle'))
    .setDescription(t('setup.streamer.embedDescription'));

  embed.addFields(
    report.steps.map((step) => ({
      name: truncate(`${STATUS_ICON[step.status]} ${step.title}`, EMBED_LIMITS.fieldName),
      value: truncate(
        `${step.text}\n${t('setup.streamer.changeIt', { where: step.where })}`,
        EMBED_LIMITS.fieldValue,
      ),
    })),
  );

  if (report.notes.length > 0) {
    embed.addFields({
      name: t('setup.streamer.notesTitle'),
      value: truncate(report.notes.map((note) => `• ${note}`).join('\n'), EMBED_LIMITS.fieldValue),
    });
  }
  return embed;
}
