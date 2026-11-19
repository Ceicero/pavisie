import { assertStaffLevel, infoEmbed, successEmbed, type CommandContext } from '../../sdk';
import { isRuleTypeActive } from '../engine';
import type { AutomodConfig } from '../manifest';

/** `/automod status` — dry-run state, rule counts (active/inactive by intent), recent event volume. */
export async function handleStatus(c: CommandContext): Promise<void> {
  const config = await c.config<AutomodConfig>();
  const rules = await c.ctx.prisma.automodRule.findMany({ where: { guildId: c.guildId, deletedAt: null } });
  const enabledRules = rules.filter((r) => r.enabled);
  const inactiveRules = enabledRules.filter((r) => !isRuleTypeActive(r.type, c.ctx.intentsEnabled));

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [eventsLast24h, pendingReview] = await Promise.all([
    c.ctx.prisma.automodEvent.count({ where: { guildId: c.guildId, createdAt: { gte: since } } }),
    c.ctx.prisma.automodEvent.count({
      where: { guildId: c.guildId, reviewStatus: { in: ['NONE', 'PENDING'] } },
    }),
  ]);

  const lines = [
    c.t('automod.status.dryRun', {
      state: config.dryRun ? c.t('automod.status.dryRunOn') : c.t('automod.status.dryRunOff'),
    }),
    `${c.t('automod.status.rules', { total: rules.length, enabled: enabledRules.length })}${
      inactiveRules.length > 0 ? c.t('automod.status.rulesInactive', { count: inactiveRules.length }) : ''
    }`,
    c.t('automod.status.alertChannel', {
      channel: config.alertChannelId ? `<#${config.alertChannelId}>` : c.t('automod.status.notSet'),
    }),
    c.t('automod.status.quarantineRole', {
      role: config.quarantineRoleId ? `<@&${config.quarantineRoleId}>` : c.t('automod.status.notSet'),
    }),
    `${c.t('automod.status.raidLockdown', { mode: config.raidLockdown })}${
      config.raidLockdown !== 'none'
        ? c.t('automod.status.raidDuration', { minutes: config.raidLockdownMinutes })
        : ''
    }`,
    c.t('automod.status.eventsLast24h', { count: eventsLast24h }),
    c.t('automod.status.pendingReview', { count: pendingReview }),
  ];

  if (inactiveRules.length > 0) {
    lines.push(
      '',
      c.t('automod.status.inactive', { rules: inactiveRules.map((r) => `**${r.name}**`).join(', ') }),
    );
  }

  await c.interaction.reply({
    embeds: [infoEmbed(c.t('automod.status.title'), lines.join('\n'))],
    ephemeral: true,
  });
}

/** `/automod dryrun on|off` — guild-wide dry-run toggle (admin only; TASK: "dryrun <on|off> (guild-wide, admin)"). */
export async function handleDryrun(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'admin', c.t);
  const on = c.interaction.options.getString('state', true) === 'on';

  // `ctx.setConfig` (GuildConfigStore.setConfig) already writes the audit entry (before/after diff, redacted).
  const after = await c.ctx.setConfig<AutomodConfig>(
    c.guildId,
    { dryRun: on },
    { id: c.interaction.user.id, source: 'bot' },
  );

  await c.interaction.reply({
    embeds: [successEmbed(after.dryRun ? c.t('automod.dryrun.enabled') : c.t('automod.dryrun.disabled'))],
    ephemeral: true,
  });
}
