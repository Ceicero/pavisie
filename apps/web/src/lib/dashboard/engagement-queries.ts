'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated } from '@pavisie/types';
import type {
  EngagementConfigDto,
  LevelProfileDto,
  LevelRewardDto,
  ReputationLeaderboardEntryDto,
} from '@pavisie/types/engagement';
import { apiFetch, toQueryString } from './api';

/** Own query-key namespace for the engagement plugin, kept separate from the shared `queryKeys` in `./queries.ts` (which this app must not edit). */
export const engagementQueryKeys = {
  config: (guildId: string) => ['guilds', guildId, 'engagement', 'config'] as const,
  leaderboard: (guildId: string, cursor?: string) =>
    ['guilds', guildId, 'engagement', 'leaderboard', cursor ?? null] as const,
  rewards: (guildId: string) => ['guilds', guildId, 'engagement', 'rewards'] as const,
  repLeaderboard: (guildId: string, cursor?: string) =>
    ['guilds', guildId, 'engagement', 'rep-leaderboard', cursor ?? null] as const,
};

// ---------------------------------------------------------------------------
// Config (leveling + reputation + starboard + temp voice settings all live in one blob).
// ---------------------------------------------------------------------------

export function useEngagementConfig(guildId: string | undefined) {
  return useQuery({
    queryKey: engagementQueryKeys.config(guildId ?? ''),
    queryFn: () => apiFetch<EngagementConfigDto>(`/guilds/${guildId}/engagement/config`),
    enabled: Boolean(guildId),
  });
}

export function useUpdateEngagementConfig(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<EngagementConfigDto>) =>
      apiFetch<EngagementConfigDto>(`/guilds/${guildId}/engagement/config`, { method: 'PUT', body: patch }),
    onSuccess: (data) => {
      queryClient.setQueryData(engagementQueryKeys.config(guildId), data);
    },
  });
}

// ---------------------------------------------------------------------------
// Leveling leaderboard + XP adjustment.
// ---------------------------------------------------------------------------

export function useLevelLeaderboard(guildId: string | undefined, cursor?: string) {
  return useQuery({
    queryKey: engagementQueryKeys.leaderboard(guildId ?? '', cursor),
    queryFn: () =>
      apiFetch<Paginated<LevelProfileDto>>(
        `/guilds/${guildId}/engagement/leaderboard${toQueryString({ cursor })}`,
      ),
    enabled: Boolean(guildId),
  });
}

export interface XpAdjustInput {
  userId: string;
  mode: 'give' | 'remove' | 'set';
  amount: number;
  reason?: string;
}

export function useXpAdjust(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: XpAdjustInput) =>
      apiFetch<LevelProfileDto>(`/guilds/${guildId}/engagement/xp-adjust`, { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'engagement', 'leaderboard'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Level-role rewards.
// ---------------------------------------------------------------------------

export function useLevelRewards(guildId: string | undefined) {
  return useQuery({
    queryKey: engagementQueryKeys.rewards(guildId ?? ''),
    queryFn: () => apiFetch<LevelRewardDto[]>(`/guilds/${guildId}/engagement/rewards`),
    enabled: Boolean(guildId),
  });
}

export function useCreateLevelReward(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { level: number; roleId: string }) =>
      apiFetch<LevelRewardDto>(`/guilds/${guildId}/engagement/rewards`, { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: engagementQueryKeys.rewards(guildId) });
    },
  });
}

export function useDeleteLevelReward(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rewardId: string) =>
      apiFetch<void>(`/guilds/${guildId}/engagement/rewards/${rewardId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: engagementQueryKeys.rewards(guildId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Reputation leaderboard.
// ---------------------------------------------------------------------------

export function useRepLeaderboard(guildId: string | undefined, cursor?: string) {
  return useQuery({
    queryKey: engagementQueryKeys.repLeaderboard(guildId ?? '', cursor),
    queryFn: () =>
      apiFetch<Paginated<ReputationLeaderboardEntryDto>>(
        `/guilds/${guildId}/engagement/rep/leaderboard${toQueryString({ cursor })}`,
      ),
    enabled: Boolean(guildId),
  });
}
