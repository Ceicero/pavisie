'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiscordChannelOption } from '@pavisie/types';
import type {
  CreatorChannelEconomyDto,
  CreatorChannelEconomySettingsDto,
  CreatorDiscordBridgeDto,
  CreatorDiscordCandidatesDto,
  CreatorDiscordStatusDto,
  CreatorEconomyAdjustInput,
  CreatorEconomyAdjustResultDto,
  CreatorEconomyLeaderboardDto,
  CreatorRewardsStatusDto,
  CreatorTtsKeyStatusDto,
  CreatorTwitchChannelDto,
  CreatorTwitchChannelStatusDto,
  UpdateCreatorDiscordBridgeInput,
} from '@pavisie/types/creator';
import type {
  CreateTwitchChatCommandInput,
  CreateTwitchChatRewardInput,
  CreateTwitchChatTimerInput,
  TwitchChatCommandDto,
  TwitchChatRewardDto,
  TwitchChatTimerDto,
  TwitchOverlayInfoDto,
  UpdateTwitchChatCommandInput,
  UpdateTwitchChatRewardInput,
  UpdateTwitchChatTimerInput,
} from '@pavisie/types/integrations';
import type {
  TwitchChatCommandsBackend,
  TwitchChatRewardsBackend,
  TwitchChatTimersBackend,
} from '@/lib/dashboard/twitch-chat-backend';
import { creatorFetch } from './api';
import { API_BASE_URL } from '@/lib/dashboard/api';
import { useCreatorSession } from './session';

/** Every creator query key starts with `['creator']` so a sign-out can clear them all in one call. */
export const creatorQueryKeys = {
  twitchChannel: () => ['creator', 'twitch', 'channel'] as const,
  twitchCommands: () => ['creator', 'twitch', 'commands'] as const,
  twitchTimers: () => ['creator', 'twitch', 'timers'] as const,
  twitchEconomy: () => ['creator', 'twitch', 'economy'] as const,
  twitchEconomyLeaderboard: () => ['creator', 'twitch', 'economy', 'leaderboard'] as const,
  twitchRewards: () => ['creator', 'twitch', 'rewards'] as const,
  twitchRewardItems: () => ['creator', 'twitch', 'rewards', 'items'] as const,
  twitchRewardsOverlay: () => ['creator', 'twitch', 'rewards', 'overlay'] as const,
  twitchDiscord: () => ['creator', 'twitch', 'discord'] as const,
  twitchDiscordCandidates: () => ['creator', 'twitch', 'discord', 'candidates'] as const,
  twitchDiscordChannels: () => ['creator', 'twitch', 'discord', 'channels'] as const,
  twitchDiscordBridge: () => ['creator', 'twitch', 'discord', 'bridge'] as const,
};

const CHANNEL_PATH = '/creator/twitch/channel';
const ECONOMY_PATH = '/creator/twitch/economy';
const REWARDS_PATH = '/creator/twitch/rewards';
const DISCORD_PATH = '/creator/twitch/discord';

/** Queries only run for a signed-in creator (otherwise they would just 401). */
function useSignedIn(): boolean {
  return useCreatorSession().status === 'authenticated';
}

// ---------------------------------------------------------------------------
// The creator's own Twitch chat-bot channel
// ---------------------------------------------------------------------------

export function useCreatorTwitchChannel() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchChannel(),
    queryFn: () => creatorFetch<CreatorTwitchChannelStatusDto>(CHANNEL_PATH),
    enabled: signedIn,
  });
}

/** Starts connecting the bot to the creator's chat: resolves with the Twitch authorize URL to navigate to. */
export function useConnectCreatorTwitchChannel() {
  return useMutation({
    mutationFn: () => creatorFetch<{ url: string }>(`${CHANNEL_PATH}/connect`, { method: 'POST' }),
  });
}

export function useUpdateCreatorTwitchChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: { enabled?: boolean; commandPrefix?: string }) =>
      creatorFetch<CreatorTwitchChannelDto>(CHANNEL_PATH, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: creatorQueryKeys.twitchChannel() });
    },
  });
}

export function useDisconnectCreatorTwitchChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => creatorFetch<void>(CHANNEL_PATH, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['creator', 'twitch'] });
    },
  });
}

// ---------------------------------------------------------------------------
// The channel's own currency (`ChannelEconomy`) — owned by the Twitch channel, works with no Discord server
// ---------------------------------------------------------------------------

export function useCreatorEconomy() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchEconomy(),
    queryFn: () => creatorFetch<CreatorChannelEconomyDto>(ECONOMY_PATH),
    enabled: signedIn,
  });
}

/** Saves a partial update; the FIRST save is what creates the currency (nothing is stored by merely viewing). */
export function useUpdateCreatorEconomy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<CreatorChannelEconomySettingsDto>) =>
      creatorFetch<CreatorChannelEconomyDto>(ECONOMY_PATH, { method: 'PATCH', body: patch }),
    onSuccess: (saved) => {
      queryClient.setQueryData(creatorQueryKeys.twitchEconomy(), saved);
      void queryClient.invalidateQueries({ queryKey: creatorQueryKeys.twitchEconomyLeaderboard() });
    },
  });
}

/** Top viewers by lifetime earned and by current balance. Only runs once the currency exists. */
export function useCreatorEconomyLeaderboard(enabled: boolean) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchEconomyLeaderboard(),
    queryFn: () => creatorFetch<CreatorEconomyLeaderboardDto>(`${ECONOMY_PATH}/leaderboard`),
    enabled: signedIn && enabled,
  });
}

export function useAdjustCreatorEconomy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatorEconomyAdjustInput) =>
      creatorFetch<CreatorEconomyAdjustResultDto>(`${ECONOMY_PATH}/adjust`, { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: creatorQueryKeys.twitchEconomyLeaderboard() });
    },
  });
}

// ---------------------------------------------------------------------------
// Commands / timers — implementations of the backends the shared Twitch chat tables/dialogs consume
// (`lib/dashboard/twitch-chat-backend.ts`). The channel is implied by the session, so `channelId` in the
// mutation variables (kept for shape-compatibility with the guild hooks) is not used for anything here.
// ---------------------------------------------------------------------------

function useCreatorCommands() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchCommands(),
    queryFn: () => creatorFetch<TwitchChatCommandDto[]>(`${CHANNEL_PATH}/commands`),
    enabled: signedIn,
  });
}

function useCreateCreatorCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input }: { channelId: string; input: CreateTwitchChatCommandInput }) =>
      creatorFetch<TwitchChatCommandDto>(`${CHANNEL_PATH}/commands`, { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: creatorQueryKeys.twitchCommands() });
    },
  });
}

function useUpdateCreatorCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      commandId,
      patch,
    }: {
      commandId: string;
      channelId: string;
      patch: UpdateTwitchChatCommandInput;
    }) => creatorFetch<TwitchChatCommandDto>(`${CHANNEL_PATH}/commands/${commandId}`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: creatorQueryKeys.twitchCommands() });
    },
  });
}

function useDeleteCreatorCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commandId }: { commandId: string; channelId: string }) =>
      creatorFetch<void>(`${CHANNEL_PATH}/commands/${commandId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: creatorQueryKeys.twitchCommands() });
    },
  });
}

function useCreatorTimers() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchTimers(),
    queryFn: () => creatorFetch<TwitchChatTimerDto[]>(`${CHANNEL_PATH}/timers`),
    enabled: signedIn,
  });
}

function useCreateCreatorTimer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input }: { channelId: string; input: CreateTwitchChatTimerInput }) =>
      creatorFetch<TwitchChatTimerDto>(`${CHANNEL_PATH}/timers`, { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: creatorQueryKeys.twitchTimers() });
    },
  });
}

function useUpdateCreatorTimer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      timerId,
      patch,
    }: {
      timerId: string;
      channelId: string;
      patch: UpdateTwitchChatTimerInput;
    }) => creatorFetch<TwitchChatTimerDto>(`${CHANNEL_PATH}/timers/${timerId}`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: creatorQueryKeys.twitchTimers() });
    },
  });
}

function useDeleteCreatorTimer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ timerId }: { timerId: string; channelId: string }) =>
      creatorFetch<void>(`${CHANNEL_PATH}/timers/${timerId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: creatorQueryKeys.twitchTimers() });
    },
  });
}

