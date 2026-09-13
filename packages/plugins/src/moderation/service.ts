import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type User,
} from 'discord.js';
import { NotFoundError, ValidationError, redisKey } from '@entrophy/core';
import {
  nextCaseNumber,
  withNextCaseNumber,
  type ModerationAppeal,
  type ModerationCase,
  type ModerationCaseType,
  type ModerationNote,
  type ModerationWarning,
  type Prisma,
} from '@entrophy/database';
import {
  buildCustomId,
  resolveTextChannel,
  safeDm,
  type CreateModerationCaseInput,
  type ExportCasesOptions,
  type ExportCasesResult,
  type ListCasesInput,
  type ListCasesResult,
  type ModerationService,
  type OpenAppealInput,
  type OpenAppealResult,
  type PluginContext,
  type TimeoutInput,
  type WarnInput,
} from '../sdk';
import { toCsv } from './csv';
import { evaluateEscalation } from './escalation';
import {
  buildAppealDecisionEmbed,
  buildAppealEmbed,
  buildCaseDmEmbed,
  buildCaseLogEmbed,
  caseTypeLabel,
} from './embeds';
import type { EscalationRule, ModerationConfig } from './manifest';
import { filterMessagesForPurge, type PurgeCandidateMessage } from './purge';

// In-flight lock only (not the "already applied" record — that's the durable `effectsAppliedAt` DB column) —
// just long enough to keep two overlapping `appeal-sync` ticks from racing on the same appeal.
const APPEAL_SYNC_LOCK_TTL_MS = 30_000;

// `warn()` serializes insert-then-count-then-escalate per (guildId, targetId) — see `acquireWarnEscalationLock`'s
// doc comment. Unlike the enforcer decide lock (`enforcer/service.ts`), which rejects a second concurrent decider
// outright, a second concurrent warn must still succeed — it just waits its turn — so this retries on contention
// instead of failing on the first NX miss. TTL matches the enforcer decide lock's 30s (the locked span can
// include a full escalated Discord action — timeout/kick/ban — plus its own case creation and DM, not just the
// warning insert+count).
const WARN_ESCALATION_LOCK_TTL_MS = 30_000;
const WARN_ESCALATION_LOCK_RETRY_MS = 20;
const WARN_ESCALATION_LOCK_MAX_ATTEMPTS = 50; // ~1s worst-case wait before degrading to unlocked.

/** What `runEscalation` fired, surfaced from `warn()` so a caller (the Enforcer plugin) can bookkeep it too. */
export interface EscalationOutcome {
  rule: EscalationRule;
  case: ModerationCase;
}

/** Minimal shape used to build a DM before a kick/ban/softban actually happens (see `sendCaseDmToUser` callers). */
type PreDmCase = Pick<ModerationCase, 'type' | 'reason' | 'caseNumber'>;

/** A guild text channel that carries its own permission overwrites (i.e. everything except threads). */
type ManageableChannel = Extract<GuildTextBasedChannel, { permissionOverwrites: unknown }>;

/** What the bot needs to rewrite a channel's overwrites (`lock`/`unlock`) — notably *not* SendMessages. */
const OVERWRITE_REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageRoles,
] as const;

/** What the bot needs to change a channel's own settings (`slowmode`). */
const CHANNEL_SETTINGS_REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
] as const;

/** Exactly the allow bits `lock()` grants the bot — used to recognise (and only then remove) its own overwrite. */
const BOT_LOCK_ALLOW_BITS =
  PermissionFlagsBits.SendMessages | PermissionFlagsBits.SendMessagesInThreads;

/** Case types whose affected user is worth DMing (excludes channel-level/administrative/self-explanatory types). */
const DM_ELIGIBLE_TYPES = new Set<ModerationCaseType>([
  'WARN',
  'TIMEOUT',
  'UNTIMEOUT',
  'KICK',
  'BAN',
  'UNBAN',
  'SOFTBAN',
  'QUARANTINE',
]);

export interface KickInput {
  guildId: string;
  targetId: string;
  moderatorId: string;
  reason?: string;
  evidenceUrls?: string[];
  source: CreateModerationCaseInput['source'];
  dmUser?: boolean;
}

export interface BanInput extends KickInput {
  deleteMessageSeconds?: number;
  durationMs?: number;
}

export type SoftbanInput = BanInput;

export interface UnbanInput {
  guildId: string;
  targetId: string;
  moderatorId: string;
  reason?: string;
  source: CreateModerationCaseInput['source'];
}

export interface PurgeInput {
  guildId: string;
  channelId: string;
  moderatorId: string;
  count: number;
  userId?: string;
  contains?: string;
  reason?: string;
  source: CreateModerationCaseInput['source'];
}

export interface PurgeResult {
  case: ModerationCase;
  deletedCount: number;
}

export interface ChannelActionInput {
  guildId: string;
  channelId: string;
  moderatorId: string;
  reason?: string;
  source: CreateModerationCaseInput['source'];
}

export interface SlowmodeInput extends ChannelActionInput {
  seconds: number | null;
}

export interface NickInput {
  guildId: string;
  targetId: string;
  moderatorId: string;
  nickname: string | null;
  reason?: string;
  source: CreateModerationCaseInput['source'];
}

export interface RoleActionInput {
  guildId: string;
  targetId: string;
  roleId: string;
  moderatorId: string;
  reason?: string;
  source: CreateModerationCaseInput['source'];
  remove?: boolean;
}

export interface AddNoteInput {
  guildId: string;
  userId: string;
  authorId: string;
  content: string;
}

