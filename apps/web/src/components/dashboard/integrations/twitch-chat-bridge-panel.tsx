'use client';

import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Switch, useToast } from '@pavisie/ui';
import type { TwitchChatChannelDto } from '@pavisie/types/integrations';
import { useUpdateTwitchChatChannel } from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { DiscordChannelSelect } from '../discord-selects';

export interface TwitchChatBridgePanelProps {
  guildId: string;
  channel: TwitchChatChannelDto;
}

/** Discord <-> Twitch chat bridge (opt-in, off by default per direction) — modelled on
 * `twitch-chat-overlay-panel.tsx` for the labeled-sub-section-with-its-own-save-action style. */
export function TwitchChatBridgePanel({ guildId, channel }: TwitchChatBridgePanelProps) {
  const update = useUpdateTwitchChatChannel(guildId);
  const { toast } = useToast();

  function reportError(title: string) {
    return (err: unknown) =>
      toast({
        title,
        description: err instanceof ApiClientError ? err.message : 'Please try again.',
        variant: 'destructive',
      });
  }

  function setBridgeChannel(next: string | null) {
    update.mutate(
      { channelId: channel.id, patch: { bridgeDiscordChannelId: next } },
      { onError: reportError('Could not update the bridge channel') },
    );
  }

  function toggleDiscordToTwitch() {
    update.mutate(
      { channelId: channel.id, patch: { bridgeDiscordToTwitch: !channel.bridgeDiscordToTwitch } },
      { onError: reportError('Could not update the bridge') },
    );
  }

  function toggleTwitchToDiscord() {
    update.mutate(
      { channelId: channel.id, patch: { bridgeTwitchToDiscord: !channel.bridgeTwitchToDiscord } },
      { onError: reportError('Could not update the bridge') },
    );
  }

  return (
    <TwitchChatBridgeCard
      channelSelect={
        <DiscordChannelSelect
          guildId={guildId}
          value={channel.bridgeDiscordChannelId}
          onChange={setBridgeChannel}
          placeholder="Select a channel…"
          disabled={update.isPending}
        />
      }
      hasChannel={Boolean(channel.bridgeDiscordChannelId)}
      discordToTwitch={channel.bridgeDiscordToTwitch}
      twitchToDiscord={channel.bridgeTwitchToDiscord}
      onToggleDiscordToTwitch={toggleDiscordToTwitch}
      onToggleTwitchToDiscord={toggleTwitchToDiscord}
      pending={update.isPending}
      lastError={channel.bridgeLastError}
    />
  );
}

export interface TwitchChatBridgeCardProps {
  /** The Discord channel picker (the Discord dashboard's or the creator dashboard's). */
  channelSelect: React.ReactNode;
  /** A bridge channel is chosen (the direction switches stay disabled until then). */
  hasChannel: boolean;
  discordToTwitch: boolean;
  twitchToDiscord: boolean;
  onToggleDiscordToTwitch: () => void;
  onToggleTwitchToDiscord: () => void;
  pending: boolean;
  lastError: string | null;
}

/** The bridge form itself, independent of where its data lives: shared by the Discord dashboard (above) and the
 * creator dashboard's "Discord server" section. */
export function TwitchChatBridgeCard({
  channelSelect,
  hasChannel,
  discordToTwitch,
  twitchToDiscord,
  onToggleDiscordToTwitch,
  onToggleTwitchToDiscord,
  pending,
  lastError,
}: TwitchChatBridgeCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Discord ↔ Twitch chat bridge</CardTitle>
        <CardDescription>Show messages from each platform in the other, live</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField label="Bridge Discord channel">{channelSelect}</FormField>

        <FormField label="Relay Discord → Twitch">
          <Switch
            checked={discordToTwitch}
            onCheckedChange={onToggleDiscordToTwitch}
            disabled={pending || !hasChannel}
            aria-label="Relay Discord messages into Twitch chat"
          />
        </FormField>

        <FormField label="Relay Twitch → Discord">
          <Switch
            checked={twitchToDiscord}
            onCheckedChange={onToggleTwitchToDiscord}
            disabled={pending || !hasChannel}
            aria-label="Relay Twitch chat messages into Discord"
          />
        </FormField>

        <p className="text-xs text-muted-foreground">
          When on, messages posted in the selected Discord channel are shown in this Twitch chat (or vice versa).
          Pavisie does not store or log this text — only names/ids from other features are ever saved.
        </p>

        {lastError ? <p className="text-xs text-destructive">{lastError}</p> : null}
      </CardContent>
    </Card>
  );
}
