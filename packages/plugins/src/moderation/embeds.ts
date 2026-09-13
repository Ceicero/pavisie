import { EmbedBuilder } from 'discord.js';
import { discordTimestamp, escapeMarkdown, sanitizeEmbedText, truncate } from '@pavisie/core';
import type { ModerationAppeal, ModerationCase } from '@pavisie/database';
import { BRAND, EMBED_LIMITS, brandIconUrl, env } from '@pavisie/core';
import { brandEmbed, userMention } from '../sdk';

const CASE_TYPE_LABEL: Record<ModerationCase['type'], string> = {
  WARN: 'Warn',
  TIMEOUT: 'Timeout',
  UNTIMEOUT: 'Timeout removed',
  KICK: 'Kick',
  BAN: 'Ban',
  UNBAN: 'Unban',
  SOFTBAN: 'Softban',
  PURGE: 'Purge',
  LOCK: 'Channel lock',
  UNLOCK: 'Channel unlock',
  SLOWMODE: 'Slowmode',
  NICK: 'Nickname change',
  ROLE_ADD: 'Role added',
  ROLE_REMOVE: 'Role removed',
  QUARANTINE: 'Quarantine',
  NOTE: 'Note',
};

const CASE_TYPE_COLOR: Partial<Record<ModerationCase['type'], number>> = {
  WARN: 0xf59e0b,
  TIMEOUT: 0xf59e0b,
  UNTIMEOUT: 0x22c55e,
  KICK: 0xef4444,
  BAN: 0xef4444,
  UNBAN: 0x22c55e,
  SOFTBAN: 0xef4444,
  // PURGE intentionally has no entry: it's neutral housekeeping, not destructive/success/warning,
  // so it falls through to the brand color below (BRAND.color) rather than an off-palette grey.
};

export function caseTypeLabel(type: ModerationCase['type']): string {
  return CASE_TYPE_LABEL[type] ?? type;
}

/** The mod-log embed posted for every `ModerationCase` (ARCHITECTURE.md §7.7/SPEC.md §B). */
export function buildCaseLogEmbed(row: ModerationCase): EmbedBuilder {
  const embed = brandEmbed()
    .setColor(CASE_TYPE_COLOR[row.type] ?? BRAND.color)
    .setTitle(`Case #${row.caseNumber} — ${caseTypeLabel(row.type)}`)
    .addFields(
      { name: 'User', value: `${userMention(row.targetId)} (\`${row.targetId}\`)`, inline: true },
      { name: 'Moderator', value: `${userMention(row.moderatorId)} (\`${row.moderatorId}\`)`, inline: true },
      {
        name: 'Reason',
        value: row.reason
          ? truncate(escapeMarkdown(row.reason), EMBED_LIMITS.fieldValue)
          : '_No reason given_',
        inline: false,
      },
    );

  if (row.durationMs) {
    const expires = row.expiresAt ? discordTimestamp(row.expiresAt, 'R') : null;
    embed.addFields({
      name: 'Duration',
      value: expires ? `Until ${expires}` : `${Math.round(row.durationMs / 1000)}s`,
      inline: true,
    });
  }

  if (row.evidenceUrls.length > 0) {
    embed.addFields({
      name: 'Evidence',
      value: truncate(
        row.evidenceUrls.map((url, i) => `[Link ${i + 1}](${url})`).join(', '),
        EMBED_LIMITS.fieldValue,
      ),
    });
  }

  embed.setFooter({ text: `${BRAND.name} · Case #${row.caseNumber}`, iconURL: brandIconUrl(env) });
  return embed;
}

/** The DM sent to the affected user, when `dmOnAction`/`dmUser` allow it. Text-only — see manifest privacyNotes. */
export function buildCaseDmEmbed(
  row: Pick<ModerationCase, 'type' | 'reason' | 'caseNumber'>,
  guildName: string,
): EmbedBuilder {
  const embed = brandEmbed()
    .setColor(CASE_TYPE_COLOR[row.type] ?? BRAND.color)
    .setTitle(`Moderation notice from ${guildName}`)
    .setDescription(
      [
        `**Action:** ${caseTypeLabel(row.type)}`,
        `**Reason:** ${row.reason ? escapeMarkdown(row.reason) : '_No reason given_'}`,
        `**Case:** #${row.caseNumber}`,
        '',
        `If you believe this was a mistake, you can appeal with \`/appeal ${row.caseNumber}\` in the server.`,
      ].join('\n'),
    );
  return embed;
}

/** Posted to the appeals/staff channel when a new appeal opens. */
export function buildAppealEmbed(appeal: ModerationAppeal, caseNumber: number | null): EmbedBuilder {
  return brandEmbed()
    .setColor(BRAND.color)
    .setTitle(`Appeal opened${caseNumber ? ` — Case #${caseNumber}` : ''}`)
    .addFields(
      { name: 'User', value: `${userMention(appeal.userId)} (\`${appeal.userId}\`)`, inline: true },
      { name: 'Submitted', value: discordTimestamp(appeal.createdAt, 'R'), inline: true },
      { name: 'Statement', value: sanitizeEmbedText(appeal.content, EMBED_LIMITS.fieldValue) },
    )
    .setFooter({ text: `Appeal ${appeal.id}` });
}

/** Sent to the appellant (and, for dashboard/async decisions, posted where a staff follow-up is needed). */
export function buildAppealDecisionEmbed(
  accepted: boolean,
  caseNumber: number | null,
  decisionNote: string | null,
): EmbedBuilder {
  const embed = brandEmbed()
    .setColor(accepted ? 0x22c55e : 0xef4444)
    .setTitle(accepted ? 'Appeal accepted' : 'Appeal denied')
    .setDescription(
      [
        caseNumber ? `Case #${caseNumber}` : undefined,
        decisionNote ? `**Staff note:** ${escapeMarkdown(decisionNote)}` : undefined,
      ]
        .filter(Boolean)
        .join('\n') || '_No additional note._',
    );
  return embed;
}
