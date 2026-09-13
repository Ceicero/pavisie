'use client';

import * as React from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Switch,
  useToast,
} from '@pavisie/ui';
import type { TwitchChatChannelDto } from '@pavisie/types/integrations';
import { useDeleteTwitchChatChannel, useUpdateTwitchChatChannel } from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { TwitchChatCommandsTable } from './twitch-chat-commands-table';
import { TwitchChatOverlayPanel } from './twitch-chat-overlay-panel';
import { TwitchChatRewardsTable } from './twitch-chat-rewards-table';
import { TwitchChatTimersTable } from './twitch-chat-timers-table';

const STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'secondary' | 'warning'> = {
  connected: 'success',
  error: 'destructive',
  disconnected: 'secondary',
  pending: 'warning',
};

export interface TwitchChatChannelCardProps {
  guildId: string;
  channel: TwitchChatChannelDto;
}

/** One linked Twitch channel: connection status, the enable switch, the command prefix, and its
 * commands/timers management — modelled on `provider-card.tsx` for the header and `rule-list.tsx` for
 * the immediate-apply enable switch. */
export function TwitchChatChannelCard({ guildId, channel }: TwitchChatChannelCardProps) {
  const update = useUpdateTwitchChatChannel(guildId);
  const del = useDeleteTwitchChatChannel(guildId);
  const { toast } = useToast();

  const [prefix, setPrefix] = React.useState(channel.commandPrefix);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    setPrefix(channel.commandPrefix);
  }, [channel.commandPrefix]);

  function reportError(title: string) {
    return (err: unknown) =>
      toast({
        title,
        description: err instanceof ApiClientError ? err.message : 'Please try again.',
        variant: 'destructive',
      });
  }

  function toggleEnabled() {
    update.mutate(
      { channelId: channel.id, patch: { enabled: !channel.enabled } },
      { onError: reportError('Could not update the channel') },
    );
  }

  const prefixValid = prefix.length === 1 && prefix !== ' ' && prefix !== '/';
  const prefixDirty = prefix !== channel.commandPrefix;

  function savePrefix() {
    if (!prefixValid || !prefixDirty) return;
    update.mutate(
      { channelId: channel.id, patch: { commandPrefix: prefix } },
      {
        onSuccess: () => toast({ title: 'Command prefix updated', variant: 'success' }),
        onError: reportError('Could not update the prefix'),
      },
    );
  }

  function confirmDelete() {
    del.mutate(channel.id, {
      onSuccess: () => {
        toast({ title: `Disconnected ${channel.broadcasterLogin}`, variant: 'success' });
        setDeleting(false);
      },
      onError: reportError('Could not disconnect the channel'),
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">{channel.broadcasterLogin}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[channel.status] ?? 'secondary'}>{channel.status}</Badge>
            {!channel.enabled ? <Badge variant="secondary">Disabled</Badge> : null}
          </div>
          {channel.status === 'error' && channel.lastError ? (
            <p className="max-w-md text-xs text-destructive">{channel.lastError}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <Switch
            checked={channel.enabled}
            onCheckedChange={toggleEnabled}
            disabled={update.isPending}
            aria-label="Enable this channel"
          />
          <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
            Disconnect
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <FormField label="Command prefix" hint="One character — not a space or /.">
          <div className="flex items-center gap-2">
            <Input
              value={prefix}
              maxLength={1}
              className="w-16 text-center"
              onChange={(e) => setPrefix(e.target.value)}
              disabled={update.isPending}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={savePrefix}
              disabled={!prefixValid || !prefixDirty || update.isPending}
            >
              Save
            </Button>
          </div>
        </FormField>

        <TwitchChatCommandsTable guildId={guildId} channelId={channel.id} prefix={channel.commandPrefix} />
        <TwitchChatTimersTable guildId={guildId} channelId={channel.id} />
        <TwitchChatRewardsTable guildId={guildId} channelId={channel.id} />
        <TwitchChatOverlayPanel guildId={guildId} channel={channel} />
      </CardContent>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Disconnect ${channel.broadcasterLogin}?`}
        description="Pavisie leaves this channel's chat right away, and all its commands and timers are deleted. This can't be undone."
        variant="destructive"
        confirmLabel="Disconnect"
        loading={del.isPending}
        onConfirm={confirmDelete}
      />
    </Card>
  );
}
