// Maps Prisma rows / plugin config sections to the `roles`-specific DTOs in `@pavisie/types/roles`
// (ARCHITECTURE.md §10). `RolePanelDto`/`RolePanelOptionDto` already live in the shared `lib/dto.ts` — this
// file only covers what that one doesn't (groups, welcome/goodbye, verification, onboarding, persistence).
import type { RoleGroup, VerificationRequest } from '@pavisie/database';
import type {
  OnboardingConfigDto,
  RoleGroupDto,
  VerificationRequestDto,
  WelcomeGoodbyeDto,
} from '@pavisie/types/roles';
import type { RolesConfig, WelcomeGoodbyeConfig } from '@pavisie/plugins/roles/manifest';

export function toRoleGroupDto(row: RoleGroup): RoleGroupDto {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    roleIds: row.roleIds,
    exclusive: row.exclusive,
    maxSelections: row.maxSelections,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toWelcomeGoodbyeDto(section: WelcomeGoodbyeConfig): WelcomeGoodbyeDto {
  return {
    enabled: section.enabled,
    channelId: section.channelId,
    message: section.message,
    embed: (section.embed as Record<string, unknown> | null) ?? null,
    dm: section.dm,
  };
}

export function toVerificationRequestDto(row: VerificationRequest): VerificationRequestDto {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    method: row.method,
    status: row.status,
    answers: row.answers,
    staffMessageId: row.staffMessageId,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toOnboardingConfigDto(config: RolesConfig): OnboardingConfigDto {
  return { rulesText: config.rulesText, rulesRoleId: config.rulesRoleId, steps: config.steps };
}
