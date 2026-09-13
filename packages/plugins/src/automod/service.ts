// Rule-runner + the `automod` cross-plugin service (ARCHITECTURE.md §7.5's `AutomodService`). This is the one
// place in the plugin that touches discord.js directly for side effects; `engine/**` stays pure/testable.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildVerificationLevel,
  type Guild,
  type GuildMember,
  type Message,
  type PartialMessage,
} from 'discord.js';
import { BRAND, Cooldowns, redisKey, sanitizeEmbedText, truncate } from '@pavisie/core';
import type { AutomodEvent, AutomodRule, Prisma } from '@pavisie/database';
import { buildCustomId, resolveTextChannel, type PluginContext } from '../sdk';
import type { AutomodConfig } from './manifest';
import {
  RedisWindowStore,
  evaluateJoinRule,
  evaluateMessageRule,
  isMessageRuleType,
  isRuleTypeActive,
  isWindowBackedRuleType,
  scopedWindowStore,
} from './engine';
import type { EvaluatorResult } from './engine';
import { isExempt, isTrustedDomain } from './exemptions';
import { normalizeJoin, normalizeMessage } from './normalize';
import {
  automodActionsSchema,
  automodRuleConfigSchema,
  type AutomodAction,
  type AutomodRuleConfig,
} from './schemas';

const RAID_LOCKDOWN_KEY_PREFIX = 'automod:raidlockdown';
const MATCH_CLAIM_KEY_PREFIX = 'automod:match';
/**
 * How long one rule's claim on a message is held. Long enough to cover Discord re-delivering the same message
 * (a gateway resume, an embed unfurl, a burst of quick edits); short enough that a member who edits the same
 * message into a fresh violation much later is still flagged for it.
 */
const MATCH_CLAIM_TTL_SECONDS = 300;

export interface StaffContext {
  isStaff: boolean;
  roleIds: string[];
}

/** Resolves whether `member` is at/above `helper` staff level, using the `host` service's `GuildConfig` staff roles (best-effort — defaults to "not staff" if `host` isn't available). */
export async function getStaffContext(
  ctx: PluginContext,
  guild: Guild,
  member: GuildMember | null,
): Promise<StaffContext> {
  if (!member) return { isStaff: false, roleIds: [] };
  const roleIds = [...member.roles.cache.keys()];

  const host = ctx.services.get('host');
  if (!host) return { isStaff: false, roleIds };

  try {
    const guildConfig = await host.getGuildConfig(guild.id);
    const staffRoleIds = new Set([
      ...guildConfig.adminRoleIds,
      ...guildConfig.modRoleIds,
      ...guildConfig.helperRoleIds,
    ]);
    const isStaff =
      member.id === guild.ownerId ||
      ctx.botOwnerIds.includes(member.id) ||
      roleIds.some((id) => staffRoleIds.has(id)) ||
      member.permissions.has('Administrator') ||
      member.permissions.has('ManageGuild');
    return { isStaff, roleIds };
  } catch {
    return { isStaff: false, roleIds };
  }
}

async function fetchRules(ctx: PluginContext, guildId: string): Promise<AutomodRule[]> {
  return ctx.prisma.automodRule.findMany({
    where: { guildId, enabled: true, deletedAt: null },
    orderBy: { priority: 'asc' },
  });
}

function parseRuleConfig(rule: AutomodRule): AutomodRuleConfig | null {
  const result = automodRuleConfigSchema.safeParse(rule.config);
  return result.success ? result.data : null;
}

function parseRuleActions(rule: AutomodRule): AutomodAction[] {
  const result = automodActionsSchema.safeParse(rule.actions);
  return result.success ? result.data : [];
}

interface ActionOutcome {
  type: AutomodAction['type'];
  applied: boolean;
  detail?: string;
}

