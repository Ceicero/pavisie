import { ChannelType, type Guild, type TextChannel } from 'discord.js';
import { AppError, NotFoundError, PermissionError, ValidationError, redisKey } from '@entrophy/core';
import { nextEnforcerRecordNumber } from '@entrophy/database/guild';
import { Prisma, type EnforcerRecord, type ModerationCase, type PrismaClient } from '@entrophy/database';
import { fetchMemberSafe, hierarchyGuard, resolveTextChannel, safeDm, type PluginContext } from '../sdk';
import type {
  EnforcerDecideInput,
  EnforcerDecideResult,
  EnforcerFlagInput,
  EnforcerFlagResult,
  EnforcerService,
} from '../sdk/services';
import { buildExcerpt, type Policy } from './engine';
import {
  buildDecidedFlagQueueComponents,
  buildFlagQueueComponents,
  buildFlagQueueEmbed,
  buildLedgerEmbed,
} from './embeds';
import type { EnforcerConfig } from './manifest';
import type { EnforcerDecisionLower, MatcherInput, PolicySeverityValue } from './schemas';

const RECORD_NUMBER_MAX_ATTEMPTS = 3;

/** Retries `create` up to 3 times on a Prisma unique-constraint violation on `[guildId, recordNumber]`, mirroring `@entrophy/database`'s `withNextCaseNumber`. */
export async function withNextRecordNumber<T>(
  prisma: PrismaClient,
  guildId: string,
  create: (recordNumber: number) => Promise<T>,
): Promise<T> {
  return withRecordNumberRetry(async () => {
    const recordNumber = await nextEnforcerRecordNumber(prisma, guildId);
    return create(recordNumber);
  });
}

/**
 * Re-runs `attempt` when it fails on the `[guildId, recordNumber]` unique constraint.
 *
 * The retry restarts the whole attempt rather than just re-issuing the failed `create`. That matters inside an
 * interactive transaction: Postgres aborts a transaction as soon as one statement violates a constraint, so a
 * second `create` on the same `tx` would fail with "current transaction is aborted" instead of taking the next
 * free number. Restarting means `decide()` opens a fresh transaction and re-reads the number.
 */
async function withRecordNumberRetry<T>(attempt: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < RECORD_NUMBER_MAX_ATTEMPTS; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  throw lastError;
}

/**
 * The next free record number, read through an interactive transaction's client. `nextEnforcerRecordNumber`
 * opens its own transaction, which `Prisma.TransactionClient` cannot do (nested transactions are unsupported),
 * so the aggregate is issued directly on `tx` instead.
 */
async function nextRecordNumberWithin(tx: Prisma.TransactionClient, guildId: string): Promise<number> {
  const max = await tx.enforcerRecord.aggregate({ where: { guildId }, _max: { recordNumber: true } });
  return (max._max.recordNumber ?? 0) + 1;
}

function rowToPolicy(row: {
  id: string;
  name: string;
  enabled: boolean;
  severity: string;
  matchers: unknown;
  channelIds: string[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
}): Policy {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    severity: row.severity as PolicySeverityValue,
    matchers: (row.matchers as MatcherInput[]) ?? [],
    channelIds: row.channelIds,
    exemptRoleIds: row.exemptRoleIds,
    exemptChannelIds: row.exemptChannelIds,
  };
}

/** Loads every enabled, non-deleted policy for `guildId`, mapped to the pure engine's `Policy` shape. */
export async function loadEnabledPolicies(prisma: PrismaClient, guildId: string): Promise<Policy[]> {
  const rows = await prisma.enforcerPolicy.findMany({ where: { guildId, enabled: true, deletedAt: null } });
  return rows.map(rowToPolicy);
}

async function fetchManagedTextChannel(guild: Guild, channelId: string | null): Promise<TextChannel | null> {
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel;
}

export interface ContextSnapshotEntry {
  authorId: string;
  at: string;
  excerpt: string;
}

