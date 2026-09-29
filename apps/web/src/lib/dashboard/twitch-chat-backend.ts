import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type {
  CreateTwitchChatCommandInput,
  CreateTwitchChatRewardInput,
  CreateTwitchChatTimerInput,
  TwitchChatCommandDto,
  TwitchChatRewardDto,
  TwitchChatTimerDto,
  UpdateTwitchChatCommandInput,
  UpdateTwitchChatRewardInput,
  UpdateTwitchChatTimerInput,
} from '@pavisie/types/integrations';

/**
 * Where the shared Twitch chat commands/timers/rewards UI (`components/dashboard/integrations/twitch-chat-*-table.tsx`
 * and `-dialog.tsx`) reads and writes. Since creator-dashboard phase 4 the only caller is the creator dashboard
 * (`/creator/twitch/*`, implemented in `lib/creator/queries.ts`); the Discord dashboard no longer manages any of it.
 * The tables and dialogs stay source-agnostic on purpose: each member is a React hook the component calls
 * unconditionally, in a fixed order, at the top of its render — the standard "hooks passed as props" shape.
 *
 * `channelId` rides along in the mutation variables only so a backend that scopes its cache per channel can
 * invalidate the right entry; the creator backend, whose channel is implied by the session, ignores it.
 */
export interface TwitchChatCommandsBackend {
  useList: () => UseQueryResult<TwitchChatCommandDto[]>;
  useCreate: () => UseMutationResult<
    TwitchChatCommandDto,
    Error,
    { channelId: string; input: CreateTwitchChatCommandInput }
  >;
  useUpdate: () => UseMutationResult<
    TwitchChatCommandDto,
    Error,
    { commandId: string; channelId: string; patch: UpdateTwitchChatCommandInput }
  >;
  useRemove: () => UseMutationResult<void, Error, { commandId: string; channelId: string }>;
}

export interface TwitchChatTimersBackend {
  useList: () => UseQueryResult<TwitchChatTimerDto[]>;
  useCreate: () => UseMutationResult<
    TwitchChatTimerDto,
    Error,
    { channelId: string; input: CreateTwitchChatTimerInput }
  >;
  useUpdate: () => UseMutationResult<
    TwitchChatTimerDto,
    Error,
    { timerId: string; channelId: string; patch: UpdateTwitchChatTimerInput }
  >;
  useRemove: () => UseMutationResult<void, Error, { timerId: string; channelId: string }>;
}

/** The same idea for channel-point rewards (`twitch-chat-rewards-table.tsx` / `twitch-chat-reward-dialog.tsx`). */
export interface TwitchChatRewardsBackend {
  useList: () => UseQueryResult<TwitchChatRewardDto[]>;
  useCreate: () => UseMutationResult<
    TwitchChatRewardDto,
    Error,
    { channelId: string; input: CreateTwitchChatRewardInput }
  >;
  useUpdate: () => UseMutationResult<
    TwitchChatRewardDto,
    Error,
    { rewardId: string; channelId: string; patch: UpdateTwitchChatRewardInput }
  >;
  useRemove: () => UseMutationResult<void, Error, { rewardId: string; channelId: string }>;
}