/** Assigns `config.quarantineRoleId` to `userId`. Used by the registered `automod` service AND internally for the "quarantine" per-rule action and raid-lockdown quarantine. */
async function applyQuarantine(
  ctx: PluginContext,
  guildId: string,
  userId: string,
  reason: string,
): Promise<ActionOutcome> {
  const config = await ctx.getConfig<AutomodConfig>(guildId);
  if (!config.quarantineRoleId) {
    ctx.logger.warn({ guildId, userId }, 'automod: quarantine skipped — no quarantineRoleId configured');
    return { type: 'quarantine', applied: false, detail: 'No quarantine role configured.' };
  }

  const guild =
    ctx.client.guilds.cache.get(guildId) ?? (await ctx.client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return { type: 'quarantine', applied: false, detail: 'Guild not found.' };

  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  if (!member) return { type: 'quarantine', applied: false, detail: 'Member not found (may have left).' };

  try {
    await member.roles.add(config.quarantineRoleId, reason);
    return { type: 'quarantine', applied: true };
  } catch (err) {
    ctx.logger.error(
      { guildId, userId, err: err instanceof Error ? err.message : String(err) },
      'automod: failed to assign quarantine role',
    );
    return {
      type: 'quarantine',
      applied: false,
      detail: 'Failed to assign the quarantine role (check role hierarchy/permissions).',
    };
  }
}

function alertEmbed(params: {
  rule: AutomodRule;
  userId: string;
  channelId: string | null;
  result: EvaluatorResult;
  excerpt: string | null;
  actionOutcomes: ActionOutcome[];
  dryRun: boolean;
}): EmbedBuilder {
  const { rule, userId, channelId, result, excerpt, actionOutcomes, dryRun } = params;
  const embed = new EmbedBuilder()
    // dry-run alerts are informational, not a real enforcement action, so they get the neutral brand color
    // rather than the destructive red used for an actual (non-dry-run) automod trigger.
    .setColor(dryRun ? BRAND.color : 0xef4444)
    .setTitle(`${dryRun ? '[DRY RUN] ' : ''}Automod: ${rule.name}`)
    .setDescription(result.reason ? truncate(result.reason, 2000) : 'A configured rule matched.')
    .addFields(
      { name: 'User', value: `<@${userId}>`, inline: true },
      { name: 'Rule type', value: rule.type, inline: true },
      { name: 'Channel', value: channelId ? `<#${channelId}>` : '—', inline: true },
      {
        name: 'Actions',
        value:
          actionOutcomes.length > 0
            ? actionOutcomes
                .map(
                  (a) =>
                    `${a.applied ? '✅' : dryRun ? '⏸️' : '⚠️'} ${a.type}${a.detail ? ` — ${a.detail}` : ''}`,
                )
                .join('\n')
            : '_None configured_',
      },
    )
    .setTimestamp();

  if (excerpt) {
    embed.addFields({ name: 'Matched content', value: `\`\`\`${truncate(excerpt, 900)}\`\`\`` });
  }

  return embed;
}

function reviewButtons(eventId: string, resolved = false): ActionRowBuilder<ButtonBuilder>[] {
  if (resolved) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('automod', 'review-confirm', eventId))
        .setLabel('Confirm violation')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(buildCustomId('automod', 'review-false-positive', eventId))
        .setLabel('False positive')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function postAlert(
  ctx: PluginContext,
  guild: Guild,
  config: AutomodConfig,
  params: {
    rule: AutomodRule;
    userId: string;
    channelId: string | null;
    result: EvaluatorResult;
    excerpt: string | null;
    actionOutcomes: ActionOutcome[];
    dryRun: boolean;
    eventId: string;
  },
): Promise<void> {
  if (!config.alertChannelId) {
    ctx.logger.warn(
      { guildId: guild.id, ruleId: params.rule.id },
      'automod: alert_staff action configured but no alertChannelId set',
    );
    return;
  }
  const channel = await resolveTextChannel(guild, config.alertChannelId);
  if (!channel) {
    ctx.logger.warn(
      { guildId: guild.id, channelId: config.alertChannelId },
      'automod: cannot post to configured alert channel (missing/no permission)',
    );
    return;
  }
  try {
    await channel.send({
      embeds: [alertEmbed(params)],
      components: reviewButtons(params.eventId),
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    ctx.logger.error(
      { guildId: guild.id, err: err instanceof Error ? err.message : String(err) },
      'automod: failed to post alert embed',
    );
  }
}

/** Executes one resolved action (message-rule context: a real message + optionally its member are available). */
async function executeMessageAction(
  ctx: PluginContext,
  action: AutomodAction,
  params: {
    guildId: string;
    message: Message | PartialMessage | null;
    member: GuildMember | null;
    userId: string;
    reason: string;
    config: AutomodConfig;
  },
): Promise<ActionOutcome> {
  const { guildId, message, member, userId, reason, config } = params;

  switch (action.type) {
    case 'ignore':
      return { type: 'ignore', applied: true };

    case 'delete': {
      if (!message) return { type: 'delete', applied: false, detail: 'No message to delete.' };
      try {
        await message.delete();
        return { type: 'delete', applied: true };
      } catch (err) {
        return {
          type: 'delete',
          applied: false,
          detail: err instanceof Error ? err.message : 'Could not delete the message.',
        };
      }
    }

    case 'warn': {
      const moderation = ctx.services.get('moderation');
      if (!moderation) return { type: 'warn', applied: false, detail: 'Moderation plugin unavailable.' };
      try {
        await moderation.warn({
          guildId,
          targetId: userId,
          moderatorId: ctx.client.user.id,
          reason,
          source: 'AUTOMOD',
          dmUser: true,
        });
        return { type: 'warn', applied: true };
      } catch (err) {
        return { type: 'warn', applied: false, detail: err instanceof Error ? err.message : 'Warn failed.' };
      }
    }

    case 'timeout': {
      const durationMs = action.timeoutMs ?? config.defaultTimeoutMs;
      const moderation = ctx.services.get('moderation');
      if (moderation) {
        try {
          await moderation.timeout({
            guildId,
            targetId: userId,
            moderatorId: ctx.client.user.id,
            durationMs,
            reason,
            source: 'AUTOMOD',
            dmUser: true,
          });
          return { type: 'timeout', applied: true };
        } catch (err) {
          return {
            type: 'timeout',
            applied: false,
            detail: err instanceof Error ? err.message : 'Timeout failed.',
          };
        }
      }
      if (!member)
        return {
          type: 'timeout',
          applied: false,
          detail: 'Member not available and moderation plugin unavailable.',
        };
      try {
        await member.timeout(durationMs, reason);
        return { type: 'timeout', applied: true };
      } catch (err) {
        return {
          type: 'timeout',
          applied: false,
          detail: err instanceof Error ? err.message : 'Timeout failed.',
        };
      }
    }

    case 'quarantine':
      return applyQuarantine(ctx, guildId, userId, reason);

    case 'alert_staff':
      // Handled by the caller (postAlert) so it can include every action's outcome in one embed.
      return { type: 'alert_staff', applied: true };

    default:
      return { type: action.type, applied: false, detail: 'Unknown action type.' };
  }
}

async function createEvent(
  ctx: PluginContext,
  params: {
    guildId: string;
    rule: AutomodRule;
    userId: string;
    channelId: string | null;
    messageId: string | null;
    result: EvaluatorResult;
    excerpt: string | null;
    actionOutcomes: ActionOutcome[];
    dryRun: boolean;
  },
): Promise<AutomodEvent> {
  const { guildId, rule, userId, channelId, messageId, result, excerpt, actionOutcomes, dryRun } = params;
  return ctx.prisma.automodEvent.create({
    data: {
      guildId,
      ruleId: rule.id,
      ruleType: rule.type,
      userId,
      channelId,
      messageId,
      matched: excerpt,
      actionsTaken: actionOutcomes as unknown as Prisma.InputJsonValue,
      dryRun,
      riskScore: typeof result.riskScore === 'number' ? result.riskScore : null,
      reviewStatus: 'PENDING',
    },
  });
}

async function getLogMessageContentEnabled(ctx: PluginContext, guildId: string): Promise<boolean> {
  const host = ctx.services.get('host');
  if (!host) return false;
  try {
    const guildConfig = await host.getGuildConfig(guildId);
    return guildConfig.logMessageContent;
  } catch {
    return false;
  }
}

/**
 * Claims the right to act on `messageId` for `ruleId`, returning false when something already claimed it.
 * `AutomodEvent` has no unique key on (rule, message) and nothing else de-duplicates, so without this a second
 * delivery of the same message — an edit, an embed unfurl, a gateway resume — repeats the punishment, the stored
 * event and the staff alert. Redis `SET NX` makes the claim atomic across the bot's workers.
 */
async function claimMatch(ctx: PluginContext, ruleId: string, messageId: string): Promise<boolean> {
  const key = redisKey(MATCH_CLAIM_KEY_PREFIX, ruleId, messageId);
  const claimed = await ctx.redis.set(key, '1', 'EX', MATCH_CLAIM_TTL_SECONDS, 'NX');
  return claimed === 'OK';
}

export interface HandleMessageOptions {
  /** True when re-checking a message automod has already seen (`messageUpdate`), which skips window-backed rules. */
  reevaluation?: boolean;
}

/** Runs every enabled, active, non-exempt message rule against a normalized message and applies matches (TASK: the whole automod pipeline for `messageCreate`/`messageUpdate`). */
export async function handleMessage(
  ctx: PluginContext,
  message: Message | PartialMessage,
  options: HandleMessageOptions = {},
): Promise<void> {
  const guildId = message.guildId;
  if (!guildId) return;
  if (message.author?.bot || message.author?.system) return;
  if (message.webhookId) return;

  const allRules = await fetchRules(ctx, guildId);
  const rules = allRules.filter((r) => isMessageRuleType(r.type));
  if (rules.length === 0) return;

  const guild =
    message.guild ??
    ctx.client.guilds.cache.get(guildId) ??
    (await ctx.client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  const config = await ctx.getConfig<AutomodConfig>(guildId);
  const normalized = normalizeMessage(message, ctx.intentsEnabled.messageContent);
  if (!normalized.authorId) return;

  const member =
    message.member ??
    guild.members.cache.get(normalized.authorId) ??
    (await guild.members.fetch(normalized.authorId).catch(() => null));
  const staffCtx = await getStaffContext(ctx, guild, member);
  const windowStoreBase = new RedisWindowStore(ctx.redis);
  const cooldowns = new Cooldowns(ctx.redis);
  const logContent = await getLogMessageContentEnabled(ctx, guildId);

  for (const rule of rules) {
    if (!isRuleTypeActive(rule.type, ctx.intentsEnabled)) continue;
    // An edit is one message being re-read, not a new one — feeding it back into a frequency/duplicate window
    // would count it twice and fire the rule before the member actually reached the threshold.
    if (options.reevaluation && isWindowBackedRuleType(rule.type)) continue;

    if (
      isExempt(
        rule,
        {
          userId: normalized.authorId,
          channelId: normalized.channelId,
          roleIds: staffCtx.roleIds,
          isStaff: staffCtx.isStaff,
        },
        config.exemptStaff,
      )
    ) {
      continue;
    }

    const ruleConfig = parseRuleConfig(rule);
    if (!ruleConfig) {
      ctx.logger.warn({ guildId, ruleId: rule.id }, 'automod: rule has an invalid stored config; skipping');
      continue;
    }

    let effectiveConfig: AutomodRuleConfig = ruleConfig;
    if (
      ruleConfig.type === 'INVITE_LINKS' &&
      ruleConfig.allowOwnServerInvites &&
      guild.members.me?.permissions.has('ManageGuild')
    ) {
      try {
        const invites = await guild.invites.fetch();
        effectiveConfig = {
          ...ruleConfig,
          allowedInviteCodes: [...ruleConfig.allowedInviteCodes, ...invites.map((i) => i.code)],
        };
      } catch {
        // Best-effort only — proceed with the configured allow list as-is.
      }
    }

    const windowStore = scopedWindowStore(windowStoreBase, rule.id);
    const result = await evaluateMessageRule(effectiveConfig, { message: normalized, windowStore });
    if (!result.matched) continue;

    const matchedDomain =
      typeof result.evidence?.matchedDomain === 'string' ? result.evidence.matchedDomain : null;
    if (matchedDomain && isTrustedDomain(matchedDomain, rule.trustedDomains)) continue;

    // Claimed before anything else this rule could spend on the message, so a repeat delivery can't punish twice
    // (see `claimMatch`). Ahead of the cooldown on purpose: `cooldowns.take` *arms* the cooldown, so claiming
    // second would let a re-delivered message re-arm it and swallow the member's next, genuinely new violation.
    if (!(await claimMatch(ctx, rule.id, normalized.messageId))) continue;

    if (rule.cooldownSeconds > 0) {
      const cooldownResult = await cooldowns.take(
        `automod:${rule.id}:${normalized.authorId}`,
        rule.cooldownSeconds,
      );
      if (!cooldownResult.ok) continue;
    }

    const dryRun = config.dryRun || rule.dryRun;
    const actions = parseRuleActions(rule);
    const reason = result.reason ?? `Matched automod rule "${rule.name}".`;

    const actionOutcomes: ActionOutcome[] = [];
    if (!dryRun) {
      for (const action of actions) {
        const outcome = await executeMessageAction(ctx, action, {
          guildId,
          message,
          member,
          userId: normalized.authorId,
          reason,
          config,
        });
        actionOutcomes.push(outcome);
      }
    } else {
      for (const action of actions)
        actionOutcomes.push({ type: action.type, applied: false, detail: 'dry run' });
    }

    const excerpt = logContent && normalized.content ? sanitizeEmbedText(normalized.content, 900) : null;

    const event = await createEvent(ctx, {
      guildId,
      rule,
      userId: normalized.authorId,
      channelId: normalized.channelId,
      messageId: normalized.messageId,
      result,
      excerpt,
      actionOutcomes,
      dryRun,
    });

    if (actions.some((a) => a.type === 'alert_staff')) {
      await postAlert(ctx, guild, config, {
        rule,
        userId: normalized.authorId,
        channelId: normalized.channelId,
        result,
        excerpt,
        actionOutcomes,
        dryRun,
        eventId: event.id,
      });
    }

    ctx.events.emit('automod.triggered', {
      guildId,
      ruleId: rule.id,
      ruleType: rule.type,
      userId: normalized.authorId,
      channelId: normalized.channelId,
      action: actions.map((a) => a.type).join(','),
      dryRun,
    });
  }
}

/** Runs every enabled, active, non-exempt join rule (`ACCOUNT_AGE`, `RAID_DETECTION`) against a new member, then applies the guild-wide raid lockdown if `RAID_DETECTION` matched. */
export async function handleMemberJoin(ctx: PluginContext, member: GuildMember): Promise<void> {
  const guildId = member.guild.id;
  if (member.user.bot) return;

  const config = await ctx.getConfig<AutomodConfig>(guildId);

  const lockdownKey = redisKey(RAID_LOCKDOWN_KEY_PREFIX, guildId);
  const lockdownActive = (await ctx.redis.get(lockdownKey)) !== null;
  if (lockdownActive && config.quarantineRoleId) {
    await applyQuarantine(ctx, guildId, member.id, 'Raid lockdown active — new joins are quarantined.');
  }

  const allRules = await fetchRules(ctx, guildId);
  const rules = allRules.filter((r) => !isMessageRuleType(r.type));
  if (rules.length === 0) return;

  const staffCtx = await getStaffContext(ctx, member.guild, member);
  const normalized = normalizeJoin(member);
  const windowStoreBase = new RedisWindowStore(ctx.redis);
  const cooldowns = new Cooldowns(ctx.redis);

  for (const rule of rules) {
    if (!isRuleTypeActive(rule.type, ctx.intentsEnabled)) continue;
    if (
      isExempt(
        rule,
        { userId: member.id, roleIds: staffCtx.roleIds, isStaff: staffCtx.isStaff },
        config.exemptStaff,
      )
    )
      continue;

    const ruleConfig = parseRuleConfig(rule);
    if (!ruleConfig) continue;

    const windowStore = scopedWindowStore(windowStoreBase, rule.id);
    const result = await evaluateJoinRule(ruleConfig, { join: normalized, windowStore });
    if (!result.matched) continue;

    if (rule.cooldownSeconds > 0) {
      const cooldownResult = await cooldowns.take(`automod:${rule.id}:${member.id}`, rule.cooldownSeconds);
      if (!cooldownResult.ok) continue;
    }

    const dryRun = config.dryRun || rule.dryRun;
    const actions = parseRuleActions(rule);
    const reason = result.reason ?? `Matched automod rule "${rule.name}".`;

    const actionOutcomes: ActionOutcome[] = [];
    for (const action of actions) {
      if (action.type === 'delete') {
        actionOutcomes.push({
          type: 'delete',
          applied: false,
          detail: 'Not applicable to a member join (no message).',
        });
        continue;
      }
      if (dryRun) {
        actionOutcomes.push({ type: action.type, applied: false, detail: 'dry run' });
        continue;
      }
      const outcome = await executeMessageAction(ctx, action, {
        guildId,
        message: null,
        member,
        userId: member.id,
        reason,
        config,
      });
      actionOutcomes.push(outcome);
    }

    const event = await createEvent(ctx, {
      guildId,
      rule,
      userId: member.id,
      channelId: null,
      messageId: null,
      result,
      excerpt: null,
      actionOutcomes,
      dryRun,
    });

    if (actions.some((a) => a.type === 'alert_staff')) {
      await postAlert(ctx, member.guild, config, {
        rule,
        userId: member.id,
        channelId: null,
        result,
        excerpt: null,
        actionOutcomes,
        dryRun,
        eventId: event.id,
      });
    }

    ctx.events.emit('automod.triggered', {
      guildId,
      ruleId: rule.id,
      ruleType: rule.type,
      userId: member.id,
      channelId: '',
      action: actions.map((a) => a.type).join(','),
      dryRun,
    });

    if (rule.type === 'RAID_DETECTION' && !dryRun && config.raidLockdown !== 'none') {
      await applyRaidLockdown(ctx, member.guild, config, reason);
    }
  }
}

async function applyRaidLockdown(
  ctx: PluginContext,
  guild: Guild,
  config: AutomodConfig,
  reason: string,
): Promise<void> {
  if (config.raidLockdown === 'raise-verification') {
    try {
      await guild.setVerificationLevel(GuildVerificationLevel.High, reason);
    } catch (err) {
      ctx.logger.error(
        { guildId: guild.id, err: err instanceof Error ? err.message : String(err) },
        'automod: failed to raise verification level during raid lockdown',
      );
    }
    return;
  }
  if (config.raidLockdown === 'quarantine-new-joins') {
    const key = redisKey(RAID_LOCKDOWN_KEY_PREFIX, guild.id);
    await ctx.redis.set(key, '1', 'EX', config.raidLockdownMinutes * 60);
  }
}

/** Resolves a pending `AutomodEvent` as CONFIRMED or FALSE_POSITIVE (TASK: the "Confirm violation"/"False positive" review buttons). Returns the updated row, or `null` if it doesn't belong to `guildId`. */
export async function resolveReview(
  ctx: PluginContext,
  guildId: string,
  eventId: string,
  status: 'CONFIRMED' | 'FALSE_POSITIVE',
  reviewerId: string,
): Promise<AutomodEvent | null> {
  const existing = await ctx.prisma.automodEvent.findFirst({ where: { id: eventId, guildId } });
  if (!existing) return null;

  return ctx.prisma.automodEvent.update({
    where: { id: eventId },
    data: { reviewStatus: status, reviewedBy: reviewerId, reviewedAt: new Date() },
  });
}

/** The `automod` cross-plugin service (ARCHITECTURE.md §7.5: `AutomodService.quarantine`). */
export function createAutomodService(ctx: PluginContext) {
  return {
    async quarantine(guildId: string, userId: string, reason: string): Promise<void> {
      const outcome = await applyQuarantine(ctx, guildId, userId, reason);
      if (!outcome.applied) {
        throw new Error(outcome.detail ?? 'Quarantine action failed.');
      }
    },
  };
}