export interface ListWarningsInput {
  guildId: string;
  /** Omit to list active warnings guild-wide (`/mod warnings` with no user given). */
  userId?: string;
  activeOnly?: boolean;
}

export interface DecideAppealInput {
  guildId: string;
  appealId: string;
  accept: boolean;
  reviewerId: string;
  decisionNote?: string;
}

/**
 * Business logic for the `moderation` plugin (SPEC.md §B). Every Discord side effect is best-effort and never
 * throws out past the record it's attached to — a failed mod-log post or DM never rolls back or masks the case
 * itself (the database row is the source of truth).
 */
export class ModerationServiceImpl implements ModerationService {
  constructor(private readonly ctx: PluginContext) {}

  // ---------------------------------------------------------------------
  // Config helpers
  // ---------------------------------------------------------------------

  private async getModConfig(guildId: string): Promise<ModerationConfig> {
    return this.ctx.getConfig<ModerationConfig>(guildId);
  }

  /** Reads the core `GuildConfig` via the host service (registered by every bot process before any plugin loads). */
  private async getCoreGuildConfig(guildId: string) {
    const host = this.ctx.services.get('host');
    if (!host) {
      return {
        modLogChannelId: null as string | null,
        appealsChannelId: null as string | null,
        staffChannelId: null as string | null,
        dmOnModeration: true,
      };
    }
    return host.getGuildConfig(guildId);
  }

  private async resolveModLogChannelId(guildId: string): Promise<string | null> {
    const [config, guildConfig] = await Promise.all([
      this.getModConfig(guildId),
      this.getCoreGuildConfig(guildId),
    ]);
    return config.modLogChannelId ?? guildConfig.modLogChannelId;
  }

  private async resolveAppealsChannelId(guildId: string): Promise<string | null> {
    const [config, guildConfig] = await Promise.all([
      this.getModConfig(guildId),
      this.getCoreGuildConfig(guildId),
    ]);
    return config.appealsChannelId ?? guildConfig.appealsChannelId ?? guildConfig.staffChannelId;
  }

  /** DM gating per ARCHITECTURE.md §7.5: both the core "DM on moderation" toggle and this plugin's own toggle must allow it. */
  private async dmAllowed(guildId: string): Promise<boolean> {
    const [config, guildConfig] = await Promise.all([
      this.getModConfig(guildId),
      this.getCoreGuildConfig(guildId),
    ]);
    return config.dmOnAction && guildConfig.dmOnModeration;
  }

  private async fetchGuild(guildId: string): Promise<Guild> {
    try {
      return await this.ctx.client.guilds.fetch(guildId);
    } catch {
      throw new NotFoundError('The bot is not in that server (or the server id is invalid).');
    }
  }

  private async fetchMember(guild: Guild, userId: string): Promise<GuildMember> {
    try {
      return await guild.members.fetch(userId);
    } catch {
      throw new NotFoundError('That user is not a member of this server.');
    }
  }

