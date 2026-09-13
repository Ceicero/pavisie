import { ChannelType, type SlashCommandBuilder } from 'discord.js';
import type { EnforcerDecision } from '@pavisie/database';
import {
  assertStaffLevel,
  errorEmbed,
  infoEmbed,
  listEmbed,
  successEmbed,
  type AutocompleteContext,
  type CommandContext,
} from '../../sdk';
import { evaluate, type NormalizedMessage, type Policy } from '../engine';
import { extractInvites, extractLinks } from '../normalize';
import { getPolicyPack, POLICY_PACKS } from '../packs';
import {
  matcherSchema,
  POLICY_SEVERITIES,
  type MatcherInput,
  type MatcherType,
  type PolicySeverityValue,
} from '../schemas';

const MATCHER_TYPE_CHOICES: { name: string; value: MatcherType }[] = [
  { name: 'Keyword (word match)', value: 'keyword' },
  { name: 'Phrase (substring match)', value: 'phrase' },
  { name: 'Regex', value: 'regex' },
  { name: 'Link domain', value: 'link_domain' },
  { name: 'Discord invite link', value: 'invite' },
  { name: 'Mention count', value: 'mention_count' },
  { name: 'Attachment extension', value: 'attachment_ext' },
];

const SEVERITY_CHOICES = POLICY_SEVERITIES.map((s) => ({ name: s, value: s }));
const ACTION_CHOICES = [
  { name: 'Warn', value: 'WARN' },
  { name: 'Timeout', value: 'TIMEOUT' },
  { name: 'Mute', value: 'MUTE' },
  { name: 'Kick', value: 'KICK' },
  { name: 'Ban', value: 'BAN' },
  { name: 'Dismiss', value: 'DISMISS' },
];

