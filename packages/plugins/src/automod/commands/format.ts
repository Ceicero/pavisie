import type { EmbedBuilder } from 'discord.js';
import type { AutomodEvent, AutomodRule } from '@pavisie/database';
import { infoEmbed } from '../../sdk';
import { RULE_TYPE_REQUIRED_INTENTS, isRuleTypeActive, type IntentsEnabledLike } from '../engine';
import { automodActionsSchema, automodRuleConfigSchema } from '../schemas';

/** One-line status badge for a rule: enabled/disabled, dry-run, and whether it's active given the guild's current privileged intents. */
export function ruleStatusLine(rule: AutomodRule, intentsEnabled: IntentsEnabledLike): string {
  const parts: string[] = [rule.enabled ? '🟢 enabled' : '⚪ disabled'];
  if (rule.dryRun) parts.push('🧪 dry-run');
  if (!isRuleTypeActive(rule.type, intentsEnabled)) {
    parts.push(`⚠️ inactive: requires ${RULE_TYPE_REQUIRED_INTENTS[rule.type]} intent`);
  }
  return parts.join(' · ');
}

function summarizeConfig(rule: AutomodRule): string {
  const parsed = automodRuleConfigSchema.safeParse(rule.config);
  if (!parsed.success) return '_invalid stored config_';
  const { type: _type, ...rest } = parsed.data;
  const entries = Object.entries(rest).map(
    ([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length}]` : String(v)}`,
  );
  return entries.length > 0 ? entries.join(', ') : '_no fields_';
}

function summarizeActions(rule: AutomodRule): string {
  const parsed = automodActionsSchema.safeParse(rule.actions);
  if (!parsed.success) return '_invalid stored actions_';
  return parsed.data
    .map((a) =>
      a.type === 'timeout' && a.timeoutMs ? `timeout (${Math.round(a.timeoutMs / 60000)}m)` : a.type,
    )
    .join(', ');
}

/** Builds the detail embed used by `/automod rule view` and (as a list) `/automod rule list`. */
export function ruleDetailEmbed(rule: AutomodRule, intentsEnabled: IntentsEnabledLike): EmbedBuilder {
  const lines = [
    `Status: ${ruleStatusLine(rule, intentsEnabled)}`,
    `Type: **${rule.type}**`,
    `Priority: ${rule.priority} · Cooldown: ${rule.cooldownSeconds}s`,
    `Config: ${summarizeConfig(rule)}`,
    `Actions: ${summarizeActions(rule)}`,
    `Exempt roles: ${rule.exemptRoleIds.length > 0 ? rule.exemptRoleIds.map((id) => `<@&${id}>`).join(', ') : '_none_'}`,
    `Exempt channels: ${rule.exemptChannelIds.length > 0 ? rule.exemptChannelIds.map((id) => `<#${id}>`).join(', ') : '_none_'}`,
    `Exempt users: ${rule.exemptUserIds.length > 0 ? rule.exemptUserIds.map((id) => `<@${id}>`).join(', ') : '_none_'}`,
    `Trusted domains: ${rule.trustedDomains.length > 0 ? rule.trustedDomains.join(', ') : '_none_'}`,
  ];
  return infoEmbed(`Rule: ${rule.name}`, lines.join('\n'));
}

/** Short list line for `/automod rule list` (one rule per line, ordered by priority). */
export function ruleListLine(rule: AutomodRule, intentsEnabled: IntentsEnabledLike): string {
  return `**${rule.name}** (\`${rule.id.slice(0, 8)}\`) — ${rule.type} — ${ruleStatusLine(rule, intentsEnabled)}`;
}

/** Detail line for `/automod review`'s event picker and `/automod status`'s recent-events summary. */
export function eventSummaryLine(event: AutomodEvent, ruleName: string): string {
  const excerpt = event.matched
    ? ` — "${event.matched.slice(0, 60)}${event.matched.length > 60 ? '…' : ''}"`
    : '';
  return `#${event.id.slice(0, 8)} · ${ruleName} · <@${event.userId}>${event.dryRun ? ' · [dry run]' : ''}${excerpt}`;
}
