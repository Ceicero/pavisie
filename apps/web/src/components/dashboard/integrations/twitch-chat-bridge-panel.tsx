'use client';

import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Switch } from '@pavisie/ui';

export interface TwitchChatBridgeCardProps {
  /** The Discord channel picker (the creator dashboard's, reading the connected server's channels). */
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

/** The Discord <-> Twitch chat bridge form (opt-in, off by default per direction). It only takes props, so it does not
 * care where its data lives; since creator-dashboard phase 4 the creator dashboard's "Discord server" section is its
 * only user. */
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