  private async fetchUser(userId: string): Promise<User | null> {
    try {
      return await this.ctx.client.users.fetch(userId);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Mod-log + DM
  // ---------------------------------------------------------------------

  private async postModLog(row: ModerationCase): Promise<void> {
    const channelId = await this.resolveModLogChannelId(row.guildId);
    if (!channelId) return;
    const guild = await this.fetchGuild(row.guildId);
    const channel = await resolveTextChannel(guild, channelId);
    if (!channel) return;
    await channel.send({ embeds: [buildCaseLogEmbed(row)] });
  }

  /** Sends a case DM to a live `User` object (must be fetched before removing them from the guild, for kick/ban). */
  private async sendCaseDmToUser(user: User, row: PreDmCase, guildName: string): Promise<boolean> {
    const result = await safeDm(user, { embeds: [buildCaseDmEmbed(row, guildName)] });
    if (!result.sent) {
      this.ctx.logger.info(
        { userId: user.id, caseNumber: row.caseNumber, error: result.error },
        'moderation: DM notification failed (not fatal)',
      );
    }
    return result.sent;
  }

  private async maybeDmForCase(row: ModerationCase): Promise<boolean> {
    if (!DM_ELIGIBLE_TYPES.has(row.type)) return false;
    if (!(await this.dmAllowed(row.guildId))) return false;
    const user = await this.fetchUser(row.targetId);
    if (!user) return false;
    const guild = this.ctx.client.guilds.cache.get(row.guildId);
    return this.sendCaseDmToUser(user, row, guild?.name ?? 'the server');
  }

  // ---------------------------------------------------------------------
  // ServiceMap.moderation contract
  // ---------------------------------------------------------------------

  async createCase(input: CreateModerationCaseInput): Promise<ModerationCase> {
    const expiresAt = input.durationMs ? new Date(Date.now() + input.durationMs) : null;

    const row = await withNextCaseNumber(this.ctx.prisma, input.guildId, (caseNumber) =>
      this.ctx.prisma.moderationCase.create({
        data: {
          guildId: input.guildId,
          caseNumber,
          type: input.type,
          targetId: input.targetId,
          moderatorId: input.moderatorId,
          reason: input.reason?.trim() || null,
          evidenceUrls: input.evidenceUrls ?? [],
          durationMs: input.durationMs ?? null,
          expiresAt,
          source: input.source,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
      }),
    );

    // ROLE_ADD cases with a duration (e.g. the `enforcer` plugin's timed MUTE) are not otherwise scheduled by
    // any caller — `timeout()`/`ban()` schedule their own expiry explicitly, but a generic `createCase` caller
    // has no other way to get a timed role removed automatically. `scheduleExpiry` is a no-op when
    // `durationMs` is unset, and BullMQ dedupes on `jobId: case-<id>` so this can never double-schedule.
    if (row.type === 'ROLE_ADD' && row.durationMs) {
      await this.scheduleExpiry(row);
    }

    await this.postModLog(row).catch((err: unknown) =>
      this.ctx.logger.warn({ err: String(err), caseId: row.id }, 'moderation: failed to post mod-log embed'),
    );

    const logging = this.ctx.services.get('logging');
    if (logging) {
      await logging
        .log(row.guildId, 'moderation.action', {
          actorId: row.moderatorId,
          targetId: row.targetId,
          title: `Case #${row.caseNumber} — ${caseTypeLabel(row.type)}`,
          description: row.reason ?? undefined,
          fields: [{ name: 'Type', value: row.type, inline: true }],
        })
        .catch((err: unknown) =>
          this.ctx.logger.warn({ err: String(err) }, 'moderation: logging.log failed'),
        );
    }

    this.ctx.events.emit('moderation.caseCreated', {
      guildId: row.guildId,
      caseId: row.id,
      caseNumber: row.caseNumber,
      type: row.type,
      targetId: row.targetId,
      moderatorId: row.moderatorId,
      reason: row.reason ?? undefined,
    });

    let dmSent = false;
    if (input.dmUser !== false) {
      dmSent = await this.maybeDmForCase(row);
    }
    if (dmSent !== row.dmSent) {
      await this.ctx.prisma.moderationCase
        .update({ where: { id: row.id }, data: { dmSent } })
        .catch(() => undefined);
    }

    await this.ctx.audit({
      guildId: row.guildId,
      actorId: row.moderatorId,
      actorType: input.source === 'BOT' ? 'user' : 'system',
      action: 'moderation.case.create',
      targetType: 'moderation_case',
      targetId: row.id,
      after: { type: row.type, targetId: row.targetId, caseNumber: row.caseNumber },
      reason: row.reason ?? undefined,
      source:
        input.source === 'DASHBOARD'
          ? 'dashboard'
          : input.source === 'AUTOMOD' || input.source === 'SYSTEM'
            ? 'system'
            : 'bot',
    });

    return { ...row, dmSent };
  }

  /**
   * The interface's declared return type stays plain `ModerationCase` (`ServiceMap.moderation.warn` in
   * sdk/services.ts) — this widened return type is a covariant override: still fully assignable back to that
   * interface, but lets the Enforcer plugin (which calls this through `ctx.services.get('moderation')`, typed
   * as the interface) read the optional `escalation` field via its own local mirror of `EscalationOutcome`
   * rather than a blind cast. See `enforcer/service.ts`'s `WarnEscalationOutcome`.
   */
  async warn(input: WarnInput): Promise<ModerationCase & { escalation?: EscalationOutcome }> {
    const row = await this.createCase({
      guildId: input.guildId,
      type: 'WARN',
      targetId: input.targetId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      source: input.source,
      dmUser: input.dmUser,
    });

    const escalation = await this.insertWarningAndEscalate(input, row.id);
    return escalation ? { ...row, escalation } : row;
  }

  /**
   * BUG FIX: inserting the warning row, counting active warnings, and evaluating the escalation ladder must
   * happen as one serialized sequence per (guild, user) — otherwise two concurrent `/mod warn` calls can both
   * insert before either counts, so both then see the same post-both total and a rung strictly between the
   * old and new counts never fires at all (`evaluateEscalation` only matches an EXACT count). A short-lived Redis
   * lock (`acquireWarnEscalationLock`, same NX/PX + try/finally convention as the Enforcer's decide lock in
   * `enforcer/service.ts`) makes the sequence atomic across concurrent callers; once serialized, the count
   * advances one at a time and exact-match escalation is correct again.
   */
  private async insertWarningAndEscalate(
    input: WarnInput,
    caseId: string,
  ): Promise<EscalationOutcome | null> {
    const lockKey = await this.acquireWarnEscalationLock(input.guildId, input.targetId);
    let rule: EscalationRule | null;
    try {
      await this.ctx.prisma.moderationWarning.create({
        data: {
          guildId: input.guildId,
          userId: input.targetId,
          caseId,
          moderatorId: input.moderatorId,
          reason: input.reason?.trim() || null,
        },
      });

      rule = await this.selectEscalation(input.guildId, input.targetId);
    } finally {
      if (lockKey) await this.ctx.redis.del(lockKey).catch(() => undefined);
    }

    // Deliberately outside the lock: only choosing the rung has to be serialized. Carrying out the punishment
    // means a Discord round trip plus a DM, which can take seconds — holding the lock across that would make
    // every other warn for this member wait it out, and any that gave up waiting would count unserialized and
    // reintroduce the skipped-rung bug this lock exists to prevent.
    if (!rule) return null;
    return this.executeEscalation(rule, input.guildId, input.targetId, input.moderatorId, input.source);
  }

  private warnEscalationLockKey(guildId: string, userId: string): string {
    return redisKey('moderation', 'warn-escalation-lock', guildId, userId);
  }

  /**
   * Acquires the per-(guild, user) warn-escalation lock, retrying on contention rather than failing on the
   * first miss — unlike the enforcer decide lock, a second concurrent warn must still succeed, just after the
   * first finishes its insert-count-escalate sequence. Returns `null` (degrading safely: the warning is still
   * recorded, escalation just isn't guaranteed race-free for this call) if the lock can't be acquired within
   * the retry budget — a genuine Redis error, or contention that outlasts it — rather than blocking the warn
   * forever or dropping it.
   */
  private async acquireWarnEscalationLock(guildId: string, userId: string): Promise<string | null> {
    const lockKey = this.warnEscalationLockKey(guildId, userId);
    const holder = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (let attempt = 0; attempt < WARN_ESCALATION_LOCK_MAX_ATTEMPTS; attempt++) {
      try {
        const acquired = await this.ctx.redis.set(lockKey, holder, 'PX', WARN_ESCALATION_LOCK_TTL_MS, 'NX');
        if (acquired === 'OK') return lockKey;
      } catch (err) {
        this.ctx.logger.warn(
          { err: String(err), guildId, userId },
          'moderation: warn-escalation lock acquisition errored — proceeding unlocked',
        );
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, WARN_ESCALATION_LOCK_RETRY_MS));
    }
    this.ctx.logger.warn(
      { guildId, userId },
      'moderation: warn-escalation lock contended past the retry budget — proceeding unlocked',
    );
    return null;
  }

  /** The rung this warning lands on, if any. Counting and evaluating must run under the warn-escalation lock. */
  private async selectEscalation(guildId: string, targetId: string): Promise<EscalationRule | null> {
    const activeCount = await this.ctx.prisma.moderationWarning.count({
      where: { guildId, userId: targetId, active: true },
    });
    const config = await this.getModConfig(guildId);
    return evaluateEscalation(activeCount, config.escalations as EscalationRule[]);
  }

  /** Carries out an escalation rung. Runs unlocked; a failure is logged and never fails the warning itself. */
  private async executeEscalation(
    rule: EscalationRule,
    guildId: string,
    targetId: string,
    moderatorId: string,
    source: CreateModerationCaseInput['source'],
  ): Promise<EscalationOutcome | null> {
    const reason = `Automatic escalation: reached ${rule.warnings} active warning(s).`;
    try {
      let escalatedCase: ModerationCase | null = null;
      if (rule.action === 'timeout' && rule.durationMs) {
        escalatedCase = await this.timeout({
          guildId,
          targetId,
          moderatorId,
          durationMs: rule.durationMs,
          reason,
          source,
        });
      } else if (rule.action === 'kick') {
        escalatedCase = await this.kick({ guildId, targetId, moderatorId, reason, source });
      } else if (rule.action === 'ban') {
        escalatedCase = await this.ban({
          guildId,
          targetId,
          moderatorId,
          reason,
          source,
          durationMs: rule.durationMs,
        });
      }
      return escalatedCase ? { rule, case: escalatedCase } : null;
    } catch (err) {
      this.ctx.logger.error(
        { err: String(err), guildId, targetId, rule },
        'moderation: automatic escalation action failed',
      );
      return null;
    }
  }

  async timeout(input: TimeoutInput): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    const member = await this.fetchMember(guild, input.targetId);
    await member.timeout(input.durationMs, input.reason);

    const row = await this.createCase({
      guildId: input.guildId,
      type: 'TIMEOUT',
      targetId: input.targetId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      durationMs: input.durationMs,
      source: input.source,
      dmUser: input.dmUser,
    });

    await this.scheduleExpiry(row);
    return row;
  }

  async untimeout(input: {
    guildId: string;
    targetId: string;
    moderatorId: string;
    reason?: string;
    source: CreateModerationCaseInput['source'];
    dmUser?: boolean;
  }): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    const member = await this.fetchMember(guild, input.targetId);
    await member.timeout(null, input.reason);
    await this.markExpiredForActiveTimeout(input.guildId, input.targetId);

    return this.createCase({
      guildId: input.guildId,
      type: 'UNTIMEOUT',
      targetId: input.targetId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      source: input.source,
      dmUser: input.dmUser,
    });
  }