export const creatorTwitchCommandsBackend: TwitchChatCommandsBackend = {
  useList: useCreatorCommands,
  useCreate: useCreateCreatorCommand,
  useUpdate: useUpdateCreatorCommand,
  useRemove: useDeleteCreatorCommand,
};

export const creatorTwitchTimersBackend: TwitchChatTimersBackend = {
  useList: useCreatorTimers,
  useCreate: useCreateCreatorTimer,
  useUpdate: useUpdateCreatorTimer,
  useRemove: useDeleteCreatorTimer,
};

// ---------------------------------------------------------------------------
// Channel points: authorization, the master switch, rewards, the OBS overlay URL and the channel's TTS key.
// Everything is the signed-in creator's own channel (implied by the session); nothing needs a Discord server.
// ---------------------------------------------------------------------------

export function useCreatorRewardsStatus() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchRewards(),
    queryFn: () => creatorFetch<CreatorRewardsStatusDto>(REWARDS_PATH),
    enabled: signedIn,
  });
}

/** Invalidates everything under the rewards key (status, list, overlay) in one call. */
function useInvalidateRewards() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: creatorQueryKeys.twitchRewards() });
}

/** Starts "enable channel points": resolves with the Twitch authorize URL to navigate to. */
export function useAuthorizeCreatorChannelPoints() {
  return useMutation({
    mutationFn: () => creatorFetch<{ url: string }>(`${REWARDS_PATH}/authorize`, { method: 'POST' }),
  });
}

/** Disconnects channel points: the broadcaster token is forgotten and rewards switch off. */
export function useDisconnectCreatorChannelPoints() {
  const invalidate = useInvalidateRewards();
  return useMutation({
    mutationFn: () => creatorFetch<void>(`${REWARDS_PATH}/authorize`, { method: 'DELETE' }),
    onSuccess: () => void invalidate(),
  });
}

export function useSetCreatorRewardsEnabled() {
  const invalidate = useInvalidateRewards();
  return useMutation({
    mutationFn: (rewardsEnabled: boolean) =>
      creatorFetch<{ rewardsEnabled: boolean }>(REWARDS_PATH, { method: 'PATCH', body: { rewardsEnabled } }),
    onSuccess: () => void invalidate(),
  });
}

function useCreatorRewardItems() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchRewardItems(),
    queryFn: () => creatorFetch<TwitchChatRewardDto[]>(`${REWARDS_PATH}/items`),
    enabled: signedIn,
  });
}

function useCreateCreatorReward() {
  const invalidate = useInvalidateRewards();
  return useMutation({
    mutationFn: ({ input }: { channelId: string; input: CreateTwitchChatRewardInput }) =>
      creatorFetch<TwitchChatRewardDto>(`${REWARDS_PATH}/items`, { method: 'POST', body: input }),
    onSuccess: () => void invalidate(),
  });
}

function useUpdateCreatorReward() {
  const invalidate = useInvalidateRewards();
  return useMutation({
    mutationFn: ({
      rewardId,
      patch,
    }: {
      rewardId: string;
      channelId: string;
      patch: UpdateTwitchChatRewardInput;
    }) => creatorFetch<TwitchChatRewardDto>(`${REWARDS_PATH}/items/${rewardId}`, { method: 'PATCH', body: patch }),
    onSuccess: () => void invalidate(),
  });
}

function useDeleteCreatorReward() {
  const invalidate = useInvalidateRewards();
  return useMutation({
    mutationFn: ({ rewardId }: { rewardId: string; channelId: string }) =>
      creatorFetch<void>(`${REWARDS_PATH}/items/${rewardId}`, { method: 'DELETE' }),
    onSuccess: () => void invalidate(),
  });
}

export const creatorTwitchRewardsBackend: TwitchChatRewardsBackend = {
  useList: useCreatorRewardItems,
  useCreate: useCreateCreatorReward,
  useUpdate: useUpdateCreatorReward,
  useRemove: useDeleteCreatorReward,
};

