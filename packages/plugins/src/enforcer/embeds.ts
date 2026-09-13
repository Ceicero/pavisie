import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, userMention } from 'discord.js';
import { BRAND, EMBED_LIMITS, discordTimestamp, truncate } from '@pavisie/core';
import { buildCustomId } from '../sdk';
import type { EnforcerDecisionLower } from './schemas';

const DECIDE_LABEL: Record<EnforcerDecisionLower, string> = {
  warn: 'Warn',
  timeout: 'Timeout',
  mute: 'Mute',
  kick: 'Kick',
  ban: 'Ban',
  dismiss: 'Dismiss',
};

const DECIDE_STYLE: Record<EnforcerDecisionLower, ButtonStyle> = {
  warn: ButtonStyle.Secondary,
  timeout: ButtonStyle.Secondary,
  mute: ButtonStyle.Secondary,
  kick: ButtonStyle.Danger,
  ban: ButtonStyle.Danger,
  dismiss: ButtonStyle.Success,
};

// Discord order: destructive actions rightmost-ish, Dismiss last on its own visual weight.
const DECIDE_ORDER: EnforcerDecisionLower[] = ['warn', 'timeout', 'mute', 'kick', 'ban', 'dismiss'];

export interface LedgerEmbedInput {
  recordNumber: number;
  kind: 'FLAG' | 'DECISION' | 'APPEAL_OPENED' | 'APPEAL_DECIDED' | 'NOTE';
  userId: string;
  createdAt: Date;
  action?: string;
  decidedBy?: string | null;
  policyName?: string | null;
  caseNumber?: number | null;
  excerpt?: string | null;
  messageJumpUrl?: string | null;
  source: string;
}

const LEDGER_TITLE: Record<LedgerEmbedInput['kind'], string> = {
  FLAG: 'Flag opened',
  DECISION: 'Decision recorded',
  APPEAL_OPENED: 'Appeal opened',
  APPEAL_DECIDED: 'Appeal decided',
  NOTE: 'Note',
};

/**
 * Builds one ledger channel entry (ARCHITECTURE.md §19's exact field list). Callers MUST send this with
 * `allowedMentions: { parse: [] }` — ledger posts never ping (the mentions here are plain, non-pinging
 * `<@id>` text rendered by Discord as a name, not a notification, once `parse` is empty).
 */
export function buildLedgerEmbed(input: LedgerEmbedInput): EmbedBuilder {
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Record', value: `#E-${input.recordNumber}`, inline: true },
    { name: 'User', value: `${userMention(input.userId)} (\`${input.userId}\`)`, inline: true },
    { name: 'When', value: discordTimestamp(input.createdAt, 'F'), inline: true },
  ];

  if (input.action)
    fields.push({ name: 'Action', value: truncate(input.action, EMBED_LIMITS.fieldValue), inline: true });
  if (input.decidedBy) fields.push({ name: 'Decided by', value: userMention(input.decidedBy), inline: true });
  if (input.policyName)
    fields.push({ name: 'Policy', value: truncate(input.policyName, EMBED_LIMITS.fieldValue), inline: true });
  if (input.caseNumber !== undefined && input.caseNumber !== null)
    fields.push({ name: 'Case #', value: `#${input.caseNumber}`, inline: true });

  const contextLines: string[] = [];
  if (input.excerpt) contextLines.push(input.excerpt);
  if (input.messageJumpUrl) contextLines.push(`[Jump to message](${input.messageJumpUrl})`);
  if (contextLines.length > 0) {
    fields.push({
      name: 'Context',
      value: truncate(contextLines.join('\n'), EMBED_LIMITS.fieldValue),
      inline: false,
    });
  }

  return new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle(LEDGER_TITLE[input.kind])
    .addFields(fields.slice(0, EMBED_LIMITS.fields))
    .setFooter({ text: `Source: ${input.source}` })
    .setTimestamp(input.createdAt);
}