  private async markExpiredForActiveTimeout(guildId: string, targetId: string): Promise<void> {
    await this.ctx.prisma.moderationCase.updateMany({
      where: { guildId, targetId, type: 'TIMEOUT', expiredAt: null, deletedAt: null },
      data: { expiredAt: new Date() },
    });
  }

  private async scheduleExpiry(row: ModerationCase): Promise<void> {
    if (!row.durationMs) return;
    try {
      await this.ctx
        .queue('expire')
        // BullMQ rejects a custom job id containing `:` unless it has exactly three segments
        // (`Job.validateOptions`), so every jobId in this repo uses `-` as the separator.
        .add('expire', { caseId: row.id }, { jobId: `case-${row.id}`, delay: row.durationMs });
    } catch (err) {
      this.ctx.logger.error(
        { err: String(err), caseId: row.id },
        'moderation: failed to schedule expiry job',
      );
    }
  }

  getCase(guildId: string, caseNumber: number): Promise<ModerationCase | null> {
    return this.ctx.prisma.moderationCase.findUnique({
      where: { guildId_caseNumber: { guildId, caseNumber } },
    });
  }

  getCaseByNumber(guildId: string, caseNumber: number): Promise<ModerationCase | null> {
    return this.getCase(guildId, caseNumber);
  }

  async listCases(input: ListCasesInput): Promise<ListCasesResult> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const offset = decodeOffsetCursor(input.cursor);

    const rows = await this.ctx.prisma.moderationCase.findMany({
      where: {
        guildId: input.guildId,
        deletedAt: null,
        ...(input.targetId ? { targetId: input.targetId } : {}),
        ...(input.moderatorId ? { moderatorId: input.moderatorId } : {}),
        ...(input.type ? { type: input.type } : {}),
      },
      orderBy: { caseNumber: 'desc' },
      skip: offset,
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? encodeOffsetCursor(offset + limit) : null };
  }

