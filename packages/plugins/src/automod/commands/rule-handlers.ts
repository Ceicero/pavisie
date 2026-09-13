import { AuditAction, NotFoundError, ValidationError } from '@pavisie/core';
import type { Prisma } from '@pavisie/database';
import {
  PendingStore,
  assertStaffLevel,
  buildCustomId,
  errorEmbed,
  infoEmbed,
  listEmbed,
  registerConfirmHandlers,
  requestConfirmation,
  successEmbed,
  type AutocompleteContext,
  type ComponentContext,
  type ComponentHandler,
  type CommandContext,
} from '../../sdk';
import { testRuleWithText } from '../engine';
import type { AutomodConfig } from '../manifest';
import {
  AUTOMOD_RULE_TYPES,
  automodActionTypeSchema,
  automodRuleConfigSchema,
  type AutomodRuleTypeValue,
} from '../schemas';
import { ruleDetailEmbed, ruleListLine } from './format';
import { ACTION_TYPE_LABELS, RULE_TYPE_LABELS } from './rule-labels';
import { buildRuleConfigModal, readModalFieldValues } from './rule-modal';
import { parseRuleFieldValues } from './rule-fields';

const MAX_RULES_LISTED = 25;

interface CreatePendingPayload {
  type: AutomodRuleTypeValue;
  name: string;
  actionType: string;
  timeoutMinutes: number | null;
}

async function resolveRuleByOption(c: CommandContext) {
  const ruleId = c.interaction.options.getString('rule', true);
  const rule = await c.ctx.prisma.automodRule.findFirst({
    where: { id: ruleId, guildId: c.guildId, deletedAt: null },
  });
  if (!rule) throw new NotFoundError(c.t('automod.errors.ruleNotFound', { rule: ruleId }));
  return rule;
}

export async function handleRuleCreate(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const type = c.interaction.options.getString('type', true) as AutomodRuleTypeValue;
  const name = c.interaction.options.getString('name', true).trim();
  const actionType = c.interaction.options.getString('action', true);
  const timeoutMinutes = c.interaction.options.getInteger('timeout_minutes');

  if (name.length === 0 || name.length > 100) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('automod.errors.invalidName'))], ephemeral: true });
    return;
  }
  if (actionType === 'timeout' && !timeoutMinutes) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('automod.errors.timeoutMinutesRequired'))],
      ephemeral: true,
    });
    return;
  }

  const pending = new PendingStore(c.ctx.redis);
  const payload: CreatePendingPayload = { type, name, actionType, timeoutMinutes: timeoutMinutes ?? null };
  const pendingId = await pending.put(payload, 300);

  const modal = buildRuleConfigModal({
    customId: buildCustomId('automod', 'rule-create-modal', c.interaction.user.id, pendingId),
    title: `New rule: ${RULE_TYPE_LABELS[type].slice(0, 30)}`,
    type,
  });
  await c.interaction.showModal(modal);
}

export async function handleRuleCreateModalSubmit(c: ComponentContext, pendingId: string): Promise<void> {
  const pending = new PendingStore(c.ctx.redis);
  const payload = await pending.take<CreatePendingPayload>(pendingId);
  if (!payload) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('automod.errors.createExpired'))], ephemeral: true });
    return;
  }

  const rawValues = readModalFieldValues(
    payload.type,
    c.interaction as unknown as { fields: { getTextInputValue: (id: string) => string } },
  );

  let config;
  try {
    config = parseRuleFieldValues(payload.type, rawValues);
  } catch (err) {
    const message = err instanceof ValidationError ? err.message : 'Invalid configuration values.';
    await c.interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
    return;
  }

  const actions = [
    payload.actionType === 'timeout' && payload.timeoutMinutes
      ? { type: 'timeout' as const, timeoutMs: payload.timeoutMinutes * 60_000 }
      : { type: automodActionTypeSchema.parse(payload.actionType) },
  ];

  const rule = await c.ctx.prisma.automodRule.create({
    data: {
      guildId: c.guildId,
      name: payload.name,
      type: payload.type,
      enabled: true,
      // A brand-new rule has never been seen against real traffic, so it starts inert on purpose. It is cleared
      // from Discord with `/automod rule dryrun <rule> off` (handleRuleDryRun) — `automod.rule.created` names
      // that command, and both flags must be off before anything acts (see service.ts's `config.dryRun || rule.dryRun`).
      dryRun: true,
      config: config as unknown as Prisma.InputJsonValue,
      actions: actions as unknown as Prisma.InputJsonValue,
      exemptRoleIds: [],
      exemptChannelIds: [],
      exemptUserIds: [],
      trustedDomains: [],
      cooldownSeconds: 0,
      priority: 0,
      createdBy: c.interaction.user.id,
    },
  });

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: AuditAction.AutomodRuleCreate,
    targetType: 'automod_rule',
    targetId: rule.id,
    after: { name: rule.name, type: rule.type },
    source: 'bot',
  });

  await c.interaction.reply({
    embeds: [successEmbed(c.t('automod.rule.created', { name: rule.name }))],
    ephemeral: true,
  });
}