export interface FlagQueueEmbedInput {
  recordId: string;
  recordNumber: number;
  userId: string;
  createdAt: Date;
  severity: string;
  policyName?: string | null;
  matcherSummary?: string | null;
  suggestedAction?: string | null;
  excerpt?: string | null;
  messageJumpUrl?: string | null;
  source: string;
  riskScore?: number | null;
  aiExplanation?: string | null;
  /** Set once decided; renders a "Decided by X at t" footer instead of the plain source footer. */
  decidedBy?: string | null;
  decidedAt?: Date | null;
}

/** Builds the flag-queue channel embed a moderator reviews and decides on (ARCHITECTURE.md §19). */
export function buildFlagQueueEmbed(input: FlagQueueEmbedInput): EmbedBuilder {
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Record', value: `#E-${input.recordNumber}`, inline: true },
    { name: 'User', value: `${userMention(input.userId)} (\`${input.userId}\`)`, inline: true },
    { name: 'Severity', value: input.severity, inline: true },
  ];
  if (input.policyName)
    fields.push({ name: 'Policy', value: truncate(input.policyName, EMBED_LIMITS.fieldValue), inline: true });
  if (input.suggestedAction)
    fields.push({ name: 'Suggested action', value: input.suggestedAction, inline: true });
  if (input.matcherSummary)
    fields.push({
      name: 'Matched',
      value: truncate(input.matcherSummary, EMBED_LIMITS.fieldValue),
      inline: false,
    });

  const contextLines: string[] = [];
  if (input.excerpt) contextLines.push(input.excerpt);
  if (input.messageJumpUrl) contextLines.push(`[Jump to message](${input.messageJumpUrl})`);
  if (contextLines.length > 0) {
    fields.push({
      name: 'Context',
      value: truncate(contextLines.join('\n'), EMBED_LIMITS.fieldValue),
      inline: false,
    });
  }

  if (input.riskScore !== undefined && input.riskScore !== null) {
    fields.push({
      name: 'AI risk score (assistive — not a decision)',
      value: `${Math.round(input.riskScore * 100)}%${input.aiExplanation ? ` — ${truncate(input.aiExplanation, 200)}` : ''}`,
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle(`Flag #E-${input.recordNumber}`)
    .addFields(fields.slice(0, EMBED_LIMITS.fields))
    .setTimestamp(input.createdAt);

  if (input.decidedBy && input.decidedAt) {
    embed.setFooter({ text: `Decided by moderator at ${input.decidedAt.toISOString()}` });
  } else {
    embed.setFooter({ text: `Source: ${input.source}` });
  }

  return embed;
}

/** Decision buttons (`enforcer:decide:<recordId>:<decision>`), one row per up-to-5 allowed decisions, plus a helper row. */
export function buildFlagQueueComponents(
  recordId: string,
  allowedDecisions: EnforcerDecisionLower[],
): ActionRowBuilder<ButtonBuilder>[] {
  const decideButtons = DECIDE_ORDER.filter((d) => allowedDecisions.includes(d)).map((decision) =>
    new ButtonBuilder()
      .setCustomId(buildCustomId('enforcer', 'decide', recordId, decision))
      .setLabel(DECIDE_LABEL[decision])
      .setStyle(DECIDE_STYLE[decision]),
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < decideButtons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(decideButtons.slice(i, i + 5)));
  }

  const helperRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('enforcer', 'context', recordId))
      .setLabel('View context')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildCustomId('enforcer', 'history', recordId))
      .setLabel('Suspect history')
      .setStyle(ButtonStyle.Secondary),
  );
  rows.push(helperRow);

  return rows.slice(0, 5);
}

/** Same layout as `buildFlagQueueComponents` but every button disabled — used once a flag has been decided. */
export function buildDecidedFlagQueueComponents(
  recordId: string,
  allowedDecisions: EnforcerDecisionLower[],
): ActionRowBuilder<ButtonBuilder>[] {
  return buildFlagQueueComponents(recordId, allowedDecisions).map((row) => {
    const disabledRow = new ActionRowBuilder<ButtonBuilder>();
    for (const component of row.components) {
      disabledRow.addComponents(ButtonBuilder.from(component).setDisabled(true));
    }
    return disabledRow;
  });
}