  async exportCases(guildId: string, opts?: ExportCasesOptions): Promise<ExportCasesResult> {
    const rows = await this.ctx.prisma.moderationCase.findMany({
      where: { guildId, deletedAt: null, ...(opts?.since ? { createdAt: { gte: opts.since } } : {}) },
      orderBy: { caseNumber: 'desc' },
      take: 10_000,
    });

    const csv = toCsv(
      rows.map((row) => ({
        caseNumber: row.caseNumber,
        type: row.type,
        targetId: row.targetId,
        moderatorId: row.moderatorId,
        reason: row.reason ?? '',
        durationMs: row.durationMs ?? '',
        source: row.source,
        createdAt: row.createdAt.toISOString(),
      })),
      ['caseNumber', 'type', 'targetId', 'moderatorId', 'reason', 'durationMs', 'source', 'createdAt'],
    );

    return { csv, count: rows.length };
  }

  // ---------------------------------------------------------------------
  // Kick / ban / softban / unban
  // ---------------------------------------------------------------------

  async kick(input: KickInput): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    const member = await this.fetchMember(guild, input.targetId);
    const user = member.user;

    let dmSent = false;
    if (input.dmUser !== false && (await this.dmAllowed(input.guildId))) {
      const hintedCaseNumber = await nextCaseNumber(this.ctx.prisma, input.guildId);
      dmSent = await this.sendCaseDmToUser(
        user,
        { type: 'KICK', caseNumber: hintedCaseNumber, reason: input.reason ?? null },
        guild.name,
      );
    }

    await member.kick(input.reason);

    const row = await this.createCase({
      guildId: input.guildId,
      type: 'KICK',
      targetId: input.targetId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      evidenceUrls: input.evidenceUrls,
      source: input.source,
      dmUser: false,
    });