export async function handleRuleList(c: CommandContext): Promise<void> {
  const rules = await c.ctx.prisma.automodRule.findMany({
    where: { guildId: c.guildId, deletedAt: null },
    orderBy: { priority: 'asc' },
    take: MAX_RULES_LISTED,
  });

  if (rules.length === 0) {
    await c.interaction.reply({
      embeds: [infoEmbed(c.t('automod.rule.listTitle'), c.t('automod.rule.listEmpty'))],
      ephemeral: true,
    });
    return;
  }

  const lines = rules.map((r) => ruleListLine(r, c.ctx.intentsEnabled));
  await c.interaction.reply({ embeds: [listEmbed(c.t('automod.rule.listTitle'), lines)], ephemeral: true });
}

export async function handleRuleView(c: CommandContext): Promise<void> {
  const rule = await resolveRuleByOption(c);
  await c.interaction.reply({ embeds: [ruleDetailEmbed(rule, c.ctx.intentsEnabled)], ephemeral: true });
}

export async function handleRuleToggle(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const rule = await resolveRuleByOption(c);
  const updated = await c.ctx.prisma.automodRule.update({
    where: { id: rule.id },
    data: { enabled: !rule.enabled },
  });

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: AuditAction.AutomodRuleUpdate,
    targetType: 'automod_rule',
    targetId: rule.id,
    before: { enabled: rule.enabled },
    after: { enabled: updated.enabled },
    source: 'bot',
  });

  await c.interaction.reply({
    embeds: [
      successEmbed(
        c.t(updated.enabled ? 'automod.rule.enabled' : 'automod.rule.disabled', { name: updated.name }),
      ),
    ],
    ephemeral: true,
  });
}

/**
 * `/automod rule dryrun <rule> <on|off>` — the per-rule dry-run flag. Distinct from `/automod dryrun`, which is
 * the guild-wide switch: `service.ts` ORs the two, so a rule only ever acts when BOTH are off. Without this
 * command a rule created from Discord could never leave dry-run at all (only the dashboard writes the column),
 * which made every Discord-created rule permanently inert.
 */
export async function handleRuleDryRun(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const rule = await resolveRuleByOption(c);
  const dryRun = c.interaction.options.getString('state', true) === 'on';

  const updated = await c.ctx.prisma.automodRule.update({
    where: { id: rule.id },
    data: { dryRun },
  });

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: AuditAction.AutomodRuleUpdate,
    targetType: 'automod_rule',
    targetId: rule.id,
    before: { dryRun: rule.dryRun },
    after: { dryRun: updated.dryRun },
    source: 'bot',
  });

  // Turning a rule live while the guild-wide switch is still on changes nothing the moderator can observe, so
  // say so rather than reporting a success they'd then have to debug.
  const config = await c.config<AutomodConfig>();
  const guildDryRun = config.dryRun;

  await c.interaction.reply({
    embeds: [
      successEmbed(
        c.t(
          updated.dryRun
            ? 'automod.rule.dryRunOn'
            : guildDryRun
              ? 'automod.rule.dryRunOffGuildDryRun'
              : 'automod.rule.dryRunOff',
          { name: updated.name },
        ),
      ),
    ],
    ephemeral: true,
  });
}

export async function handleRuleEdit(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const rule = await resolveRuleByOption(c);

  const modal = buildRuleConfigModal({
    customId: buildCustomId('automod', 'rule-edit-modal', c.interaction.user.id, rule.id),
    title: `Edit: ${rule.name}`.slice(0, 45),
    type: rule.type as AutomodRuleTypeValue,
    prefillConfig: (rule.config as Record<string, unknown>) ?? {},
  });
  await c.interaction.showModal(modal);
}