export function addPolicyGroup(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addSubcommandGroup((group) =>
    group
      .setName('policy')
      .setDescription('Manage Enforcer policies.')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create a policy with one matcher (add more from the dashboard).')
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription('Short policy name shown to mods and, on action, to the user.')
              .setRequired(true)
              .setMaxLength(100),
          )
          .addStringOption((opt) =>
            opt
              .setName('description')
              .setDescription('Plain-language description.')
              .setRequired(true)
              .setMaxLength(500),
          )
          .addStringOption((opt) =>
            opt
              .setName('severity')
              .setDescription('Severity.')
              .addChoices(...SEVERITY_CHOICES)
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('matcher_type')
              .setDescription('What this policy matches.')
              .addChoices(...MATCHER_TYPE_CHOICES)
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('matcher_value')
              .setDescription(
                'Value(s) for the matcher — comma-separated for lists, or a number for mention_count.',
              )
              .setRequired(true)
              .setMaxLength(1000),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('case_sensitive')
              .setDescription('Case-sensitive match (default: off).')
              .setRequired(false),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('whole_word')
              .setDescription('Whole-word match, keyword type only (default: on).')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('suggested_action')
              .setDescription('Suggested action shown in the flag queue.')
              .addChoices(...ACTION_CHOICES)
              .setRequired(false),
          )
          .addChannelOption((opt) =>
            opt
              .setName('scope_channel')
              .setDescription(
                'Limit this policy to one channel (repeat edit to add more, or use the dashboard for multiple).',
              )
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(false),
          )
          .addRoleOption((opt) =>
            opt.setName('exempt_role').setDescription('A role exempt from this policy.').setRequired(false),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List every policy.'))
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('View a policy in detail.')
          .addStringOption((opt) =>
            opt.setName('policy').setDescription('Policy').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('edit')
          .setDescription('Edit a policy.')
          .addStringOption((opt) =>
            opt.setName('policy').setDescription('Policy').setRequired(true).setAutocomplete(true),
          )
          .addStringOption((opt) =>
            opt.setName('name').setDescription('New name.').setRequired(false).setMaxLength(100),
          )
          .addStringOption((opt) =>
            opt
              .setName('description')
              .setDescription('New description.')
              .setRequired(false)
              .setMaxLength(500),
          )
          .addStringOption((opt) =>
            opt
              .setName('severity')
              .setDescription('New severity.')
              .addChoices(...SEVERITY_CHOICES)
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('suggested_action')
              .setDescription('New suggested action.')
              .addChoices(...ACTION_CHOICES)
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('matcher_type')
              .setDescription('Replace the matcher: type.')
              .addChoices(...MATCHER_TYPE_CHOICES)
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('matcher_value')
              .setDescription('Replace the matcher: value(s).')
              .setRequired(false)
              .setMaxLength(1000),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a policy.')
          .addStringOption((opt) =>
            opt.setName('policy').setDescription('Policy').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('Enable/disable a policy.')
          .addStringOption((opt) =>
            opt.setName('policy').setDescription('Policy').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('test')
          .setDescription('Test sample text against policies without flagging anyone.')
          .addStringOption((opt) =>
            opt.setName('text').setDescription('Sample message text.').setRequired(true).setMaxLength(2000),
          )
          .addStringOption((opt) =>
            opt
              .setName('policy')
              .setDescription('Limit the test to one policy (default: all enabled policies).')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('import')
          .setDescription('Import a starter policy pack.')
          .addStringOption((opt) =>
            opt
              .setName('pack')
              .setDescription('Pack to import.')
              .addChoices(...POLICY_PACKS.map((p) => ({ name: p.name, value: p.key })))
              .setRequired(true),
          ),
      ),
  ) as SlashCommandBuilder;
}

/** `undefined` on a non-numeric `mention_count` value (e.g. a typo like "5 mentions") — the caller must treat
 * that as a validation failure, NOT silently fall back to a threshold that matches everything. Exported for
 * direct unit testing. */
export function parseMatcherValue(type: MatcherType, raw: string): string | string[] | number | undefined {
  if (type === 'mention_count') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'regex') return raw;
  if (type === 'invite') return 'discord-invite';
  const list = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return list.length > 1 ? list : (list[0] ?? '');
}

function buildMatcherFromOptions(
  c: CommandContext,
): { matcher: MatcherInput; error?: string } | { matcher: null; error: string } {
  const type = c.interaction.options.getString('matcher_type', true) as MatcherType;
  const rawValue = c.interaction.options.getString('matcher_value', true);
  const caseSensitive = c.interaction.options.getBoolean('case_sensitive') ?? false;
  const wholeWord = c.interaction.options.getBoolean('whole_word') ?? true;

  const value = parseMatcherValue(type, rawValue);
  if (value === undefined) {
    return { matcher: null, error: `"${rawValue}" is not a valid value for a ${type} matcher.` };
  }

  // Validate through the same `matcherSchema` the API/dashboard path uses (policyMatchersSchema) — a slash
  // command typo (e.g. "5 mentions" for mention_count) must be rejected here too, not silently coerced into a
  // threshold that matches every message.
  const parsed = matcherSchema.safeParse({ type, value, caseSensitive, wholeWord });
  if (!parsed.success) {
    return { matcher: null, error: parsed.error.issues[0]?.message ?? 'Invalid matcher value.' };
  }

  return { matcher: parsed.data };
}

function policySummaryLine(policy: {
  id: string;
  name: string;
  enabled: boolean;
  severity: string;
  matchers: unknown;
}): string {
  const matcherCount = Array.isArray(policy.matchers) ? policy.matchers.length : 0;
  return `${policy.enabled ? '🟢' : '⚪'} **${policy.name}** (${policy.severity}) — ${matcherCount} matcher(s) — \`${policy.id}\``;
}

function policyDetailEmbed(policy: {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  severity: string;
  matchers: MatcherInput[];
  channelIds: string[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  suggestedAction: string | null;
}) {
  const lines = [
    policy.description,
    '',
    `Enabled: ${policy.enabled ? 'Yes' : 'No'}`,
    `Severity: ${policy.severity}`,
    `Suggested action: ${policy.suggestedAction ?? '_None_'}`,
    `Scope: ${policy.channelIds.length > 0 ? policy.channelIds.map((id) => `<#${id}>`).join(', ') : 'All channels'}`,
    `Exempt roles: ${policy.exemptRoleIds.length > 0 ? policy.exemptRoleIds.map((id) => `<@&${id}>`).join(', ') : '_None_'}`,
    `Exempt channels: ${policy.exemptChannelIds.length > 0 ? policy.exemptChannelIds.map((id) => `<#${id}>`).join(', ') : '_None_'}`,
    '',
    '**Matchers**',
    ...policy.matchers.map(
      (m) => `• ${m.type}: ${Array.isArray(m.value) ? m.value.join(', ') : String(m.value)}`,
    ),
  ];
  return infoEmbed(`Policy: ${policy.name}`, lines.join('\n'));
}

async function findPolicyOrReply(c: CommandContext, policyId: string) {
  const policy = await c.ctx.prisma.enforcerPolicy.findFirst({
    where: { id: policyId, guildId: c.guildId, deletedAt: null },
  });
  if (!policy) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('policy.notFound'))], ephemeral: true });
    return null;
  }
  return policy;
}

