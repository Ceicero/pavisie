// DTOs for the `roles` plugin's dashboard-facing endpoints that aren't already covered by `api.ts`'s
// `RolePanelDto`/`RolePanelOptionDto` (ARCHITECTURE.md §10). Imported via the `@pavisie/types/roles` subpath
// per this build's ownership constraints (packages/types/src/index.ts is not edited by this build).

export interface RoleGroupDto {
  id: string;
  guildId: string;
  name: string;
  roleIds: string[];
  exclusive: boolean;
  maxSelections: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WelcomeGoodbyeDto {
  enabled: boolean;
  channelId: string | null;
  message: string | null;
  embed: Record<string, unknown> | null;
  dm: boolean;
}

export type VerificationMode = 'button' | 'modal' | 'captcha';
export type UnderageAction = 'none' | 'quarantine' | 'kick';

export interface VerificationSettingsDto {
  mode: VerificationMode;
  questions: string[];
  verifiedRoleId: string | null;
  staffChannelId: string | null;
  minAccountAgeDays: number;
  underageAction: UnderageAction;
  quarantineRoleId: string | null;
}

export interface VerificationRequestDto {
  id: string;
  guildId: string;
  userId: string;
  method: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';
  answers: unknown;
  staffMessageId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface OnboardingStepDto {
  id: string;
  label: string;
}

export interface OnboardingConfigDto {
  rulesText: string | null;
  rulesRoleId: string | null;
  steps: OnboardingStepDto[];
}

export interface RolePersistenceDto {
  enabled: boolean;
  maxDays: number;
}

/** Auto-roles on join (`config.roles.autoRoles`). `note` explains that the bot re-validates each role at assignment time — the API has no gateway and cannot check role hierarchy itself. */
export interface AutoRolesDto {
  enabled: boolean;
  /** Roles given to human members (max 5). */
  roleIds: string[];
  /** Roles given to bot accounts (max 3). */
  botRoleIds: string[];
  /** 0 = immediately; otherwise a delayed job (max 604800 = 7 days). */
  delaySeconds: number;
  note: string;
}
