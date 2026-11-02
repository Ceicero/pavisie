'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  StreamerStarterQueuedDto,
  StreamerStarterRequestDto,
  StreamerStarterResultDto,
} from '@pavisie/types';
import { apiFetch } from './api';

/** How often the dashboard asks whether the bot has finished the starter pack. */
export const STREAMER_STARTER_POLL_MS = 1500;
/** Stop waiting after this long: the bot is offline, or not in the server (the job just sits in the queue). */
export const STREAMER_STARTER_TIMEOUT_MS = 90_000;

export const setupQueryKeys = {
  streamerStarter: (guildId: string, requestId: string) =>
    ['guilds', guildId, 'setup', 'streamer-starter', requestId] as const,
};

/** `POST /guilds/:id/setup/streamer-starter` — queues the preset on the bot and returns the id to poll with. */
export function useStartStreamerStarter(guildId: string) {
  return useMutation({
    mutationFn: (body: StreamerStarterRequestDto) =>
      apiFetch<StreamerStarterQueuedDto>(`/guilds/${guildId}/setup/streamer-starter`, {
        method: 'POST',
        body,
      }),
  });
}

/** `GET /guilds/:id/setup/streamer-starter/:requestId` — polls until the bot has stored `done` or `failed`. */
export function useStreamerStarterResult(guildId: string, requestId: string | null) {
  return useQuery({
    queryKey: setupQueryKeys.streamerStarter(guildId, requestId ?? ''),
    queryFn: () =>
      apiFetch<StreamerStarterResultDto>(`/guilds/${guildId}/setup/streamer-starter/${requestId}`),
    enabled: Boolean(requestId),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? STREAMER_STARTER_POLL_MS : false),
    // A finished report never changes, and a stale one must not be refetched into a "pending" flash.
    staleTime: Infinity,
  });
}
