'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, RolePanelDto } from '@pavisie/types';
import type {
  AutoRolesDto,
  OnboardingConfigDto,
  RoleGroupDto,
  RolePersistenceDto,
  VerificationRequestDto,
  VerificationSettingsDto,
  WelcomeGoodbyeDto,
} from '@pavisie/types/roles';
import { apiFetch } from './api';

export const rolesQueryKeys = {
  panels: (guildId: string) => ['guilds', guildId, 'roles', 'panels'] as const,
  groups: (guildId: string) => ['guilds', guildId, 'roles', 'groups'] as const,
  welcome: (guildId: string) => ['guilds', guildId, 'roles', 'welcome'] as const,
  goodbye: (guildId: string) => ['guilds', guildId, 'roles', 'goodbye'] as const,
  verificationSettings: (guildId: string) =>
    ['guilds', guildId, 'roles', 'verification', 'settings'] as const,
  verificationQueue: (guildId: string) => ['guilds', guildId, 'roles', 'verification', 'queue'] as const,
  onboarding: (guildId: string) => ['guilds', guildId, 'roles', 'onboarding'] as const,
  persistence: (guildId: string) => ['guilds', guildId, 'roles', 'persistence'] as const,
  autoRoles: (guildId: string) => ['guilds', guildId, 'roles', 'autoroles'] as const,
};

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export function useRolePanels(guildId: string | undefined) {
  return useQuery({
    queryKey: rolesQueryKeys.panels(guildId ?? ''),
    queryFn: () => apiFetch<RolePanelDto[]>(`/guilds/${guildId}/roles/panels`),
    enabled: Boolean(guildId),
  });
}

export interface RolePanelOptionInput {
  roleId: string;
  label: string;
  emoji?: string | null;
  description?: string | null;
  position?: number;
}

export interface RolePanelInput {
  channelId: string;
  title: string;
  description?: string | null;
  style: 'BUTTONS' | 'SELECT' | 'REACTIONS';
  groupId?: string | null;
  maxSelections?: number | null;
  options: RolePanelOptionInput[];
}

export function useCreateRolePanel(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RolePanelInput) =>
      apiFetch<RolePanelDto>(`/guilds/${guildId}/roles/panels`, { method: 'POST', body: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rolesQueryKeys.panels(guildId) }),
  });
}

export function useUpdateRolePanel(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ panelId, ...patch }: Partial<RolePanelInput> & { panelId: string }) =>
      apiFetch<RolePanelDto>(`/guilds/${guildId}/roles/panels/${panelId}`, { method: 'PUT', body: patch }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rolesQueryKeys.panels(guildId) }),
  });
}

export function useDeleteRolePanel(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (panelId: string) =>
      apiFetch<void>(`/guilds/${guildId}/roles/panels/${panelId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rolesQueryKeys.panels(guildId) }),
  });
}

export function usePostRolePanel(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (panelId: string) =>
      apiFetch<{ ok: boolean; queued: boolean }>(`/guilds/${guildId}/roles/panels/${panelId}/post`, {
        method: 'POST',
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rolesQueryKeys.panels(guildId) }),
  });
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function useRoleGroups(guildId: string | undefined) {
  return useQuery({
    queryKey: rolesQueryKeys.groups(guildId ?? ''),
    queryFn: () => apiFetch<RoleGroupDto[]>(`/guilds/${guildId}/roles/groups`),
    enabled: Boolean(guildId),
  });
}

export interface RoleGroupInput {
  name: string;
  roleIds: string[];
  exclusive: boolean;
  maxSelections: number | null;
}

export function useCreateRoleGroup(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RoleGroupInput) =>
      apiFetch<RoleGroupDto>(`/guilds/${guildId}/roles/groups`, { method: 'POST', body: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rolesQueryKeys.groups(guildId) }),
  });
}

export function useUpdateRoleGroup(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, ...patch }: Partial<RoleGroupInput> & { groupId: string }) =>
      apiFetch<RoleGroupDto>(`/guilds/${guildId}/roles/groups/${groupId}`, { method: 'PUT', body: patch }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rolesQueryKeys.groups(guildId) }),
  });
}

export function useDeleteRoleGroup(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) =>
      apiFetch<void>(`/guilds/${guildId}/roles/groups/${groupId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rolesQueryKeys.groups(guildId) }),
  });
}

// ---------------------------------------------------------------------------
// Welcome / goodbye
// ---------------------------------------------------------------------------

export type WelcomeGoodbyePatch = Partial<WelcomeGoodbyeDto>;

export function useWelcomeConfig(guildId: string | undefined) {
  return useQuery({
    queryKey: rolesQueryKeys.welcome(guildId ?? ''),
    queryFn: () => apiFetch<WelcomeGoodbyeDto>(`/guilds/${guildId}/roles/welcome`),
    enabled: Boolean(guildId),
  });
}

export function useUpdateWelcomeConfig(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: WelcomeGoodbyePatch) =>
      apiFetch<WelcomeGoodbyeDto>(`/guilds/${guildId}/roles/welcome`, { method: 'PUT', body: patch }),
    onSuccess: (data) => queryClient.setQueryData(rolesQueryKeys.welcome(guildId), data),
  });
}