/** The overlay URL is a capability secret: shown only to the owner, fetched only once the section is open and a
 * URL exists (`enabled`), and never persisted by the browser beyond React Query's in-memory cache. */
export function useCreatorRewardsOverlay(enabled: boolean) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchRewardsOverlay(),
    queryFn: () => creatorFetch<TwitchOverlayInfoDto>(`${REWARDS_PATH}/overlay`),
    enabled: signedIn && enabled,
    gcTime: 0,
  });
}

/** Creates the overlay URL, or rotates it (the old URL stops working at once). */
export function useResetCreatorRewardsOverlay() {
  const invalidate = useInvalidateRewards();
  return useMutation({
    mutationFn: () => creatorFetch<TwitchOverlayInfoDto>(`${REWARDS_PATH}/overlay/regenerate`, { method: 'POST' }),
    onSuccess: () => void invalidate(),
  });
}

/** Sets (or replaces) the channel's own OpenAI key for TTS. Write-only: the key is never read back. */
export function useSetCreatorTtsKey() {
  const invalidate = useInvalidateRewards();
  return useMutation({
    mutationFn: (apiKey: string) =>
      creatorFetch<CreatorTtsKeyStatusDto>(`${REWARDS_PATH}/tts-key`, { method: 'PUT', body: { apiKey } }),
    onSuccess: () => void invalidate(),
  });
}

export function useClearCreatorTtsKey() {
  const invalidate = useInvalidateRewards();
  return useMutation({
    mutationFn: () => creatorFetch<CreatorTtsKeyStatusDto>(`${REWARDS_PATH}/tts-key`, { method: 'DELETE' }),
    onSuccess: () => void invalidate(),
  });
}

// ---------------------------------------------------------------------------
// The optional Discord server (creator dashboard phase 3): connect, pick, disconnect, and the bridge. Everything is
// the signed-in creator's own channel (implied by the session).
// ---------------------------------------------------------------------------

/** Where "Connect a Discord server" goes: the API starts the Discord sign-in (a top-level redirect, like sign-in). */
export const creatorDiscordConnectUrl = `${API_BASE_URL}${DISCORD_PATH}/connect`;

export function useCreatorDiscordStatus() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchDiscord(),
    queryFn: () => creatorFetch<CreatorDiscordStatusDto>(DISCORD_PATH),
    enabled: signedIn,
  });
}

/** The servers found by the Discord sign-in just completed (held for a few minutes). Only fetched while picking. */
export function useCreatorDiscordCandidates(enabled: boolean) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchDiscordCandidates(),
    queryFn: () => creatorFetch<CreatorDiscordCandidatesDto>(`${DISCORD_PATH}/candidates`),
    enabled: signedIn && enabled,
    gcTime: 0,
  });
}

export function useLinkCreatorDiscord() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (guildId: string) =>
      creatorFetch<CreatorDiscordStatusDto>(`${DISCORD_PATH}/link`, { method: 'POST', body: { guildId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['creator', 'twitch'] });
    },
  });
}

export function useUnlinkCreatorDiscord() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => creatorFetch<void>(`${DISCORD_PATH}/link`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['creator', 'twitch'] });
    },
  });
}

/** The connected server's channels for the pickers; only runs once a verified server is connected. */
export function useCreatorDiscordChannels(enabled: boolean) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchDiscordChannels(),
    queryFn: () => creatorFetch<DiscordChannelOption[]>(`${DISCORD_PATH}/channels`),
    enabled: signedIn && enabled,
  });
}

export function useCreatorDiscordBridge(enabled: boolean) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: creatorQueryKeys.twitchDiscordBridge(),
    queryFn: () => creatorFetch<CreatorDiscordBridgeDto>(`${DISCORD_PATH}/bridge`),
    enabled: signedIn && enabled,
  });
}

export function useUpdateCreatorDiscordBridge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateCreatorDiscordBridgeInput) =>
      creatorFetch<CreatorDiscordBridgeDto>(`${DISCORD_PATH}/bridge`, { method: 'PATCH', body: patch }),
    onSuccess: (saved) => {
      queryClient.setQueryData(creatorQueryKeys.twitchDiscordBridge(), saved);
    },
  });
}