export async function handleRuleEditModalSubmit(c: ComponentContext, ruleId: string): Promise<void> {
  const rule = await c.ctx.prisma.automodRule.findFirst({
    where: { id: ruleId, guildId: c.guildId, deletedAt: null },
  });
  if (!rule) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('automod.errors.ruleNotFound', { rule: ruleId }))],
      ephemeral: true,
    });
    return;
  }

  const rawValues = readModalFieldValues(
    rule.type as AutomodRuleTypeValue,
    c.interaction as unknown as { fields: { getTextInputValue: (id: string) => string } },
  );

  let config;
  try {
    config = parseRuleFieldValues(rule.type as AutomodRuleTypeValue, rawValues);
  } catch (err) {
    const message = err instanceof ValidationError ? err.message : 'Invalid configuration values.';
    await c.interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
    return;
  }

  const updated = await c.ctx.prisma.automodRule.update({
    where: { id: rule.id },
    data: { config: config as unknown as Prisma.InputJsonValue },
  });

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: AuditAction.AutomodRuleUpdate,
    targetType: 'automod_rule',
    targetId: rule.id,
    before: { config: rule.config },
    after: { config: updated.config },
    source: 'bot',
  });

  await c.interaction.reply({
    embeds: [successEmbed(c.t('automod.rule.updated', { name: updated.name }))],
    ephemeral: true,
  });
}

export async function handleRuleDelete(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const rule = await resolveRuleByOption(c);

  await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'automod',
    action: 'rule-delete',
    ownerId: c.interaction.user.id,
    embed: infoEmbed(
      c.t('automod.rule.deleteConfirmTitle'),
      c.t('automod.rule.deleteConfirmBody', { name: rule.name }),
    ),
    payload: { ruleId: rule.id, name: rule.name },
    fastActions: false,
  });
}

export const ruleDeleteConfirmHandlers: ComponentHandler[] = registerConfirmHandlers<{
  ruleId: string;
  name: string;
}>('rule-delete', async (c, payload) => {
  const existing = await c.ctx.prisma.automodRule.findFirst({
    where: { id: payload.ruleId, guildId: c.guildId, deletedAt: null },
  });
  if (!existing) {
    await c.interaction.followUp({
      embeds: [errorEmbed(c.t('automod.errors.ruleNotFound', { rule: payload.ruleId }))],
      ephemeral: true,
    });
    return;
  }
  await c.ctx.prisma.automodRule.update({ where: { id: payload.ruleId }, data: { deletedAt: new Date() } });
  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: AuditAction.AutomodRuleDelete,
    targetType: 'automod_rule',
    targetId: payload.ruleId,
    before: { name: payload.name },
    source: 'bot',
  });
  await c.interaction.followUp({
    embeds: [successEmbed(c.t('automod.rule.deleted', { name: payload.name }))],
    ephemeral: true,
  });
});

export async function handleRuleTest(c: CommandContext): Promise<void> {
  const rule = await resolveRuleByOption(c);
  const sampleText = c.interaction.options.getString('text', true);

  const parsed = automodRuleConfigSchema.safeParse(rule.config);
  if (!parsed.success) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('automod.errors.invalidStoredConfig'))],
      ephemeral: true,
    });
    return;
  }

  const result = await testRuleWithText(parsed.data, sampleText, {
    guildId: c.guildId,
    channelId: c.interaction.channelId ?? undefined,
    authorId: c.interaction.user.id,
  });

  const embed = result.matched
    ? errorEmbed(`**Matched.** ${result.reason ?? ''}`)
    : successEmbed(`No match.${result.reason ? ` ${result.reason}` : ''}`);
  await c.interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function ruleAutocomplete(c: AutocompleteContext): Promise<void> {
  const focused = c.interaction.options.getFocused(true);
  if (focused.name === 'rule') {
    const query = String(focused.value).toLowerCase();
    const rules = await c.ctx.prisma.automodRule.findMany({
      where: { guildId: c.guildId, deletedAt: null },
      orderBy: { priority: 'asc' },
      take: 200,
    });
    const matches = rules
      .filter((r) => r.name.toLowerCase().includes(query) || r.type.toLowerCase().includes(query))
      .slice(0, 25);
    await c.interaction.respond(matches.map((r) => ({ name: `${r.name} (${r.type})`, value: r.id })));
    return;
  }
  await c.interaction.respond([]);
}

export const RULE_TYPE_CHOICES = AUTOMOD_RULE_TYPES.map((type) => ({
  name: RULE_TYPE_LABELS[type],
  value: type,
}));
export const RULE_ACTION_CHOICES = automodActionTypeSchema.options.map((type) => ({
  name: ACTION_TYPE_LABELS[type] ?? type,
  value: type,
}));
