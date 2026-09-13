// Maps Prisma rows to the shared response DTOs in `@pavisie/types` (ARCHITECTURE.md §10: "responses MUST
// match those DTO shapes"). One function per model, kept boring and explicit on purpose.
import type {
  AuditLog,
  AutomodEvent,
  AutomodRule,
  DataRequest,
  DataRetentionPolicy,
  IntegrationConnection,
  LogEvent,
  ModerationCase,
  ModerationWarning,
  RolePanel,
  RolePanelOption,
  Ticket,
  WebhookEndpoint,
} from '@pavisie/database';
import type {
  AuditLogEntryDto,
  AutomodEventDto,
  AutomodRuleDto,
  DataRequestDto,
  IntegrationConnectionDto,
  LogEventDto,
  ModerationCaseDto,
  ModerationWarningDto,
  RetentionPolicyDto,
  RolePanelDto,
  RolePanelOptionDto,
  TicketDto,
  WebhookEndpointDto,
} from '@pavisie/types';

const ACTOR_TYPE_MAP: Record<AuditLog['actorType'], AuditLogEntryDto['actorType']> = {
  USER: 'user',
  SYSTEM: 'system',
};
const AUDIT_SOURCE_MAP: Record<AuditLog['source'], AuditLogEntryDto['source']> = {
  BOT: 'bot',
  DASHBOARD: 'dashboard',
  SYSTEM: 'system',
};

export function toAuditLogEntryDto(row: AuditLog): AuditLogEntryDto {
  return {
    id: row.id,
    guildId: row.guildId,
    actorId: row.actorId,
    actorType: ACTOR_TYPE_MAP[row.actorType],
    action: row.action,
    targetType: row.targetType ?? undefined,
    targetId: row.targetId ?? undefined,
    before: row.before ?? undefined,
    after: row.after ?? undefined,
    reason: row.reason ?? undefined,
    source: AUDIT_SOURCE_MAP[row.source],
    createdAt: row.createdAt.toISOString(),
  };
}