export function useTestWelcome(guildId: string) {
  return useMutation({
    mutationFn: (channelId?: string) =>
      apiFetch<{ ok: boolean; queued: boolean }>(`/guilds/${guildId}/roles/welcome/test`, {
        method: 'POST',
        body: { channelId },
      }),
  });
}

export function useGoodbyeConfig(guildId: string | undefined) {
  return useQuery({
    queryKey: rolesQueryKeys.goodbye(guildId ?? ''),
    queryFn: () => apiFetch<WelcomeGoodbyeDto>(`/guilds/${guildId}/roles/goodbye`),
    enabled: Boolean(guildId),
  });
}

export function useUpdateGoodbyeConfig(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: WelcomeGoodbyePatch) =>
      apiFetch<WelcomeGoodbyeDto>(`/guilds/${guildId}/roles/goodbye`, { method: 'PUT', body: patch }),
    onSuccess: (data) => queryClient.setQueryData(rolesQueryKeys.goodbye(guildId), data),
  });
}

export function useTestGoodbye(guildId: string) {
  return useMutation({
    mutationFn: (channelId?: string) =>
      apiFetch<{ ok: boolean; queued: boolean }>(`/guilds/${guildId}/roles/goodbye/test`, {
        method: 'POST',
        body: { channelId },
      }),
  });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function useVerificationSettings(guildId: string | undefined) {
  return useQuery({
    queryKey: rolesQueryKeys.verificationSettings(guildId ?? ''),
    queryFn: () => apiFetch<VerificationSettingsDto>(`/guilds/${guildId}/roles/verification/settings`),
    enabled: Boolean(guildId),
  });
}

export function useUpdateVerificationSettings(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<VerificationSettingsDto>) =>
      apiFetch<VerificationSettingsDto>(`/guilds/${guildId}/roles/verification/settings`, {
        method: 'PUT',
        body: patch,
      }),
    onSuccess: (data) => queryClient.setQueryData(rolesQueryKeys.verificationSettings(guildId), data),
  });
}

export function useVerificationQueue(guildId: string | undefined) {
  return useQuery({
    queryKey: rolesQueryKeys.verificationQueue(guildId ?? ''),
    queryFn: () => apiFetch<Paginated<VerificationRequestDto>>(`/guilds/${guildId}/roles/verification/queue`),
    select: (res) => res.items,
    enabled: Boolean(guildId),
    refetchInterval: 15_000,
  });
}

export function useDecideVerification(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, approve, note }: { requestId: string; approve: boolean; note?: string }) =>
      apiFetch<{ ok: boolean; queued: boolean }>(
        `/guilds/${guildId}/roles/verification/${requestId}/decide`,
        { method: 'POST', body: { approve, note } },
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: rolesQueryKeys.verificationQueue(guildId) }),
  });
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export function useOnboardingConfig(guildId: string | undefined) {
  return useQuery({
    queryKey: rolesQueryKeys.onboarding(guildId ?? ''),
    queryFn: () => apiFetch<OnboardingConfigDto>(`/guilds/${guildId}/roles/onboarding`),
    enabled: Boolean(guildId),
  });
}

export function useUpdateOnboardingConfig(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<OnboardingConfigDto>) =>
      apiFetch<OnboardingConfigDto>(`/guilds/${guildId}/roles/onboarding`, { method: 'PUT', body: patch }),
    onSuccess: (data) => queryClient.setQueryData(rolesQueryKeys.onboarding(guildId), data),
  });
}

// ---------------------------------------------------------------------------
// Role persistence
// ---------------------------------------------------------------------------

export type RolePersistenceStatusDto = RolePersistenceDto & { disclosure: string };

export function useRolePersistence(guildId: string | undefined) {
  return useQuery({
    queryKey: rolesQueryKeys.persistence(guildId ?? ''),
    queryFn: () => apiFetch<RolePersistenceStatusDto>(`/guilds/${guildId}/roles/persistence`),
    enabled: Boolean(guildId),
  });
}

export function useSetRolePersistence(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { enabled: boolean; maxDays?: number; acknowledge?: boolean }) =>
      apiFetch<RolePersistenceStatusDto>(`/guilds/${guildId}/roles/persistence`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (data) => queryClient.setQueryData(rolesQueryKeys.persistence(guildId), data),
  });
}

// ---------------------------------------------------------------------------
// Auto-roles on join
// ---------------------------------------------------------------------------

export interface AutoRolesInput {
  enabled?: boolean;
  roleIds?: string[];
  botRoleIds?: string[];
  delaySeconds?: number;
}

export function useAutoRoles(guildId: string | undefined) {
  return useQuery({
    queryKey: rolesQueryKeys.autoRoles(guildId ?? ''),
    queryFn: () => apiFetch<AutoRolesDto>(`/guilds/${guildId}/roles/autoroles`),
    enabled: Boolean(guildId),
  });
}

export function useSetAutoRoles(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AutoRolesInput) =>
      apiFetch<AutoRolesDto>(`/guilds/${guildId}/roles/autoroles`, { method: 'PUT', body: input }),
    onSuccess: (data) => queryClient.setQueryData(rolesQueryKeys.autoRoles(guildId), data),
  });
}