/** Fetches the `count` messages immediately before `beforeMessageId` in `channel`, oldest first (ARCHITECTURE.md §19). */
export async function buildContextSnapshot(
  guild: Guild,
  channelId: string,
  beforeMessageId: string,
  count: number,
  excerptMaxChars: number,
): Promise<ContextSnapshotEntry[]> {
  if (count <= 0) return [];
  const channel = await resolveTextChannel(guild, channelId);
  if (!channel || !('messages' in channel)) return [];
  const fetched = await channel.messages.fetch({ before: beforeMessageId, limit: count }).catch(() => null);
  if (!fetched) return [];
  return [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((m) => ({
      authorId: m.author.id,
      at: m.createdAt.toISOString(),
      excerpt: buildExcerpt(m.content ?? '', excerptMaxChars),
    }));
}

const AI_ASSIST_SYSTEM_PROMPT =
  'You are a content-moderation risk assessor for a Discord community. Given a flagged message and (optionally) which server policy it matched, respond with EXACTLY two lines and nothing else:\nRisk: <integer 0-100, how likely this genuinely violates the policy/community norms>\nExplanation: <one short, plain-language sentence>';

const AI_ASSIST_MAX_TOKENS = 80;

export interface AiAssistResult {
  riskScore: number;
  explanation: string;
}

/** Parses the two-line `Risk: NN` / `Explanation: ...` response format `AI_ASSIST_SYSTEM_PROMPT` asks for. Returns `null` on anything that doesn't match (a bad/unexpected model response should mean "no score", never a wrong one). */
export function parseAiAssistResponse(text: string): AiAssistResult | null {
  const riskMatch = /risk:\s*(\d{1,3})/i.exec(text);
  const explanationMatch = /explanation:\s*(.+)/i.exec(text);
  if (!riskMatch) return null;
  const riskScore = Math.max(0, Math.min(100, Number(riskMatch[1])));
  if (!Number.isFinite(riskScore)) return null;
  const explanation = explanationMatch?.[1]?.trim().slice(0, 300) || 'No explanation provided.';
  return { riskScore, explanation };
}

/**
 * `config.aiAssist` (enforcer settings/status, dashboard, website FAQ): best-effort annotation only — a risk
 * score and one-sentence explanation attached to a flag for a moderator to read, never a decision. Returns
 * `null` (silently, logging a warning) on any failure — a missing/unavailable `ai` service, a budget/cooldown
 * rejection, a malformed response — since scoring is advisory and must never block or fail a flag.
 */
async function computeAiAssist(
  ctx: PluginContext,
  guildId: string,
  userId: string,
  policyName: string | undefined,
  content: string,
): Promise<AiAssistResult | null> {
  const ai = ctx.services.get('ai');
  if (!ai) return null;

  try {
    const result = await ai.complete({
      guildId,
      userId,
      command: 'enforcer-ai-assist',
      system: AI_ASSIST_SYSTEM_PROMPT,
      prompt: `Policy: ${policyName ?? 'general server rules'}\nMessage: """${content.slice(0, 2000)}"""`,
      maxTokens: AI_ASSIST_MAX_TOKENS,
    });
    return parseAiAssistResponse(result.text);
  } catch (err) {
    ctx.logger.warn(
      { err: String(err), guildId },
      'enforcer: AI assist scoring failed — flagging without a risk score',
    );
    return null;
  }
}

export interface FlagRecordInput {
  guildId: string;
  userId: string;
  channelId?: string;
  messageId?: string;
  /** Raw text to build the sanitized excerpt from — the message content for message-based flags, or the free-text reason for a non-message manual flag. */
  content?: string;
  policyId?: string;
  policyName?: string;
  severity?: PolicySeverityValue;
  matcherSummary?: string;
  suggestedAction?: string | null;
  riskScore?: number;
  aiExplanation?: string;
  source: 'AUTO' | 'MANUAL' | 'AI_ASSIST' | 'DASHBOARD';
  flaggedBy?: string;
}

export interface FlagRecordResult {
  recordId: string;
  recordNumber: number;
}

/**
 * Core flag-creation flow shared by auto-flagging (`events/message-create.ts`), manual flagging
 * (`commands/flag.ts`, the "Flag for review" context menu), and the public `EnforcerService.flag` (dashboard,
 * `/enforcer flag`): allocates a record number, captures an excerpt/context snapshot, posts a ledger entry,
 * and posts the flag-queue embed with decision buttons (ARCHITECTURE.md §19).
 */
export async function flagRecord(ctx: PluginContext, input: FlagRecordInput): Promise<FlagRecordResult> {
  const config = await ctx.getConfig<EnforcerConfig>(input.guildId);
  const guild = await ctx.client.guilds.fetch(input.guildId).catch(() => null);
  if (!guild) {
    throw new AppError('guild_unreachable', 'Entrophy could not reach that server right now.', {
      status: 502,
      expose: true,
    });
  }

  const messageJumpUrl =
    input.channelId && input.messageId
      ? `https://discord.com/channels/${input.guildId}/${input.channelId}/${input.messageId}`
      : null;
  // Gated on `captureContext`, same as `contextSnapshot` below — the manifest, README, dashboard, and
  // `/enforcer status` all promise that turning context capture off leaves flags with only a jump link, no
  // stored excerpt.
  const excerpt =
    config.captureContext && input.content ? buildExcerpt(input.content, config.excerptMaxChars) : null;

  let contextSnapshot: ContextSnapshotEntry[] | null = null;
  if (config.captureContext && input.channelId && input.messageId) {
    contextSnapshot = await buildContextSnapshot(
      guild,
      input.channelId,
      input.messageId,
      config.contextBefore,
      config.excerptMaxChars,
    );
  }

  // AI assist: when enabled (and a caller hasn't already supplied its own score), ask the `ai` service for a
  // short risk assessment of the flagged content. Best-effort only — never lets a scoring failure block the
  // flag itself, and the AI's opinion is annotation only (it never decides or acts, per the manifest/FAQ copy).
  let riskScore = input.riskScore;
  let aiExplanation = input.aiExplanation;
  if (config.aiAssist && riskScore === undefined && input.content) {
    const assisted = await computeAiAssist(ctx, input.guildId, input.userId, input.policyName, input.content);
    if (assisted) {
      riskScore = assisted.riskScore;
      aiExplanation = assisted.explanation;
    }
  }

  const { recordId, recordNumber } = await withNextRecordNumber(
    ctx.prisma,
    input.guildId,
    async (recordNumber) => {
      const row = await ctx.prisma.enforcerRecord.create({
        data: {
          guildId: input.guildId,
          recordNumber,
          kind: 'FLAG',
          status: 'PENDING',
          userId: input.userId,
          channelId: input.channelId ?? null,
          messageId: input.messageId ?? null,
          messageJumpUrl,
          policyId: input.policyId ?? null,
          policyName: input.policyName ?? null,
          matcherSummary: input.matcherSummary ?? null,
          riskScore: riskScore ?? null,
          aiExplanation: aiExplanation ?? null,
          excerpt,
          contextSnapshot: contextSnapshot
            ? (contextSnapshot as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          source: input.source,
          flaggedBy: input.flaggedBy ?? null,
        },
      });
      return { recordId: row.id, recordNumber: row.recordNumber };
    },
  );

  const createdAt = new Date();

  const ledgerChannel = await fetchManagedTextChannel(guild, config.ledgerChannelId);
  if (ledgerChannel) {
    const embed = buildLedgerEmbed({
      recordNumber,
      kind: 'FLAG',
      userId: input.userId,
      createdAt,
      action: 'Flagged',
      policyName: input.policyName,
      excerpt,
      messageJumpUrl,
      source: input.source,
    });
    await ledgerChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
      ctx.logger.warn({ err, guildId: input.guildId, recordId }, 'enforcer: failed to post ledger entry');
    });
  }

  const flagChannel = await fetchManagedTextChannel(guild, config.flagChannelId);
  let flagMessageId: string | null = null;
  if (flagChannel) {
    const embed = buildFlagQueueEmbed({
      recordId,
      recordNumber,
      userId: input.userId,
      createdAt,
      severity: input.severity ?? 'MEDIUM',
      policyName: input.policyName,
      matcherSummary: input.matcherSummary,
      suggestedAction: input.suggestedAction,
      excerpt,
      messageJumpUrl,
      source: input.source,
      riskScore,
      aiExplanation,
    });
    const components = buildFlagQueueComponents(recordId, config.allowedDecisions);
    const message = await flagChannel
      .send({ embeds: [embed], components, allowedMentions: { parse: [] } })
      .catch((err) => {
        ctx.logger.warn(
          { err, guildId: input.guildId, recordId },
          'enforcer: failed to post flag-queue entry',
        );
        return null;
      });
    flagMessageId = message?.id ?? null;
    if (flagMessageId) {
      await ctx.prisma.enforcerRecord.update({ where: { id: recordId }, data: { flagMessageId } });
    }
  }

  ctx.events.emit('enforcer.flagged', {
    guildId: input.guildId,
    recordId,
    recordNumber,
    userId: input.userId,
    policyId: input.policyId,
    source: input.source,
  });

  return { recordId, recordNumber };
}

