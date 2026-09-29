import {
  useCreateTwitchChatCommand,
  useCreateTwitchChatTimer,
  useDeleteTwitchChatCommand,
  useDeleteTwitchChatTimer,
  useTwitchChatCommands,
  useTwitchChatTimers,
  useUpdateTwitchChatCommand,
  useUpdateTwitchChatTimer,
} from './integrations-queries';

/**
 * Where the shared Twitch chat commands/timers UI (`components/dashboard/integrations/twitch-chat-*-table.tsx`
 * and `-dialog.tsx`) reads and writes. Two callers use those components: the Discord dashboard (guild-scoped
 * routes, `guildTwitchChat*Backend` below) and the creator dashboard (`/creator/twitch/*`, built in
 * `lib/creator/queries.ts`, no guild involved). Each member is a React hook that the shared component calls
 * unconditionally, in a fixed order, at the top of its render — the standard "hooks passed as props" shape, so
 * the components stay identical for both and only the data source differs.
 *
 * Types are derived from the guild hooks (`ReturnType<...>`) so the creator implementations are checked against
 * exactly what the components consume — including the mutation variable shapes (`channelId` rides along only to
 * scope cache invalidation, exactly as the guild hooks document).
 */
export interface TwitchChatCommandsBackend {
  useList: () => ReturnType<typeof useTwitchChatCommands>;
  useCreate: () => ReturnType<typeof useCreateTwitchChatCommand>;
  useUpdate: () => ReturnType<typeof useUpdateTwitchChatCommand>;
  useRemove: () => ReturnType<typeof useDeleteTwitchChatCommand>;
}

export interface TwitchChatTimersBackend {
  useList: () => ReturnType<typeof useTwitchChatTimers>;
  useCreate: () => ReturnType<typeof useCreateTwitchChatTimer>;
  useUpdate: () => ReturnType<typeof useUpdateTwitchChatTimer>;
  useRemove: () => ReturnType<typeof useDeleteTwitchChatTimer>;
}

/** The Discord dashboard's backend for one linked channel's commands (`/guilds/:guildId/integrations/...`). */
export function guildTwitchChatCommandsBackend(guildId: string, channelId: string): TwitchChatCommandsBackend {
  return {
    useList: () => useTwitchChatCommands(guildId, channelId),
    useCreate: () => useCreateTwitchChatCommand(guildId),
    useUpdate: () => useUpdateTwitchChatCommand(guildId),
    useRemove: () => useDeleteTwitchChatCommand(guildId),
  };
}

/** The Discord dashboard's backend for one linked channel's timers. */
export function guildTwitchChatTimersBackend(guildId: string, channelId: string): TwitchChatTimersBackend {
  return {
    useList: () => useTwitchChatTimers(guildId, channelId),
    useCreate: () => useCreateTwitchChatTimer(guildId),
    useUpdate: () => useUpdateTwitchChatTimer(guildId),
    useRemove: () => useDeleteTwitchChatTimer(guildId),
  };
}
