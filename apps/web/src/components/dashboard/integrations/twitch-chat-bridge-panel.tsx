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

  const hasChannel = Boolean(channel.bridgeDiscordChannelId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Discord ↔ Twitch chat bridge</CardTitle>
        <CardDescription>Show messages from each platform in the other, live</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField label="Bridge Discord channel">
          <DiscordChannelSelect
            guildId={guildId}
            value={channel.bridgeDiscordChannelId}
            onChange={setBridgeChannel}
            placeholder="Select a channel…"
            disabled={update.isPending}
          />
        </FormField>

        <FormField label="Relay Discord → Twitch">
          <Switch
            checked={channel.bridgeDiscordToTwitch}
            onCheckedChange={toggleDiscordToTwitch}
            disabled={update.isPending || !hasChannel}
            aria-label="Relay Discord messages into Twitch chat"
          />
        </FormField>

        <FormField label="Relay Twitch → Discord">
          <Switch
            checked={channel.bridgeTwitchToDiscord}
            onCheckedChange={toggleTwitchToDiscord}
            disabled={update.isPending || !hasChannel}
            aria-label="Relay Twitch chat messages into Discord"
          />
        </FormField>

        <p className="text-xs text-muted-foreground">
          When on, messages posted in the selected Discord channel are shown in this Twitch chat (or vice versa).
          Pavisie does not store or log this text — only names/ids from other features are ever saved.
        </p>

        {channel.bridgeLastError ? <p className="text-xs text-destructive">{channel.bridgeLastError}</p> : null}
      </CardContent>
    </Card>
  );
}