export async function executePolicy(c: CommandContext, sub: string): Promise<void> {
  if (sub === 'test') {
    assertStaffLevel(c.staffLevel, 'helper', c.t);
  } else {
    assertStaffLevel(c.staffLevel, 'admin', c.t);
  }

  if (sub === 'create') {
    const built = buildMatcherFromOptions(c);
    if (!built.matcher) {
      await c.interaction.reply({ embeds: [errorEmbed(built.error)], ephemeral: true });
      return;
    }

    const name = c.interaction.options.getString('name', true);
    const scopeChannel = c.interaction.options.getChannel('scope_channel');
    const exemptRole = c.interaction.options.getRole('exempt_role');

    const created = await c.ctx.prisma.enforcerPolicy.create({
      data: {
        guildId: c.guildId,
        name,
        description: c.interaction.options.getString('description', true),
        severity: c.interaction.options.getString('severity', true) as PolicySeverityValue,
        matchers: [built.matcher],
        channelIds: scopeChannel ? [scopeChannel.id] : [],
        exemptRoleIds: exemptRole ? [exemptRole.id] : [],
        exemptChannelIds: [],
        suggestedAction:
          (c.interaction.options.getString('suggested_action') as EnforcerDecision | null) ?? null,
        createdBy: c.interaction.user.id,
      },
    });

    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: 'enforcer.policy.create',
      targetType: 'enforcer_policy',
      targetId: created.id,
      after: { name: created.name, severity: created.severity },
      source: 'bot',
    });

    await c.interaction.reply({
      embeds: [successEmbed(c.t('policy.created', { name: created.name }))],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'import') {
    const key = c.interaction.options.getString('pack', true);
    const pack = getPolicyPack(key);
    if (!pack) {
      await c.interaction.reply({
        embeds: [errorEmbed(c.t('policy.unknownPack', { key }))],
        ephemeral: true,
      });
      return;
    }
    const created = await c.ctx.prisma.enforcerPolicy.create({
      data: {
        guildId: c.guildId,
        name: pack.name,
        description: pack.description,
        severity: pack.severity,
        matchers: pack.matchers,
        channelIds: [],
        exemptRoleIds: [],
        exemptChannelIds: [],
        suggestedAction: pack.suggestedAction.toUpperCase() as EnforcerDecision,
        createdBy: c.interaction.user.id,
      },
    });
    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: 'enforcer.policy.import',
      targetType: 'enforcer_policy',
      targetId: created.id,
      after: { pack: pack.key },
      source: 'bot',
    });
    await c.interaction.reply({
      embeds: [successEmbed(c.t('policy.imported', { name: created.name }))],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'list') {
    const policies = await c.ctx.prisma.enforcerPolicy.findMany({
      where: { guildId: c.guildId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    await c.interaction.reply({
      embeds: [listEmbed(c.t('policy.listTitle'), policies.map(policySummaryLine))],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'view') {
    const policy = await findPolicyOrReply(c, c.interaction.options.getString('policy', true));
    if (!policy) return;
    await c.interaction.reply({
      embeds: [policyDetailEmbed({ ...policy, matchers: policy.matchers as MatcherInput[] })],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'delete') {
    const policy = await findPolicyOrReply(c, c.interaction.options.getString('policy', true));
    if (!policy) return;
    await c.ctx.prisma.enforcerPolicy.update({ where: { id: policy.id }, data: { deletedAt: new Date() } });
    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: 'enforcer.policy.delete',
      targetType: 'enforcer_policy',
      targetId: policy.id,
      source: 'bot',
    });
    await c.interaction.reply({
      embeds: [successEmbed(c.t('policy.deleted', { name: policy.name }))],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'toggle') {
    const policy = await findPolicyOrReply(c, c.interaction.options.getString('policy', true));
    if (!policy) return;
    const updated = await c.ctx.prisma.enforcerPolicy.update({
      where: { id: policy.id },
      data: { enabled: !policy.enabled, updatedBy: c.interaction.user.id },
    });
    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: 'enforcer.policy.toggle',
      targetType: 'enforcer_policy',
      targetId: policy.id,
      after: { enabled: updated.enabled },
      source: 'bot',
    });
    await c.interaction.reply({
      embeds: [
        successEmbed(
          c.t('policy.toggled', { name: updated.name, state: updated.enabled ? 'enabled' : 'disabled' }),
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'edit') {
    const policy = await findPolicyOrReply(c, c.interaction.options.getString('policy', true));
    if (!policy) return;

    const name = c.interaction.options.getString('name');
    const description = c.interaction.options.getString('description');
    const severity = c.interaction.options.getString('severity') as PolicySeverityValue | null;
    const suggestedAction = c.interaction.options.getString('suggested_action');
    const matcherType = c.interaction.options.getString('matcher_type') as MatcherType | null;
    const matcherValueRaw = c.interaction.options.getString('matcher_value');

    let matchers: MatcherInput[] | undefined;
    if (matcherType && matcherValueRaw) {
      const value = parseMatcherValue(matcherType, matcherValueRaw);
      if (value === undefined) {
        await c.interaction.reply({
          embeds: [errorEmbed(`"${matcherValueRaw}" is not a valid value for a ${matcherType} matcher.`)],
          ephemeral: true,
        });
        return;
      }
      const parsed = matcherSchema.safeParse({ type: matcherType, value });
      if (!parsed.success) {
        await c.interaction.reply({
          embeds: [errorEmbed(parsed.error.issues[0]?.message ?? 'Invalid matcher value.')],
          ephemeral: true,
        });
        return;
      }
      matchers = [parsed.data];
    }

    const updated = await c.ctx.prisma.enforcerPolicy.update({
      where: { id: policy.id },
      data: {
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(severity ? { severity } : {}),
        ...(suggestedAction ? { suggestedAction: suggestedAction as EnforcerDecision } : {}),
        ...(matchers ? { matchers } : {}),
        updatedBy: c.interaction.user.id,
      },
    });

    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: 'enforcer.policy.update',
      targetType: 'enforcer_policy',
      targetId: policy.id,
      before: { name: policy.name },
      after: { name: updated.name },
      source: 'bot',
    });
    await c.interaction.reply({
      embeds: [successEmbed(c.t('policy.updated', { name: updated.name }))],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'test') {
    const text = c.interaction.options.getString('text', true);
    const policyId = c.interaction.options.getString('policy');

    const rows = policyId
      ? await c.ctx.prisma.enforcerPolicy.findMany({
          where: { id: policyId, guildId: c.guildId, deletedAt: null },
        })
      : await c.ctx.prisma.enforcerPolicy.findMany({
          where: { guildId: c.guildId, deletedAt: null, enabled: true },
        });

    const policies: Policy[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      severity: row.severity as PolicySeverityValue,
      matchers: row.matchers as MatcherInput[],
      channelIds: row.channelIds,
      exemptRoleIds: row.exemptRoleIds,
      exemptChannelIds: row.exemptChannelIds,
    }));

    const message: NormalizedMessage = {
      content: text,
      authorId: c.interaction.user.id,
      authorRoleIds: [],
      channelId: c.interaction.channelId,
      mentionsCount: 0,
      attachments: [],
      links: extractLinks(text),
      invites: extractInvites(text),
      isStaff: false,
    };

    const matches = evaluate(message, policies);
    if (matches.length === 0) {
      await c.interaction.reply({
        embeds: [infoEmbed('No matches', 'This text did not match any of the tested policies.')],
        ephemeral: true,
      });
      return;
    }

    await c.interaction.reply({
      embeds: [
        listEmbed(
          'Test matches',
          matches.map((m) => `**${m.policyName}** (${m.severity}) — ${m.matcherSummary}`),
        ),
      ],
      ephemeral: true,
    });
  }
}

export async function autocompletePolicy(c: AutocompleteContext): Promise<void> {
  const focused = c.interaction.options.getFocused(true);
  if (focused.name !== 'policy') {
    await c.interaction.respond([]);
    return;
  }
  const query = String(focused.value).toLowerCase();
  const policies = await c.ctx.prisma.enforcerPolicy.findMany({
    where: { guildId: c.guildId, deletedAt: null },
    take: 25,
  });
  const filtered = policies.filter((p) => p.name.toLowerCase().includes(query)).slice(0, 25);
  await c.interaction.respond(filtered.map((p) => ({ name: p.name, value: p.id })));
}
