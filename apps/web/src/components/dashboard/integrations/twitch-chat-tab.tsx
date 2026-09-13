'use client';

import { Plus } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Button, EmptyState, Skeleton, useToast } from '@pavisie/ui';
import { useConnectTwitchChat, useTwitchChatStatus } from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ErrorState } from '../error-state';
import { TwitchChatChannelCard } from './twitch-chat-channel-card';

/** The "Twitch chat" tab: Pavisie joining a streamer's Twitch chat (distinct from the Twitch *alert*
 * watches on the Alerts tab, which just post "went live" messages). Honest about two independent
 * prerequisites — the deployment's Twitch app credentials, and the bot owner's own Twitch account. */
export function TwitchChatTab({ guildId }: { guildId: string }) {
  const statusQuery = useTwitchChatStatus(guildId);
  const connect = useConnectTwitchChat(guildId);
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

  if (statusQuery.error) {
    return <ErrorState error={statusQuery.error} onRetry={() => statusQuery.refetch()} />;
  }

  if (statusQuery.isLoading || !statusQuery.data) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  const status = statusQuery.data;

  if (!status.envConfigured) {
    return (
      <EmptyState
        title="Not available on this deployment"
        description="The operator hasn't set up Twitch API credentials, so Pavisie can't join Twitch chat here."
      />
    );
  }

  return (
    <div className="space-y-4">
      {!status.botConfigured ? (
        <Alert variant="warning">
          <AlertTitle>Pavisie's Twitch account isn't set up yet</AlertTitle>
          <AlertDescription>
            The bot owner still needs to connect Pavisie's own Twitch account before it can read or send
            chat messages. You can link your channel below now — commands and timers will start working
            once that's done.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {status.channels.length} channel{status.channels.length === 1 ? '' : 's'} linked
        </p>
        <Button size="sm" onClick={handleConnect} disabled={connect.isPending}>
          <Plus className="h-4 w-4" /> {connect.isPending ? 'Starting…' : 'Connect a Twitch channel'}
        </Button>
      </div>

      {status.channels.length === 0 ? (
        <EmptyState
          title="No Twitch channel linked yet"
          description="Connect your Twitch channel so Pavisie can join your chat, answer commands, and run timers."
        />
      ) : (
        <div className="space-y-4">
          {status.channels.map((channel) => (
            <TwitchChatChannelCard key={channel.id} guildId={guildId} channel={channel} />
          ))}
        </div>
      )}
    </div>
  );
}
