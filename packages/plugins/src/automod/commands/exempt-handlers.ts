import { AuditAction, NotFoundError, ValidationError } from '@pavisie/core';
import { assertStaffLevel, errorEmbed, infoEmbed, successEmbed, type CommandContext } from '../../sdk';

type ExemptKind = 'role' | 'channel' | 'user' | 'domain';

const FIELD_BY_KIND: Record<
  ExemptKind,
  'exemptRoleIds' | 'exemptChannelIds' | 'exemptUserIds' | 'trustedDomains'
> = {
  role: 'exemptRoleIds',
  channel: 'exemptChannelIds',
  user: 'exemptUserIds',
  domain: 'trustedDomains',
};

async function resolveRule(c: CommandContext) {
  const ruleId = c.interaction.options.getString('rule', true);
  const rule = await c.ctx.prisma.automodRule.findFirst({
    where: { id: ruleId, guildId: c.guildId, deletedAt: null },
  });
  if (!rule) throw new NotFoundError(c.t('automod.errors.ruleNotFound', { rule: ruleId }));
  return rule;
}

function resolveValue(c: CommandContext, kind: ExemptKind): string {
  if (kind === 'role') {
    const role = c.interaction.options.getRole('role');
    if (!role) throw new ValidationError('Provide a role for kind "role".');
    return role.id;
  }
  if (kind === 'channel') {
    const channel = c.interaction.options.getChannel('channel');
    if (!channel) throw new ValidationError('Provide a channel for kind "channel".');
    return channel.id;
  }
  if (kind === 'user') {
    const user = c.interaction.options.getUser('user');
    if (!user) throw new ValidationError('Provide a user for kind "user".');
    return user.id;
  }
  const domain = c.interaction.options.getString('domain');
  if (!domain || domain.trim().length === 0) throw new ValidationError('Provide a domain for kind "domain".');
  return domain.trim().toLowerCase();
}

export async function handleExemptAdd(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const rule = await resolveRule(c);
  const kind = c.interaction.options.getString('kind', true) as ExemptKind;
  const value = resolveValue(c, kind);
  const field = FIELD_BY_KIND[kind];

  const current = rule[field] as string[];
  if (current.includes(value)) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('automod.exempt.alreadyPresent'))],
      ephemeral: true,
    });
    return;
  }

  const updated = await c.ctx.prisma.automodRule.update({
    where: { id: rule.id },
    data: { [field]: [...current, value] },
  });

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: AuditAction.AutomodRuleUpdate,
    targetType: 'automod_rule',
    targetId: rule.id,
    before: { [field]: current },
    after: { [field]: updated[field] },
    source: 'bot',
  });

  await c.interaction.reply({
    embeds: [successEmbed(c.t('automod.exempt.added', { kind, value }))],
    ephemeral: true,
  });
}

export async function handleExemptRemove(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const rule = await resolveRule(c);
  const kind = c.interaction.options.getString('kind', true) as ExemptKind;
  const value = resolveValue(c, kind);
  const field = FIELD_BY_KIND[kind];

  const current = rule[field] as string[];
  const next = current.filter((v) => v !== value);
  if (next.length === current.length) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('automod.exempt.notPresent'))], ephemeral: true });
    return;
  }

  const updated = await c.ctx.prisma.automodRule.update({ where: { id: rule.id }, data: { [field]: next } });

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: AuditAction.AutomodRuleUpdate,
    targetType: 'automod_rule',
    targetId: rule.id,
    before: { [field]: current },
    after: { [field]: updated[field] },
    source: 'bot',
  });

  await c.interaction.reply({
    embeds: [successEmbed(c.t('automod.exempt.removed', { kind, value }))],
    ephemeral: true,
  });
}

export async function handleExemptList(c: CommandContext): Promise<void> {
  const rule = await resolveRule(c);
  const lines = [
    `Roles: ${rule.exemptRoleIds.length > 0 ? rule.exemptRoleIds.map((id) => `<@&${id}>`).join(', ') : '_none_'}`,
    `Channels: ${rule.exemptChannelIds.length > 0 ? rule.exemptChannelIds.map((id) => `<#${id}>`).join(', ') : '_none_'}`,
    `Users: ${rule.exemptUserIds.length > 0 ? rule.exemptUserIds.map((id) => `<@${id}>`).join(', ') : '_none_'}`,
    `Trusted domains: ${rule.trustedDomains.length > 0 ? rule.trustedDomains.join(', ') : '_none_'}`,
  ];
  await c.interaction.reply({
    embeds: [infoEmbed(c.t('automod.exempt.listTitle', { name: rule.name }), lines.join('\n'))],
    ephemeral: true,
  });
}
