import type { EmbedBuilder } from 'discord.js';
import type { AutomodEvent, AutomodRule } from '@pavisie/database';
import { infoEmbed, type CommandContext } from '../../sdk';
import { RULE_TYPE_REQUIRED_INTENTS, isRuleTypeActive, type IntentsEnabledLike } from '../engine';
import { automodActionsSchema, automodRuleConfigSchema } from '../schemas';

type Translate = CommandContext['t'];

/** One-line status badge for a rule: enabled/disabled, dry-run, and whether it's active given the guild's current privileged intents. */
export function ruleStatusLine(rule: AutomodRule, intentsEnabled: IntentsEnabledLike, t: Translate): string {
  const parts: string[] = [rule.enabled ? t('automod.rule.line.enabled') : t('automod.rule.line.disabled')];
  if (rule.dryRun) parts.push(t('automod.rule.line.dryRun'));
  if (!isRuleTypeActive(rule.type, intentsEnabled)) {
    const intent = RULE_TYPE_REQUIRED_INTENTS[rule.type];
    if (intent) parts.push(t('automod.rule.line.inactive', { intent }));
  }
  return parts.join(' · ');
}

function summarizeConfig(rule: AutomodRule, t: Translate): string {
  const parsed = automodRuleConfigSchema.safeParse(rule.config);
  if (!parsed.success) return t('automod.rule.line.invalidStoredConfig');
  const { type: _type, ...rest } = parsed.data;
  const entries = Object.entries(rest).map(
    ([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length}]` : String(v)}`,
  );
  return entries.length > 0 ? entries.join(', ') : t('automod.rule.line.noFields');
}

function summarizeActions(rule: AutomodRule, t: Translate): string {
  const parsed = automodActionsSchema.safeParse(rule.actions);
  if (!parsed.success) return t('automod.rule.line.invalidStoredActions');
  return parsed.data
    .map((a) =>
      a.type === 'timeout' && a.timeoutMs
        ? t('automod.rule.line.timeout', { minutes: Math.round(a.timeoutMs / 60000) })
        : a.type,
    )
    .join(', ');
}

/** Builds the detail embed used by `/automod rule view` and (as a list) `/automod rule list`. */
export function ruleDetailEmbed(
  rule: AutomodRule,
  intentsEnabled: IntentsEnabledLike,
  title: string,
  t: Translate,
): EmbedBuilder {
  const none = t('automod.rule.line.none');
  const lines = [
    t('automod.rule.line.status', { status: ruleStatusLine(rule, intentsEnabled, t) }),
    t('automod.rule.line.type', { type: rule.type }),
    t('automod.rule.line.priority', { priority: rule.priority, cooldown: rule.cooldownSeconds }),
    t('automod.rule.line.config', { config: summarizeConfig(rule, t) }),
    t('automod.rule.line.actions', { actions: summarizeActions(rule, t) }),
    t('automod.rule.line.exemptRoles', {
      roles: rule.exemptRoleIds.length > 0 ? rule.exemptRoleIds.map((id) => `<@&${id}>`).join(', ') : none,
    }),
    t('automod.rule.line.exemptChannels', {
      channels:
        rule.exemptChannelIds.length > 0 ? rule.exemptChannelIds.map((id) => `<#${id}>`).join(', ') : none,
    }),
    t('automod.rule.line.exemptUsers', {
      users: rule.exemptUserIds.length > 0 ? rule.exemptUserIds.map((id) => `<@${id}>`).join(', ') : none,
    }),
    t('automod.rule.line.trustedDomains', {
      domains: rule.trustedDomains.length > 0 ? rule.trustedDomains.join(', ') : none,
    }),
  ];
  return infoEmbed(title, lines.join('\n'));
}

/** Short list line for `/automod rule list` (one rule per line, ordered by priority). */
export function ruleListLine(rule: AutomodRule, intentsEnabled: IntentsEnabledLike, t: Translate): string {
  return t('automod.rule.line.list', {
    name: rule.name,
    id: rule.id.slice(0, 8),
    type: rule.type,
    status: ruleStatusLine(rule, intentsEnabled, t),
  });
}

/** Detail line for `/automod review`'s event picker and `/automod status`'s recent-events summary. */
export function eventSummaryLine(event: AutomodEvent, ruleName: string, t: Translate): string {
  const excerpt = event.matched
    ? t('automod.review.excerpt', {
        excerpt: `${event.matched.slice(0, 60)}${event.matched.length > 60 ? '…' : ''}`,
      })
    : '';
  return t('automod.review.summary', {
    id: event.id.slice(0, 8),
    rule: ruleName,
    userId: event.userId,
    dryRun: event.dryRun ? t('automod.review.dryRunMark') : '',
    excerpt,
  });
}
