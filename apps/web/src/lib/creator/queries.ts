'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatorTwitchChannelDto, CreatorTwitchChannelStatusDto } from '@pavisie/types/creator';
import type {
  CreateTwitchChatCommandInput,
  CreateTwitchChatTimerInput,
  TwitchChatCommandDto,
  TwitchChatTimerDto,
  UpdateTwitchChatCommandInput,
  UpdateTwitchChatTimerInput,
} from '@pavisie/types/integrations';
import type { TwitchChatCommandsBackend, TwitchChatTimersBackend } from '@/lib/dashboard/twitch-chat-backend';
import { creatorFetch } from './api';
import { useCreatorSession } from './session';

/** Every creator query key starts with `['creator']` so a sign-out can clear them all in one call. */
export const creatorQueryKeys = {
  twitchChannel: () => ['creator', 'twitch', 'channel'] as const,
  twitchCommands: () => ['creator', 'twitch', 'commands'] as const,
  twitchTimers: () => ['creator', 'twitch', 'timers'] as const,
};

const CHANNEL_PATH = '/creator/twitch/channel';

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
