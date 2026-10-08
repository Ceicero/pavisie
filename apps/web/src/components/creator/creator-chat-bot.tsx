'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  Input,
  Skeleton,
  Switch,
  useToast,
} from '@pavisie/ui';
import type { CreatorTwitchChannelDto } from '@pavisie/types/creator';
import { ApiClientError } from '@/lib/dashboard/api';
import {
  creatorTwitchCommandsBackend,
  creatorTwitchTimersBackend,
  useConnectCreatorTwitchChannel,
  useCreatorTwitchChannel,
  useDisconnectCreatorTwitchChannel,
  useUpdateCreatorTwitchChannel,
} from '@/lib/creator/queries';
import { ConfirmDialog } from '@/components/dashboard/confirm-dialog';
import { ErrorState } from '@/components/dashboard/error-state';
import { TwitchChatCommandsTable } from '@/components/dashboard/integrations/twitch-chat-commands-table';
import { TwitchChatTimersTable } from '@/components/dashboard/integrations/twitch-chat-timers-table';

const STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'secondary' | 'warning'> = {
  connected: 'success',
  error: 'destructive',
  disconnected: 'secondary',
  pending: 'warning',
};

/** The "Chat bot" section: is Pavisie in your chat, connect/disconnect, the command prefix, and your commands and
 * timers. Everything is read from `/creator/twitch/channel` — an honest empty state until a channel exists. */
export function CreatorChatBot() {
  const channelQuery = useCreatorTwitchChannel();
  const connect = useConnectCreatorTwitchChannel();
  const { toast } = useToast();

  function handleConnect() {
    connect.mutate(undefined, {
      onSuccess: (result) => window.location.assign(result.url),
      onError: (err) =>
        toast({
          title: 'Could not start the Twitch connection',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  if (channelQuery.error) {
    return <ErrorState error={channelQuery.error} onRetry={() => channelQuery.refetch()} />;
  }

  if (channelQuery.isLoading || !channelQuery.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const { botConfigured, envConfigured, channel } = channelQuery.data;

  if (!envConfigured) {
    return (
      <EmptyState
        title="Not available on this deployment"
        description="The operator hasn't set up Twitch API credentials, so Pavisie can't join Twitch chat here."
      />
    );
  }

  return (
    <section aria-labelledby="chat-bot-heading" className="space-y-4">
      <h2 id="chat-bot-heading" className="text-lg font-semibold">
        Chat bot
      </h2>

      {!botConfigured ? (
        <Alert variant="warning">
          <AlertTitle>Pavisie's Twitch account isn't set up yet</AlertTitle>
          <AlertDescription>
            The operator still needs to connect Pavisie's own Twitch account before it can read or send chat
            messages. You can connect your channel now. Commands and timers will start working once that is done.
          </AlertDescription>
        </Alert>
      ) : null}

      {channel ? (
        <CreatorChannelCard channel={channel} />
      ) : (
        <EmptyState
          title="Pavisie isn't in your chat yet"
          description="Connect your Twitch channel so the bot can join your chat, answer your commands, and post your timers. You will be asked to approve it on Twitch."
          action={
            <Button onClick={handleConnect} disabled={connect.isPending}>
              <Plus className="h-4 w-4" />
              {connect.isPending ? 'Starting…' : 'Connect the bot to my chat'}
            </Button>
          }
        />
      )}
    </section>
  );
}

function CreatorChannelCard({ channel }: { channel: CreatorTwitchChannelDto }) {
  const update = useUpdateCreatorTwitchChannel();
  const disconnect = useDisconnectCreatorTwitchChannel();
  const connect = useConnectCreatorTwitchChannel();
  const { toast } = useToast();

  const [prefix, setPrefix] = React.useState(channel.commandPrefix);
  const [confirmingDisconnect, setConfirmingDisconnect] = React.useState(false);

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

  const prefixValid = prefix.length === 1 && prefix !== ' ' && prefix !== '/';
  const prefixDirty = prefix !== channel.commandPrefix;

  function savePrefix() {
    if (!prefixValid || !prefixDirty) return;
    update.mutate(
      { commandPrefix: prefix },
      {
        onSuccess: () => toast({ title: 'Command prefix updated', variant: 'success' }),
        onError: reportError('Could not update the prefix'),
      },
    );
  }

  function toggleEnabled() {
    update.mutate({ enabled: !channel.enabled }, { onError: reportError('Could not update the bot') });
  }

  function reconnect() {
    connect.mutate(undefined, {
      onSuccess: (result) => window.location.assign(result.url),
      onError: reportError('Could not start the Twitch connection'),
    });
  }

  function confirmDisconnect() {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        toast({ title: 'Pavisie left your chat', variant: 'success' });
        setConfirmingDisconnect(false);
      },
      onError: reportError('Could not disconnect the bot'),
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">{channel.broadcasterLogin}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {channel.enabled ? (
              <Badge variant={STATUS_VARIANT[channel.status] ?? 'secondary'}>{channel.status}</Badge>
            ) : (
              <Badge variant="secondary">paused</Badge>
            )}
            {channel.discordLinked ? <Badge variant="secondary">linked to a Discord server</Badge> : null}
          </div>
          {channel.lastError ? (
            <p className="max-w-md text-xs text-destructive">{channel.lastError}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <Switch
            checked={channel.enabled}
            onCheckedChange={toggleEnabled}
            disabled={update.isPending}
            aria-label="Bot enabled in my chat"
          />
          <Button size="sm" variant="ghost" onClick={() => setConfirmingDisconnect(true)}>
            Disconnect
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {channel.status === 'error' ? (
          <div>
            <Button size="sm" variant="outline" onClick={reconnect} disabled={connect.isPending}>
              {connect.isPending ? 'Starting…' : 'Reconnect on Twitch'}
            </Button>
          </div>
        ) : null}

        <FormField label="Command prefix" hint="One character, not a space or /.">
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

        {!channel.discordLinked ? (
          <p className="text-xs text-muted-foreground">
            The Discord chat bridge needs a linked Discord server, so it is not available here yet. Your channel
            currency works without one; set it up in the Currency section below.
          </p>
        ) : null}

        <TwitchChatCommandsTable
          backend={creatorTwitchCommandsBackend}
          channelId={channel.id}
          prefix={channel.commandPrefix}
        />
        <TwitchChatTimersTable backend={creatorTwitchTimersBackend} channelId={channel.id} />
      </CardContent>

      <ConfirmDialog
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        title="Disconnect Pavisie from your chat?"
        description={
          channel.discordLinked
            ? "Pavisie leaves your chat right away. This channel is also linked to a Discord server, so its commands and timers are kept and you can reconnect any time."
            : "Pavisie leaves your chat right away, and your commands and timers are deleted. This can't be undone."
        }
        variant="destructive"
        confirmLabel="Disconnect"
        loading={disconnect.isPending}
        onConfirm={confirmDisconnect}
      />
    </Card>
  );
}
