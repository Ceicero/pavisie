// DTOs owned by the `moderation` build (ARCHITECTURE.md §5 lists `ModerationCaseDto`/`ModerationWarningDto`,
// already in `./api`; this subpath carries the rest — Notes, Appeals, and the plugin's own settings shape —
// imported as `@pavisie/types/moderation` per this package's `"./*"` subpath export).

export interface ModerationNoteDto {
  id: string;
  guildId: string;
  userId: string;
  authorId: string;
  content: string;
  createdAt: string;
  deletedAt: string | null;
}

export type ModerationAppealStatus = 'PENDING' | 'ACCEPTED' | 'DENIED';

export interface ModerationAppealDto {
  id: string;
  guildId: string;
  caseId: string | null;
  caseNumber: number | null;
  userId: string;
  content: string;
  status: ModerationAppealStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export type EscalationAction = 'timeout' | 'kick' | 'ban';

export interface EscalationRuleDto {
  warnings: number;
  action: EscalationAction;
  durationMs?: number;
}

export type RequireReasonAction = 'kick' | 'ban' | 'softban';

/** The `moderation` plugin's per-guild config (mirrors `packages/plugins/src/moderation/manifest.ts`'s `configSchema`). */
export interface ModerationSettingsDto {
  modLogChannelId: string | null;
  appealsChannelId: string | null;
  dmOnAction: boolean;
  escalations: EscalationRuleDto[];
  tempBanEnabled: boolean;
  purgeMax: number;
  requireReasonFor: RequireReasonAction[];
}