const DECIDE_LOCK_TTL_MS = 30_000;

function decisionActionLabel(decision: string, durationMs?: number | null): string {
  if (decision === 'TIMEOUT' && durationMs) return `Timeout (${Math.round(durationMs / 60000)}m)`;
  if (decision === 'MUTE' && durationMs) return `Mute (${Math.round(durationMs / 60000)}m)`;
  if (decision === 'MUTE') return 'Mute (indefinite)';
  const labels: Record<string, string> = {
    WARN: 'Warn',
    TIMEOUT: 'Timeout',
    UNMUTE: 'Unmute',
    KICK: 'Kick',
    BAN: 'Ban',
    DISMISS: 'Dismissed',
  };
  return labels[decision] ?? decision;
}

function buildDmContent(
  recordNumber: number,
  caseNumber: number | undefined,
  decision: string,
  reason: string | undefined,
): string {
  const lines = [
    `A moderator on this server has taken an action on your account: **${decisionActionLabel(decision)}**.`,
    reason ? `Reason: ${reason}` : undefined,
    caseNumber !== undefined
      ? `Case #${caseNumber} · Record #E-${recordNumber}`
      : `Record #E-${recordNumber}`,
    `If you believe this was a mistake, you can appeal with \`/enforcer appeal record:${recordNumber}\` (or \`/appeal\` with the case number) on the server.`,
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

/**
 * Normalizes `decide`'s single argument: a direct `EnforcerDecideInput` call (from this plugin's own decide
 * button/modal handlers) is passed through unchanged; a `bot-actions` worker call (dashboard decisions,
 * ARCHITECTURE.md §9's `apps/bot/src/host/bot-actions.ts` dispatch convention of
 * `{ guildId, payload, requestedBy }`) is unwrapped into the same flat shape.
 */
function normalizeDecideInput(
  raw: EnforcerDecideInput | { guildId: string; payload: unknown; requestedBy?: string },
): EnforcerDecideInput {
  if (raw && typeof raw === 'object' && 'payload' in raw && raw.payload && typeof raw.payload === 'object') {
    const payload = raw.payload as Partial<EnforcerDecideInput>;
    return {
      guildId: raw.guildId,
      recordId: String(payload.recordId ?? ''),
      decision: payload.decision as EnforcerDecideInput['decision'],
      moderatorId: raw.requestedBy ?? String(payload.moderatorId ?? ''),
      reason: payload.reason,
      durationMs: payload.durationMs,
      banDeleteMessageSeconds: payload.banDeleteMessageSeconds,
      source: 'dashboard',
    };
  }
  return raw as EnforcerDecideInput;
}

async function editFlagQueueMessage(
  ctx: PluginContext,
  guild: Guild,
  config: EnforcerConfig,
  record: EnforcerRecord,
  decidedBy: string,
): Promise<void> {
  if (!record.flagMessageId) return;
  const flagChannel = await fetchManagedTextChannel(guild, config.flagChannelId);
  if (!flagChannel) return;
  const message = await flagChannel.messages.fetch(record.flagMessageId).catch(() => null);
  if (!message) return;

  const embed = buildFlagQueueEmbed({
    recordId: record.id,
    recordNumber: record.recordNumber,
    userId: record.userId,
    createdAt: record.createdAt,
    severity: 'MEDIUM',
    policyName: record.policyName,
    matcherSummary: record.matcherSummary,
    excerpt: record.excerpt,
    messageJumpUrl: record.messageJumpUrl,
    source: record.source,
    riskScore: record.riskScore,
    aiExplanation: record.aiExplanation,
    decidedBy,
    decidedAt: new Date(),
  });
  const components = buildDecidedFlagQueueComponents(record.id, config.allowedDecisions);
  await message.edit({ embeds: [embed], components }).catch((err) => {
    ctx.logger.warn(
      { err, recordId: record.id },
      'enforcer: failed to edit flag-queue message after decision',
    );
  });
}

/**
 * Duck-typed mirror of moderation/service.ts's `EscalationOutcome` — kept local rather than imported, since
 * plugins talk to each other only through `ctx.services` (see `ServiceMap.moderation` in sdk/services.ts), not
 * direct cross-plugin imports. `moderation.warn()`'s declared return type is still plain `ModerationCase`; at
 * runtime it may carry this extra `escalation` field, which is why callers below read it via an explicit
 * `ModerationCase & { escalation?: WarnEscalationOutcome }` variable type rather than a cast.
 */
interface WarnEscalationOutcome {
  rule: { warnings: number; action: 'timeout' | 'kick' | 'ban'; durationMs?: number };
  case: ModerationCase;
}

/**
 * An Enforcer WARN decision runs the moderator's action through `moderation.warn()`, which can itself
 * auto-fire the guild's warning-escalation ladder and create a second `ModerationCase` (timeout/kick/ban) with
 * no Enforcer involvement — no `EnforcerRecord`, no ledger post, so a moderator reading the ledger sees the
 * warn but not what followed it (README: "every flag and every decision is written to a read-only ledger
 * channel and to the database"). When `escalation` is present this writes a second DECISION record — linked to
 * the same flag via `parentRecordId` and to the escalated case via `caseId`, reusing the existing
 * DECISION/ACTIONED/AUTO enum values (no schema change) — and posts a matching ledger-channel entry.
 * Best-effort only: by the time this runs, the warn itself (case + primary decision record) has already
 * succeeded, so a failure here is logged, never thrown back at the moderator.
 */
async function recordEscalatedAction(
  ctx: PluginContext,
  guild: Guild,
  config: EnforcerConfig,
  flagRecordId: string,
  moderatorId: string,
  escalation: WarnEscalationOutcome,
): Promise<void> {
  const decision = escalation.rule.action.toUpperCase() as 'TIMEOUT' | 'KICK' | 'BAN';
  const durationMs = escalation.rule.durationMs ?? null;
  const decisionReason =
    `Automatic escalation from a Warn decision: reached ${escalation.rule.warnings} active warning(s).`;

  try {
    const escalationRecord = await withNextRecordNumber(ctx.prisma, escalation.case.guildId, (recordNumber) =>
      ctx.prisma.enforcerRecord.create({
        data: {
          guildId: escalation.case.guildId,
          recordNumber,
          kind: 'DECISION',
          status: 'ACTIONED',
          userId: escalation.case.targetId,
          decision,
          decidedBy: moderatorId,
          decidedAt: new Date(),
          decisionReason,
          durationMs,
          caseId: escalation.case.id,
          parentRecordId: flagRecordId,
          source: 'AUTO',
        },
      }),
    );

    const ledgerChannel = await fetchManagedTextChannel(guild, config.ledgerChannelId);
    if (!ledgerChannel) return;
    const embed = buildLedgerEmbed({
      recordNumber: escalationRecord.recordNumber,
      kind: 'DECISION',
      userId: escalation.case.targetId,
      createdAt: escalationRecord.createdAt,
      action: `${decisionActionLabel(decision, durationMs)} — automatic escalation`,
      decidedBy: moderatorId,
      caseNumber: escalation.case.caseNumber,
      source: 'AUTO',
    });
    await ledgerChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
      ctx.logger.warn(
        { err, guildId: escalation.case.guildId, caseId: escalation.case.id },
        'enforcer: failed to post escalation ledger entry',
      );
    });
  } catch (err) {
    ctx.logger.error(
      { err: String(err), guildId: escalation.case.guildId, flagRecordId, caseId: escalation.case.id },
      'enforcer: failed to record an automatic warn-escalation in the ledger',
    );
  }
}