    return dmSent ? this.markDmSent(row) : row;
  }

  private async markDmSent(row: ModerationCase): Promise<ModerationCase> {
    await this.ctx.prisma.moderationCase
      .update({ where: { id: row.id }, data: { dmSent: true } })
      .catch(() => undefined);
    return { ...row, dmSent: true };
  }

  async ban(input: BanInput): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    const user = (await this.fetchUser(input.targetId)) ?? undefined;

    let dmSent = false;
    if (user && input.dmUser !== false && (await this.dmAllowed(input.guildId))) {
      const hintedCaseNumber = await nextCaseNumber(this.ctx.prisma, input.guildId);
      dmSent = await this.sendCaseDmToUser(
        user,
        { type: 'BAN', caseNumber: hintedCaseNumber, reason: input.reason ?? null },
        guild.name,
      );
    }

    await guild.bans.create(input.targetId, {
      reason: input.reason,
      deleteMessageSeconds: input.deleteMessageSeconds ?? 0,
    });

    const row = await this.createCase({
      guildId: input.guildId,
      type: 'BAN',
      targetId: input.targetId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      evidenceUrls: input.evidenceUrls,
      durationMs: input.durationMs,
      source: input.source,
      dmUser: false,
    });

    if (input.durationMs) {
      await this.scheduleExpiry(row);
    }

    return dmSent ? this.markDmSent(row) : row;
  }

  async softban(input: SoftbanInput): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    const user = (await this.fetchUser(input.targetId)) ?? undefined;

    let dmSent = false;
    if (user && input.dmUser !== false && (await this.dmAllowed(input.guildId))) {
      const hintedCaseNumber = await nextCaseNumber(this.ctx.prisma, input.guildId);
      dmSent = await this.sendCaseDmToUser(
        user,
        { type: 'SOFTBAN', caseNumber: hintedCaseNumber, reason: input.reason ?? null },
        guild.name,
      );
    }

    await guild.bans.create(input.targetId, {
      reason: input.reason ?? 'Softban',
      deleteMessageSeconds: input.deleteMessageSeconds ?? 86400,
    });
    await guild.bans.remove(input.targetId, 'Softban cleanup — automatic unban after message purge.');

    const row = await this.createCase({
      guildId: input.guildId,
      type: 'SOFTBAN',
      targetId: input.targetId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      evidenceUrls: input.evidenceUrls,
      source: input.source,
      dmUser: false,
    });

    return dmSent ? this.markDmSent(row) : row;
  }

  async unban(input: UnbanInput): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    await guild.bans.remove(input.targetId, input.reason);
    await this.markExpiredForActiveBan(input.guildId, input.targetId);

    return this.createCase({
      guildId: input.guildId,
      type: 'UNBAN',
      targetId: input.targetId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      source: input.source,
      dmUser: false,
    });
  }

  private async markExpiredForActiveBan(guildId: string, targetId: string): Promise<void> {
    await this.ctx.prisma.moderationCase.updateMany({
      where: { guildId, targetId, type: 'BAN', expiredAt: null, deletedAt: null },
      data: { expiredAt: new Date() },
    });
  }

  // ---------------------------------------------------------------------
  // Purge / channel actions / nickname / roles
  // ---------------------------------------------------------------------

  async purge(input: PurgeInput): Promise<PurgeResult> {
    const guild = await this.fetchGuild(input.guildId);
    const channel = await resolveTextChannel(guild, input.channelId);
    if (!channel) {
      throw new ValidationError("I can't send/view messages in that channel.");
    }

    const fetched = await channel.messages.fetch({ limit: 100 });
    const now = Date.now();
    const byId = new Map(fetched.map((m) => [m.id, m]));
    const candidates: PurgeCandidateMessage[] = fetched.map((m) => ({
      id: m.id,
      authorId: m.author.id,
      authorIsBot: m.author.bot,
      content: m.content,
      ageMs: now - m.createdTimestamp,
    }));
    const selected = filterMessagesForPurge(candidates, {
      userId: input.userId,
      contains: input.contains,
      limit: input.count,
    });
    const toDelete = selected
      .map((m) => byId.get(m.id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));

    let deletedCount = 0;
    if (toDelete.length > 0) {
      const deleted = await channel.bulkDelete(toDelete, true);
      deletedCount = deleted.size;
    }

    const row = await this.createCase({
      guildId: input.guildId,
      type: 'PURGE',
      targetId: input.userId ?? input.moderatorId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      source: input.source,
      dmUser: false,
      metadata: {
        count: deletedCount,
        channelId: input.channelId,
        filteredByUser: Boolean(input.userId),
        filteredByContent: Boolean(input.contains),
      },
    });

    return { case: row, deletedCount };
  }

  /**
   * Resolves a channel for a channel-*management* action (lock/unlock/slowmode). Unlike `resolveTextChannel`
   * this never asks whether the bot can *speak* in the channel: `lock()` denies SendMessages on `@everyone`,
   * which Discord applies to the bot too, so a send-based guard would make a locked channel unlockable.
   */
  private async resolveManageableChannel(
    guild: Guild,
    channelId: string,
    required: readonly bigint[],
  ): Promise<GuildTextBasedChannel | null> {
    let channel;
    try {
      channel = await guild.channels.fetch(channelId);
    } catch {
      return null;
    }
    if (!channel || !channel.isTextBased() || channel.type === ChannelType.GuildStageVoice) {
      return null;
    }

    const botMember = guild.members.me;
    if (!botMember) return null;

    const perms = channel.permissionsFor(botMember);
    if (!perms || !perms.has(required)) return null;

    return channel as GuildTextBasedChannel;
  }

  /**
   * Drops the send-allow `lock()` gave the bot — but only when that overwrite is *exactly* what `lock()` wrote.
   * Anything richer (hub-setup grants the bot View/Send/Embed in staff channels) predates the lock and is not
   * ours to delete.
   */
  private async clearBotLockOverwrite(channel: ManageableChannel, reason?: string): Promise<void> {
    const botMember = channel.guild.members.me;
    if (!botMember) return;

    const existing = channel.permissionOverwrites.cache.get(botMember.id);
    if (!existing || existing.deny.bitfield !== 0n || existing.allow.bitfield !== BOT_LOCK_ALLOW_BITS) {
      return;
    }
    await channel.permissionOverwrites.delete(botMember, reason);
  }

  async lock(input: ChannelActionInput): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    const channel = await this.resolveManageableChannel(
      guild,
      input.channelId,
      OVERWRITE_REQUIRED_PERMISSIONS,
    );
    if (!channel || !('permissionOverwrites' in channel))
      throw new ValidationError('That channel cannot be locked.');

    // The `@everyone` deny below hits the bot as well (it is deliberately never Administrator), which would
    // leave it unable to unlock, purge or post a mod-log embed here. Take the explicit allow for ourselves
    // first, so if the deny then fails the channel is merely still unlocked rather than locked against us.
    const botMember = guild.members.me;
    if (botMember) {
      await channel.permissionOverwrites.edit(
        botMember,
        { SendMessages: true, SendMessagesInThreads: true },
        { reason: input.reason },
      );
    }
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { SendMessages: false, SendMessagesInThreads: false },
      { reason: input.reason },
    );

    return this.createCase({
      guildId: input.guildId,
      type: 'LOCK',
      targetId: input.channelId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      source: input.source,
      dmUser: false,
      metadata: { channelId: input.channelId },
    });
  }

  async unlock(input: ChannelActionInput): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    const channel = await this.resolveManageableChannel(
      guild,
      input.channelId,
      OVERWRITE_REQUIRED_PERMISSIONS,
    );
    if (!channel || !('permissionOverwrites' in channel))
      throw new ValidationError('That channel cannot be unlocked.');
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { SendMessages: null, SendMessagesInThreads: null },
      { reason: input.reason },
    );
    await this.clearBotLockOverwrite(channel, input.reason);

    return this.createCase({
      guildId: input.guildId,
      type: 'UNLOCK',
      targetId: input.channelId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      source: input.source,
      dmUser: false,
      metadata: { channelId: input.channelId },
    });
  }

  async slowmode(input: SlowmodeInput): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    const channel = await this.resolveManageableChannel(
      guild,
      input.channelId,
      CHANNEL_SETTINGS_REQUIRED_PERMISSIONS,
    );
    if (!channel || !('setRateLimitPerUser' in channel))
      throw new ValidationError('Slowmode cannot be set on that channel.');
    await channel.setRateLimitPerUser(input.seconds ?? 0, input.reason);

    return this.createCase({
      guildId: input.guildId,
      type: 'SLOWMODE',
      targetId: input.channelId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      source: input.source,
      dmUser: false,
      metadata: { channelId: input.channelId, seconds: input.seconds ?? 0 },
    });
  }

  async nick(input: NickInput): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    const member = await this.fetchMember(guild, input.targetId);
    await member.setNickname(input.nickname, input.reason);

    return this.createCase({
      guildId: input.guildId,
      type: 'NICK',
      targetId: input.targetId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      source: input.source,
      dmUser: false,
      metadata: { nickname: input.nickname },
    });
  }

  async roleAction(input: RoleActionInput): Promise<ModerationCase> {
    const guild = await this.fetchGuild(input.guildId);
    const member = await this.fetchMember(guild, input.targetId);
    if (input.remove) {
      await member.roles.remove(input.roleId, input.reason);
    } else {
      await member.roles.add(input.roleId, input.reason);
    }

    return this.createCase({
      guildId: input.guildId,
      type: input.remove ? 'ROLE_REMOVE' : 'ROLE_ADD',
      targetId: input.targetId,
      moderatorId: input.moderatorId,
      reason: input.reason,
      source: input.source,
      dmUser: false,
      metadata: { roleId: input.roleId },
    });
  }

  // ---------------------------------------------------------------------
  // Notes & warnings
  // ---------------------------------------------------------------------

  addNote(input: AddNoteInput): Promise<ModerationNote> {
    return this.ctx.prisma.moderationNote.create({
      data: {
        guildId: input.guildId,
        userId: input.userId,
        authorId: input.authorId,
        content: input.content.trim(),
      },
    });
  }

  listNotes(guildId: string, userId: string): Promise<ModerationNote[]> {
    return this.ctx.prisma.moderationNote.findMany({
      where: { guildId, userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  listWarnings(input: ListWarningsInput): Promise<ModerationWarning[]> {
    return this.ctx.prisma.moderationWarning.findMany({
      where: {
        guildId: input.guildId,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.activeOnly ? { active: true } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Clears one active warning (or, if `warningId` is omitted, every active warning for the user). */
  async clearWarnings(
    guildId: string,
    userId: string,
    clearedBy: string,
    warningId?: string,
  ): Promise<number> {
    const result = await this.ctx.prisma.moderationWarning.updateMany({
      where: { guildId, userId, active: true, ...(warningId ? { id: warningId } : {}) },
      data: { active: false, clearedAt: new Date(), clearedBy },
    });
    return result.count;
  }

  // ---------------------------------------------------------------------
  // Appeals
  // ---------------------------------------------------------------------

  /**
   * Widens the cross-plugin `OpenAppealResult` with `staffNotified` so the caller can tell the user the truth:
   * a guild with no appeals channel (or one the bot can't post in) still gets the row, but nobody is notified.
   */
  async openAppeal(input: OpenAppealInput): Promise<OpenAppealResult & { staffNotified: boolean }> {
    let caseId = input.caseId ?? null;
    let caseNumber: number | null = input.caseNumber ?? null;

    if (!caseId && input.caseNumber) {
      const caseRow = await this.getCase(input.guildId, input.caseNumber);
      caseId = caseRow?.id ?? null;
    } else if (caseId && !caseNumber) {
      const caseRow = await this.ctx.prisma.moderationCase.findUnique({ where: { id: caseId } });
      caseNumber = caseRow?.caseNumber ?? null;
    }

    const appeal = await this.ctx.prisma.moderationAppeal.create({
      data: { guildId: input.guildId, caseId, userId: input.userId, content: input.content.trim() },
    });

    const staffNotified = await this.postAppealPrompt(appeal, caseNumber).catch((err: unknown) => {
      this.ctx.logger.warn(
        { err: String(err), appealId: appeal.id },
        'moderation: failed to post appeal prompt',
      );
      return false;
    });

    this.ctx.events.emit('moderation.appealOpened', {
      guildId: input.guildId,
      appealId: appeal.id,
      caseId: caseId ?? '',
      caseNumber: caseNumber ?? 0,
      userId: input.userId,
    });

    return { appealId: appeal.id, staffNotified };
  }

  /** Returns whether the appeal actually reached a staff channel (false when none is configured or reachable). */
  private async postAppealPrompt(
    appeal: ModerationAppeal,
    caseNumber: number | null,
  ): Promise<boolean> {
    const channelId = await this.resolveAppealsChannelId(appeal.guildId);
    if (!channelId) return false;
    const guild = await this.fetchGuild(appeal.guildId);
    const channel = await resolveTextChannel(guild, channelId);
    if (!channel) return false;

    const message = await channel.send({
      embeds: [buildAppealEmbed(appeal, caseNumber)],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: 'Accept',
              custom_id: buildCustomId('moderation', 'appeal-accept', appeal.id),
            },
            {
              type: 2,
              style: 4,
              label: 'Deny',
              custom_id: buildCustomId('moderation', 'appeal-deny', appeal.id),
            },
          ],
        },
      ],
    });

    await this.ctx.prisma.moderationAppeal
      .update({ where: { id: appeal.id }, data: { staffMessageId: message.id } })
      .catch(() => undefined);

    return true;
  }

  /** Bot-path decision (Accept/Deny buttons on the appeal prompt). Dashboard decisions write the DB directly and are picked up by the `appeal-sync` job. */
  async decideAppeal(input: DecideAppealInput): Promise<ModerationAppeal> {
    const updated = await this.ctx.prisma.moderationAppeal.update({
      where: { id: input.appealId },
      data: {
        status: input.accept ? 'ACCEPTED' : 'DENIED',
        reviewedBy: input.reviewerId,
        reviewedAt: new Date(),
        decisionNote: input.decisionNote?.trim() || null,
      },
    });

    await this.applyAppealDecisionEffects(updated);
    await this.markAppealEffectsApplied(updated.id);

    await this.ctx.audit({
      guildId: input.guildId,
      actorId: input.reviewerId,
      actorType: 'user',
      action: input.accept ? 'moderation.appeal.approve' : 'moderation.appeal.deny',
      targetType: 'moderation_appeal',
      targetId: updated.id,
      after: { status: updated.status },
      source: 'bot',
    });

    return updated;
  }

  /** DMs the appellant and, on acceptance, reverses a still-active TIMEOUT automatically (offers an "Unban now" button for BAN). Shared by the bot's own Accept/Deny buttons and the `appeal-sync` job (dashboard decisions). */
  async applyAppealDecisionEffects(appeal: ModerationAppeal): Promise<void> {
    const caseRow = appeal.caseId
      ? await this.ctx.prisma.moderationCase.findUnique({ where: { id: appeal.caseId } })
      : null;
    const accepted = appeal.status === 'ACCEPTED';

    const user = await this.fetchUser(appeal.userId);
    if (user) {
      await safeDm(user, {
        embeds: [buildAppealDecisionEmbed(accepted, caseRow?.caseNumber ?? null, appeal.decisionNote)],
      }).catch(() => undefined);
    }

    if (!accepted || !caseRow) {
      this.ctx.events.emit('moderation.appealDecided', {
        guildId: appeal.guildId,
        appealId: appeal.id,
        caseId: appeal.caseId ?? '',
        caseNumber: caseRow?.caseNumber ?? 0,
        userId: appeal.userId,
        accepted,
        reviewerId: appeal.reviewedBy ?? '',
      });
      return;
    }

    if (caseRow.type === 'TIMEOUT' && !caseRow.expiredAt) {
      try {
        const guild = await this.fetchGuild(appeal.guildId);
        const member = await this.fetchMember(guild, appeal.userId);
        await member.timeout(null, `Appeal accepted for case #${caseRow.caseNumber}`);
        await this.markExpiredForActiveTimeout(appeal.guildId, appeal.userId);
      } catch (err) {
        this.ctx.logger.warn(
          { err: String(err), appealId: appeal.id },
          'moderation: could not auto-remove timeout after accepted appeal',
        );
      }
    } else if (caseRow.type === 'BAN') {
      await this.postUnbanOfferButton(appeal, caseRow.caseNumber).catch((err: unknown) =>
        this.ctx.logger.warn(
          { err: String(err), appealId: appeal.id },
          'moderation: failed to post unban-now offer',
        ),
      );
    }

    this.ctx.events.emit('moderation.appealDecided', {
      guildId: appeal.guildId,
      appealId: appeal.id,
      caseId: appeal.caseId ?? '',
      caseNumber: caseRow.caseNumber,
      userId: appeal.userId,
      accepted,
      reviewerId: appeal.reviewedBy ?? '',
    });
  }

  private async postUnbanOfferButton(appeal: ModerationAppeal, caseNumber: number): Promise<void> {
    const channelId = await this.resolveAppealsChannelId(appeal.guildId);
    if (!channelId) return;
    const guild = await this.fetchGuild(appeal.guildId);
    const channel = await resolveTextChannel(guild, channelId);
    if (!channel) return;

    await channel.send({
      content: `Appeal for case #${caseNumber} (<@${appeal.userId}>, \`${appeal.userId}\`) was accepted. Unbanning is not automatic — click below when ready.`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: 'Unban now',
              custom_id: buildCustomId('moderation', 'appeal-unban', appeal.id),
            },
          ],
        },
      ],
      allowedMentions: { parse: [] },
    });
  }

  private appealSyncLockKey(appealId: string): string {
    return redisKey('moderation', 'appeal-sync-lock', appealId);
  }

  /** Durably marks `applyAppealDecisionEffects` as done for this appeal — the source of truth `syncDashboardDecidedAppeals`
   * skips on, so it can never re-fire after a TTL cache expires or a Redis flush. */
  private async markAppealEffectsApplied(appealId: string): Promise<void> {
    await this.ctx.prisma.moderationAppeal
      .update({ where: { id: appealId }, data: { effectsAppliedAt: new Date() } })
      .catch(() => undefined);
  }

  /** Called by the `appeal-sync` repeatable job: applies Discord-side effects for appeals decided from the dashboard.
   * Only ever considers appeals reviewed in the last 24h with `effectsAppliedAt` still null — `effectsAppliedAt`
   * is a permanent DB marker (never re-applies once set, unlike the old 30-day Redis TTL cache), and a short-lived
   * Redis key is used only as an in-flight lock to avoid two overlapping sync ticks racing on the same appeal. */
  async syncDashboardDecidedAppeals(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pending = await this.ctx.prisma.moderationAppeal.findMany({
      where: { status: { in: ['ACCEPTED', 'DENIED'] }, effectsAppliedAt: null, reviewedAt: { gte: since } },
      orderBy: { reviewedAt: 'desc' },
      take: 200,
    });

    let applied = 0;
    for (const appeal of pending) {
      const lockKey = this.appealSyncLockKey(appeal.id);
      const acquired = await this.ctx.redis.set(lockKey, '1', 'PX', APPEAL_SYNC_LOCK_TTL_MS, 'NX');
      if (acquired !== 'OK') continue;
      try {
        await this.applyAppealDecisionEffects(appeal);
        await this.markAppealEffectsApplied(appeal.id);
        applied += 1;
      } catch (err) {
        this.ctx.logger.error(
          { err: String(err), appealId: appeal.id },
          'moderation: appeal-sync failed to apply a decision',
        );
      } finally {
        await this.ctx.redis.del(lockKey);
      }
    }
    return applied;
  }
}

// -----------------------------------------------------------------------
// Cursor helpers (offset-based, matching @entrophy/core's paginate() shape without importing an api-only dep)
// -----------------------------------------------------------------------

function decodeOffsetCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}