export function toModerationCaseDto(row: ModerationCase): ModerationCaseDto {
  return {
    id: row.id,
    guildId: row.guildId,
    caseNumber: row.caseNumber,
    type: row.type,
    targetId: row.targetId,
    moderatorId: row.moderatorId,
    reason: row.reason,
    evidenceUrls: row.evidenceUrls,
    durationMs: row.durationMs,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    expiredAt: row.expiredAt ? row.expiredAt.toISOString() : null,
    dmSent: row.dmSent,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export function toModerationWarningDto(row: ModerationWarning): ModerationWarningDto {
  return {
    id: row.id,
    guildId: row.guildId,
    caseId: row.caseId,
    targetId: row.userId,
    moderatorId: row.moderatorId,
    reason: row.reason,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `AutomodRule.actions` is a Json array; `AutomodRuleDto.action` is a best-effort summary string for older consumers. */
function summarizeActions(actions: unknown): string {
  if (!Array.isArray(actions) || actions.length === 0) return 'none';
  return actions
    .map((a) =>
      a && typeof a === 'object' && 'type' in a ? String((a as { type: unknown }).type) : String(a),
    )
    .join(', ');
}

export function toAutomodRuleDto(row: AutomodRule): AutomodRuleDto {
  const actions = (row.actions as Record<string, unknown>[] | null) ?? [];
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    dryRun: row.dryRun,
    action: summarizeActions(actions),
    actions,
    config: (row.config as Record<string, unknown> | null) ?? {},
    exemptRoleIds: row.exemptRoleIds,
    exemptChannelIds: row.exemptChannelIds,
    exemptUserIds: row.exemptUserIds,
    trustedDomains: row.trustedDomains,
    cooldownSeconds: row.cooldownSeconds,
    priority: row.priority,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export function toAutomodEventDto(row: AutomodEvent): AutomodEventDto {
  const reviewStatus =
    row.reviewStatus === 'CONFIRMED'
      ? 'APPROVED'
      : row.reviewStatus === 'NONE'
        ? 'PENDING'
        : row.reviewStatus;
  return {
    id: row.id,
    guildId: row.guildId,
    ruleId: row.ruleId,
    userId: row.userId,
    channelId: row.channelId ?? '',
    action: Array.isArray(row.actionsTaken)
      ? (row.actionsTaken as unknown[]).join(', ')
      : String(row.actionsTaken ?? ''),
    dryRun: row.dryRun,
    reviewStatus: reviewStatus as AutomodEventDto['reviewStatus'],
    details: { matched: row.matched, messageId: row.messageId, riskScore: row.riskScore },
    createdAt: row.createdAt.toISOString(),
  };
}

const TICKET_STATUS_MAP: Record<Ticket['status'], TicketDto['status']> = {
  OPEN: 'open',
  CLOSED: 'closed',
  ARCHIVED: 'closed',
};

export function toTicketDto(row: Ticket): TicketDto {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    threadId: row.threadId,
    openerId: row.openerId,
    status: TICKET_STATUS_MAP[row.status],
    category: row.panelId,
    assigneeId: row.assigneeId,
    tags: row.tags,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

const ROLE_PANEL_MODE_MAP: Record<RolePanel['style'], RolePanelDto['mode']> = {
  BUTTONS: 'button',
  SELECT: 'select',
  REACTIONS: 'reaction',
};

export function toRolePanelOptionDto(row: RolePanelOption): RolePanelOptionDto {
  return { id: row.id, roleId: row.roleId, label: row.label, emoji: row.emoji, description: row.description };
}

export function toRolePanelDto(row: RolePanel & { options?: RolePanelOption[] }): RolePanelDto {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    title: row.title,
    description: row.description,
    mode: ROLE_PANEL_MODE_MAP[row.style],
    maxSelections: row.maxSelections,
    options: (row.options ?? []).map(toRolePanelOptionDto),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

/** Exported for reuse by other `ConnectionStatus`-backed rows (e.g. `TwitchChatChannel`/`TwitchBotIdentity` in `lib/integrations/dto.ts`). */
export const CONNECTION_STATUS_MAP: Record<
  IntegrationConnection['status'],
  IntegrationConnectionDto['status']
> = {
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
  PENDING: 'pending',
};

export function toIntegrationConnectionDto(row: IntegrationConnection): IntegrationConnectionDto {
  return {
    id: row.id,
    guildId: row.guildId,
    provider: row.provider,
    status: CONNECTION_STATUS_MAP[row.status],
    externalAccountId: row.externalAccountId,
    externalAccountName: row.externalAccountName,
    scopes: [],
    connectedByUserId: row.connectedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toWebhookEndpointDto(row: WebhookEndpoint): WebhookEndpointDto {
  return {
    id: row.id,
    guildId: row.guildId,
    provider: row.provider ?? 'generic',
    direction: row.direction === 'INBOUND' ? 'inbound' : 'outbound',
    url: row.url,
    active: row.enabled,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export function toLogEventDto(row: LogEvent): LogEventDto {
  return {
    id: row.id,
    guildId: row.guildId,
    kind: row.kind,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

const RETENTION_STATUS_NOTE = undefined;
void RETENTION_STATUS_NOTE;

export function toRetentionPolicyDto(row: DataRetentionPolicy): RetentionPolicyDto {
  return {
    guildId: row.guildId,
    moderationRetentionDays: row.moderationCaseDays,
    logRetentionDays: row.logEventDays,
    ticketTranscriptRetentionDays: row.ticketTranscriptDays,
    automodEventRetentionDays: row.automodEventDays,
    auditLogRetentionDays: row.auditLogDays,
    levelInactivityRetentionDays: row.levelInactivityDays,
    analyticsRetentionDays: row.analyticsDays,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DATA_REQUEST_STATUS_MAP: Record<DataRequest['status'], DataRequestDto['status']> = {
  PENDING: 'pending',
  RUNNING: 'processing',
  DONE: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export function toDataRequestDto(row: DataRequest): DataRequestDto {
  return {
    id: row.id,
    guildId: row.guildId,
    type: row.type === 'EXPORT' ? 'export' : 'delete',
    status: DATA_REQUEST_STATUS_MAP[row.status],
    requestedByUserId: row.requestedBy,
    resultUrl: row.resultUrl,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