/** Builds the `EnforcerService` implementation registered in `onLoad` (ARCHITECTURE.md §19). */
export function createEnforcerService(ctx: PluginContext): EnforcerService {
  return {
    async flag(input: EnforcerFlagInput): Promise<EnforcerFlagResult> {
      let policyName: string | undefined;
      let severity: PolicySeverityValue | undefined;
      let suggestedAction: string | null | undefined;

      if (input.policyId) {
        const policy = await ctx.prisma.enforcerPolicy.findFirst({
          where: { id: input.policyId, guildId: input.guildId, deletedAt: null },
        });
        if (policy) {
          policyName = policy.name;
          severity = policy.severity as PolicySeverityValue;
          suggestedAction = policy.suggestedAction ?? undefined;
        }
      }

      const result = await flagRecord(ctx, {
        guildId: input.guildId,
        userId: input.userId,
        channelId: input.channelId,
        messageId: input.messageId,
        content: input.reason,
        policyId: input.policyId,
        policyName,
        severity,
        suggestedAction,
        source: input.source,
        flaggedBy: input.moderatorId,
      });

      return result;
    },

    async decide(
      rawInput: EnforcerDecideInput | { guildId: string; payload: unknown; requestedBy?: string },
    ): Promise<EnforcerDecideResult> {
      const input = normalizeDecideInput(rawInput);
      if (!input.recordId || !input.decision) {
        throw new ValidationError('A record id and decision are required.');
      }

      const config = await ctx.getConfig<EnforcerConfig>(input.guildId);
      const lockKey = redisKey('enforcer', 'lock', input.recordId);
      const acquired = await ctx.redis.set(lockKey, input.moderatorId, 'PX', DECIDE_LOCK_TTL_MS, 'NX');
      if (acquired !== 'OK') {
        throw new AppError('enforcer_locked', 'This flag is already being decided by another moderator.', {
          status: 409,
          expose: true,
        });
      }

      try {
        const record = await ctx.prisma.enforcerRecord.findFirst({
          where: { id: input.recordId, guildId: input.guildId, kind: 'FLAG' },
        });
        if (!record) throw new NotFoundError('That flag record could not be found.');
        if (record.status !== 'PENDING')
          throw new AppError('enforcer_already_decided', 'This flag has already been decided.', {
            status: 409,
            expose: true,
          });

        // UNMUTE isn't one of the flag-queue decision buttons (ARCHITECTURE.md §19 lists Warn/Timeout/Mute/Kick/Ban/Dismiss
        // only) — it only ever arrives via `/enforcer unmute`, so it isn't governed by `allowedDecisions`/`requireReasonOn`
        // (both of which are typed over exactly those six decisions).
        if (input.decision !== 'UNMUTE') {
          const decisionLower = input.decision.toLowerCase() as EnforcerDecisionLower;
          if (!config.allowedDecisions.includes(decisionLower)) {
            throw new PermissionError(`The "${input.decision}" decision is disabled on this server.`);
          }
          if (
            config.requireReasonOn.includes(decisionLower as 'warn' | 'timeout' | 'mute' | 'kick' | 'ban') &&
            !input.reason?.trim()
          ) {
            throw new ValidationError(`A reason is required to ${decisionLower} this user.`);
          }
        }

        const moderation = ctx.services.get('moderation');
        if (!moderation) {
          throw new AppError(
            'service_unavailable',
            'The moderation plugin is not enabled — decisions cannot be recorded without it.',
            { status: 503, expose: true },
          );
        }

        const guild = await ctx.client.guilds.fetch(input.guildId);
        const actionSource: 'BOT' | 'DASHBOARD' = input.source === 'dashboard' ? 'DASHBOARD' : 'BOT';

        let caseId: string | undefined;
        let caseNumber: number | undefined;
        let durationMs = input.durationMs;
        let escalationOutcome: WarnEscalationOutcome | null = null;

        const targetMember = await fetchMemberSafe(guild, record.userId);
        const actorMember = await fetchMemberSafe(guild, input.moderatorId);
        // Fails closed: for BAN the target may legitimately have already left the server (`targetMember` null
        // is fine), but the *actor* must always resolve to a real member — a fetch failure or an actor who left
        // the guild must not silently skip the hierarchy check.
        const guardTarget = () => {
          if (!actorMember) {
            throw new PermissionError(
              'Your server membership could not be verified, so this action was blocked.',
            );
          }
          if (targetMember) {
            hierarchyGuard({ guild, member: actorMember }, targetMember, ctx.botOwnerIds, ctx.t);
          }
        };

        switch (input.decision) {
          case 'WARN': {
            guardTarget();
            // `moderation.warn()`'s declared return type is plain `ModerationCase` — this widened variable
            // type is how the (possibly-present) `escalation` field the implementation actually attaches gets
            // read back out; see `WarnEscalationOutcome`'s doc comment above.
            const created: ModerationCase & { escalation?: WarnEscalationOutcome } = await moderation.warn({
              guildId: input.guildId,
              targetId: record.userId,
              moderatorId: input.moderatorId,
              reason: input.reason,
              source: actionSource,
              dmUser: false,
            });
            caseId = created.id;
            caseNumber = created.caseNumber;
            escalationOutcome = created.escalation ?? null;
            break;
          }
          case 'TIMEOUT': {
            guardTarget();
            durationMs = durationMs ?? config.defaultTimeoutMinutes * 60_000;
            const created = await moderation.timeout({
              guildId: input.guildId,
              targetId: record.userId,
              moderatorId: input.moderatorId,
              durationMs,
              reason: input.reason,
              source: actionSource,
              dmUser: false,
            });
            caseId = created.id;
            caseNumber = created.caseNumber;
            break;
          }
          case 'KICK': {
            guardTarget();
            // Do not swallow the Discord API failure (missing KickMembers, role hierarchy, etc.) — a case,
            // ledger entry, and user DM must never be recorded for an action that never actually happened.
            // A target who already left is the same thing by another route: there is nobody to kick, so refuse
            // rather than fall through and book a phantom KICK. (BAN below is the exception — it works on a
            // user who has left, so it lets `guild.members.ban` speak for itself.)
            if (!targetMember) {
              throw new ValidationError('They are no longer in this server, so there is nothing to kick.');
            }
            await targetMember.kick(input.reason);
            const created = await moderation.createCase({
              guildId: input.guildId,
              type: 'KICK',
              targetId: record.userId,
              moderatorId: input.moderatorId,
              reason: input.reason,
              source: actionSource,
              dmUser: false,
            });
            caseId = created.id;
            caseNumber = created.caseNumber;
            break;
          }
          case 'BAN': {
            guardTarget();
            await guild.members.ban(record.userId, {
              deleteMessageSeconds: input.banDeleteMessageSeconds ?? config.banDeleteMessageSeconds,
              reason: input.reason,
            });
            const created = await moderation.createCase({
              guildId: input.guildId,
              type: 'BAN',
              targetId: record.userId,
              moderatorId: input.moderatorId,
              reason: input.reason,
              source: actionSource,
              dmUser: false,
            });
            caseId = created.id;
            caseNumber = created.caseNumber;
            break;
          }
          case 'MUTE': {
            if (!config.muteRoleId)
              throw new ValidationError('No mute role is configured. Run `/enforcer setup` first.');
            guardTarget();
            // Same rule as KICK: no member, no role to add, so no case/ledger row claiming they were muted.
            // (A rejoining user comes back with no roles anyway, so the recorded mute would never take effect.)
            if (!targetMember) {
              throw new ValidationError(
                'They are no longer in this server, so the mute role could not be applied.',
              );
            }
            await targetMember.roles.add(config.muteRoleId, input.reason);
            durationMs =
              durationMs ?? (config.defaultMuteMinutes ? config.defaultMuteMinutes * 60_000 : undefined);
            const created = await moderation.createCase({
              guildId: input.guildId,
              type: 'ROLE_ADD',
              targetId: record.userId,
              moderatorId: input.moderatorId,
              reason: input.reason,
              durationMs,
              source: actionSource,
              dmUser: false,
              metadata: { enforcerMute: true, roleId: config.muteRoleId },
            });
            caseId = created.id;
            caseNumber = created.caseNumber;
            break;
          }
          case 'UNMUTE': {
            if (!config.muteRoleId)
              throw new ValidationError('No mute role is configured. Run `/enforcer setup` first.');
            if (targetMember)
              await targetMember.roles.remove(config.muteRoleId, input.reason).catch(() => undefined);
            // Mark the original timed-mute case (if any) as expired now that it was manually lifted, so the
            // moderation expire/sweep jobs (which also enforce enforcer mutes — see moderation/service.ts) don't
            // try to remove the role again later.
            await ctx.prisma.moderationCase.updateMany({
              where: {
                guildId: input.guildId,
                targetId: record.userId,
                type: 'ROLE_ADD',
                expiredAt: null,
                metadata: { path: ['enforcerMute'], equals: true },
              },
              data: { expiredAt: new Date() },
            });
            const created = await moderation.createCase({
              guildId: input.guildId,
              type: 'ROLE_REMOVE',
              targetId: record.userId,
              moderatorId: input.moderatorId,
              reason: input.reason,
              source: actionSource,
              dmUser: false,
              metadata: { enforcerMute: true, roleId: config.muteRoleId },
            });
            caseId = created.id;
            caseNumber = created.caseNumber;
            break;
          }
          case 'DISMISS':
            break;
          default:
            throw new ValidationError(`Unknown decision "${String(input.decision)}".`);
        }

        if (config.dmOnAction && input.decision !== 'DISMISS' && targetMember) {
          await safeDm(
            targetMember.user,
            buildDmContent(record.recordNumber, caseNumber, input.decision, input.reason),
          );
        }

        // BUG FIX: the Discord moderation action above already happened and cannot be rolled back — from here
        // on, a database failure must never leave the DECISION record without the matching FLAG-row update (or
        // vice versa), which is exactly what let a moderator's retry double-apply WARN/TIMEOUT/BAN after a
        // transient write failure. Both writes now happen inside one interactive transaction, so the database
        // can only ever end up fully updated or fully unchanged.
        let decisionRow: EnforcerRecord;
        try {
          // The retry wraps the whole transaction: a record-number collision aborts it, so the next attempt has
          // to start a fresh one and re-read the number.
          decisionRow = await withRecordNumberRetry(() =>
            ctx.prisma.$transaction(async (tx) => {
              const recordNumber = await nextRecordNumberWithin(tx, input.guildId);
              const created = await tx.enforcerRecord.create({
                data: {
                  guildId: input.guildId,
                  recordNumber,
                  kind: 'DECISION',
                  status: input.decision === 'DISMISS' ? 'DISMISSED' : 'ACTIONED',
                  userId: record.userId,
                  channelId: record.channelId,
                  messageId: record.messageId,
                  messageJumpUrl: record.messageJumpUrl,
                  policyId: record.policyId,
                  policyName: record.policyName,
                  decision: input.decision,
                  decidedBy: input.moderatorId,
                  decidedAt: new Date(),
                  decisionReason: input.reason ?? null,
                  durationMs: durationMs ?? null,
                  caseId: caseId ?? null,
                  parentRecordId: record.id,
                  // The DECISION row's source describes how the *decision* was made (a human clicking buttons in
                  // Discord vs. the dashboard) — distinct from the FLAG row's source (how the flag was raised).
                  source: input.source === 'dashboard' ? 'DASHBOARD' : 'MANUAL',
                },
              });

              await tx.enforcerRecord.update({
                where: { id: record.id },
                data: {
                  status: input.decision === 'DISMISS' ? 'DISMISSED' : 'ACTIONED',
                  decision: input.decision,
                  decidedBy: input.moderatorId,
                  decidedAt: new Date(),
                  decisionReason: input.reason ?? null,
                  durationMs: durationMs ?? null,
                  caseId: caseId ?? null,
                },
              });

              return created;
            }),
          );
        } catch (err) {
          // The Discord action (and, for WARN/TIMEOUT/KICK/BAN/MUTE, the ModerationCase it created) already
          // succeeded — this is NOT a "nothing happened, safe to retry" failure, so it must never surface as
          // the generic error message (which is exactly what invited the double-apply in the first place).
          ctx.logger.error(
            {
              err: String(err),
              guildId: input.guildId,
              recordId: record.id,
              decision: input.decision,
              caseId,
            },
            'enforcer: decision database write failed after the Discord action already succeeded',
          );
          throw new AppError('enforcer_action_not_recorded', ctx.t('decide.actionAppliedRecordingFailed'), {
            status: 500,
            expose: true,
          });
        }

        await editFlagQueueMessage(ctx, guild, config, record, input.moderatorId);

        const ledgerChannel = await fetchManagedTextChannel(guild, config.ledgerChannelId);
        if (ledgerChannel) {
          const embed = buildLedgerEmbed({
            recordNumber: decisionRow.recordNumber,
            kind: 'DECISION',
            userId: record.userId,
            createdAt: decisionRow.createdAt,
            action: decisionActionLabel(input.decision, durationMs),
            decidedBy: input.moderatorId,
            policyName: record.policyName,
            caseNumber,
            excerpt: record.excerpt,
            messageJumpUrl: record.messageJumpUrl,
            source: actionSource,
          });
          await ledgerChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
            ctx.logger.warn(
              { err, guildId: input.guildId },
              'enforcer: failed to post decision ledger entry',
            );
          });
        }

        // BUG FIX: a WARN that tripped the guild's warning-escalation ladder gets its own ledger entry too —
        // see `recordEscalatedAction`'s doc comment. No-op when `moderation.warn()` didn't report an escalation.
        if (escalationOutcome) {
          await recordEscalatedAction(ctx, guild, config, record.id, input.moderatorId, escalationOutcome);
        }

        await ctx.audit({
          guildId: input.guildId,
          actorId: input.moderatorId,
          actorType: 'user',
          action: 'enforcer.decision.create',
          targetType: 'enforcer_record',
          targetId: record.id,
          after: { decision: input.decision, caseId, caseNumber, reason: input.reason },
          source: input.source === 'dashboard' ? 'dashboard' : 'bot',
        });

        ctx.events.emit('enforcer.decided', {
          guildId: input.guildId,
          recordId: record.id,
          recordNumber: record.recordNumber,
          userId: record.userId,
          decision: input.decision,
          moderatorId: input.moderatorId,
          caseId,
        });

        return { recordNumber: record.recordNumber };
      } finally {
        await ctx.redis.del(lockKey);
      }
    },

    async repairChannels(
      guildIdInput: string | { guildId: string },
    ): Promise<{ muteApplied: number; muteFailed: number }> {
      const guildId = typeof guildIdInput === 'string' ? guildIdInput : guildIdInput.guildId;
      const { applyFlagQueueOverwrites, applyLedgerOverwrites, applyMuteRoleToChannels } = await import(
        './channels'
      );

      const config = await ctx.getConfig<EnforcerConfig>(guildId);
      const guild = await ctx.client.guilds.fetch(guildId);
      const host = ctx.services.require('host');
      const guildConfig = await host.getGuildConfig(guildId);
      const staffRoleIds = [
        ...guildConfig.adminRoleIds,
        ...guildConfig.modRoleIds,
        ...guildConfig.helperRoleIds,
      ];

      const ledgerChannel = await fetchManagedTextChannel(guild, config.ledgerChannelId);
      if (ledgerChannel) await applyLedgerOverwrites(ledgerChannel, config.ledgerVisibility, staffRoleIds);

      const flagChannel = await fetchManagedTextChannel(guild, config.flagChannelId);
      if (flagChannel) await applyFlagQueueOverwrites(flagChannel, staffRoleIds);

      // Re-apply the mute-role deny-overwrites too, same as `/enforcer setup`'s initial bulk apply — a repair
      // should put every channel's overwrites (ledger, flag queue, and mute role) back in sync in one go. Skip
      // silently (0/0) when no mute role is configured, or when the configured role no longer exists (deleted
      // out-of-band) — there is nothing to re-apply in either case.
      let muteApplied = 0;
      let muteFailed = 0;
      if (config.muteRoleId) {
        const role = await guild.roles.fetch(config.muteRoleId).catch(() => null);
        if (role) {
          const result = await applyMuteRoleToChannels(guild, role);
          muteApplied = result.applied;
          muteFailed = result.failed;
        }
      }

      return { muteApplied, muteFailed };
    },
  };
}
