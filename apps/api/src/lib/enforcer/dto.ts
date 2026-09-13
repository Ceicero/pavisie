// Maps Prisma rows to `@pavisie/types/enforcer` DTOs, mirroring the convention in `apps/api/src/lib/dto.ts`
// (kept in a separate file under our ownership rather than editing the shared one).
import type { EnforcerPolicy, EnforcerRecord } from '@pavisie/database';
import type {
  EnforcerMatcherDto,
  EnforcerPolicyDto,
  EnforcerRecordDto,
  EnforcerSettingsDto,
} from '@pavisie/types';
import type { EnforcerConfig } from '@pavisie/plugins/enforcer/manifest';

export function toEnforcerPolicyDto(row: EnforcerPolicy): EnforcerPolicyDto {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    severity: row.severity,
    matchers: (row.matchers as unknown as EnforcerMatcherDto[]) ?? [],
    channelIds: row.channelIds,
    exemptRoleIds: row.exemptRoleIds,
    exemptChannelIds: row.exemptChannelIds,
    suggestedAction: row.suggestedAction,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export function toEnforcerRecordDto(row: EnforcerRecord): EnforcerRecordDto {
  return {
    id: row.id,
    guildId: row.guildId,
    recordNumber: row.recordNumber,
    kind: row.kind,
    status: row.status,
    userId: row.userId,
    channelId: row.channelId,
    messageId: row.messageId,
    messageJumpUrl: row.messageJumpUrl,
    policyId: row.policyId,
    policyName: row.policyName,
    matcherSummary: row.matcherSummary,
    riskScore: row.riskScore,
    aiExplanation: row.aiExplanation,
    excerpt: row.excerpt,
    contextSnapshot: row.contextSnapshot,
    source: row.source,
    flaggedBy: row.flaggedBy,
    decision: row.decision,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionReason: row.decisionReason,
    durationMs: row.durationMs,
    caseId: row.caseId,
    parentRecordId: row.parentRecordId,
    ledgerMessageId: row.ledgerMessageId,
    flagMessageId: row.flagMessageId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toEnforcerSettingsDto(config: EnforcerConfig): EnforcerSettingsDto {
  return { ...config };
}
