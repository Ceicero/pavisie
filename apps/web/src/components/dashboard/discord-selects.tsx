'use client';

import * as React from 'react';
import { ChannelPicker, Input, RolePicker, type ChannelKind } from '@pavisie/ui';
import { useGuildChannels, useGuildRoles } from '@/lib/dashboard/queries';

/** Any single-channel picker with `DiscordChannelSelect`'s props: the Discord dashboard's own (below) or the creator
 * dashboard's (`components/creator/creator-discord.tsx`, which reads the connected server's channels through the
 * creator session and ignores `guildId`). Lets shared forms stay identical for both. */
export type DiscordChannelSelectComponent = React.ComponentType<DiscordChannelSelectProps>;

export interface DiscordChannelSelectProps {
  guildId: string;
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Channel kinds the field accepts. Defaults to `['text', 'announcement']` — "a channel the bot posts in". Pass e.g. `['category']` or `['voice']` for fields that need something else. */
  kinds?: ChannelKind[];
}

/** Single-channel picker backed by `GET /guilds/:id/discord/channels`; falls back to a raw-id text input if that endpoint errors. */
export function DiscordChannelSelect({
  guildId,
  value,
  onChange,
  placeholder,
  disabled,
  kinds = ['text', 'announcement'],
}: DiscordChannelSelectProps) {
  const { data: channels, isError, isLoading } = useGuildChannels(guildId);
  if (isError) {
    return (
      <Input
        value={value ?? ''}
        placeholder="Channel ID"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  }
  return (
    <ChannelPicker
      options={channels ?? []}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled || isLoading}
      kinds={kinds}
    />
  );
}

export interface DiscordRoleSelectProps {
  guildId: string;
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
}

/** Single-role picker backed by `GET /guilds/:id/discord/roles`; falls back to a raw-id text input if that endpoint errors. */
export function DiscordRoleSelect({
  guildId,
  value,
  onChange,
  placeholder,
  disabled,
}: DiscordRoleSelectProps) {
  const { data: roles, isError, isLoading } = useGuildRoles(guildId);
  if (isError) {
    return (
      <Input
        value={value ?? ''}
        placeholder="Role ID"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  }
  return (
    <RolePicker
      options={roles ?? []}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled || isLoading}
    />
  );
}
