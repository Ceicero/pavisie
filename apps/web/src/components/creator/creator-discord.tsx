'use client';

import * as React from 'react';
import { MessageSquare } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ChannelPicker,
  EmptyState,
  Input,
  Skeleton,
  useToast,
} from '@pavisie/ui';
import type { CreatorDiscordServerDto, CreatorDiscordStatusDto } from '@pavisie/types/creator';
import { ApiClientError, API_BASE_URL } from '@/lib/dashboard/api';
import {
  creatorDiscordConnectUrl,
  useCreatorDiscordBridge,
  useCreatorDiscordCandidates,
  useCreatorDiscordChannels,
  useCreatorDiscordStatus,
  useLinkCreatorDiscord,
  useUnlinkCreatorDiscord,
  useUpdateCreatorDiscordBridge,
} from '@/lib/creator/queries';
import { ConfirmDialog } from '@/components/dashboard/confirm-dialog';
import type { DiscordChannelSelectProps } from '@/components/dashboard/discord-selects';
import { ErrorState } from '@/components/dashboard/error-state';
import { TwitchChatBridgeCard } from '@/components/dashboard/integrations/twitch-chat-bridge-panel';

function errorToast(toast: ReturnType<typeof useToast>['toast'], title: string) {
  return (err: unknown) =>
    toast({
      title,
      description: err instanceof ApiClientError ? err.message : 'Please try again.',
      variant: 'destructive',
    });
}

/**
 * Channel picker for the connected Discord server, with the Discord dashboard's `DiscordChannelSelect` props (so the
 * shared reward form and bridge card work unchanged). It reads the channels through the creator session — no guild
 * id is ever sent, the API only ever answers for the one server linked to this creator's channel.
 */
export function CreatorDiscordChannelSelect({
  value,
  onChange,
  placeholder,
  disabled,
  kinds = ['text', 'announcement'],
}: DiscordChannelSelectProps) {
  const { data: channels, isError, isLoading } = useCreatorDiscordChannels(true);
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

function ServerAvatar({ server }: { server: CreatorDiscordServerDto }) {
  return server.iconUrl ? (
    <img src={server.iconUrl} alt="" className="h-10 w-10 rounded-full" />
  ) : (
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
      {server.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export interface CreatorDiscordProps {
  /** The API's Discord sign-in just finished (`?discord=pick`): show the "pick a server" step. */
  pickRequested: boolean;
  onPickDone: () => void;
}

/**
 * The optional "Discord server" section. Twitch-only streamers never need it. Connecting a server unlocks the
 * Discord <-> Twitch chat bridge, Discord posts from channel-point rewards, and the server's combined leaderboard.
 * Honest by construction: everything shown comes from the API, and a server can only be connected after signing into
 * Discord to prove you manage it.
 */
export function CreatorDiscord({ pickRequested, onPickDone }: CreatorDiscordProps) {
  const statusQuery = useCreatorDiscordStatus();

  if (statusQuery.error) {
    return <ErrorState error={statusQuery.error} onRetry={() => statusQuery.refetch()} />;
  }
  if (statusQuery.isLoading || !statusQuery.data) return <Skeleton className="h-40 w-full" />;
  const status = statusQuery.data;

  return (
    <section aria-labelledby="discord-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="discord-heading" className="text-lg font-semibold">
          Discord server <span className="text-sm font-normal text-muted-foreground">(optional)</span>
        </h2>
        <p className="text-sm text-muted-foreground">
          Everything above works without Discord. Connect a server you manage to also bridge your Twitch chat with a
          Discord channel, let channel-point rewards post into Discord, and see one leaderboard across both.
        </p>
      </div>

      {!status.hasChannel ? (
        <Card>
          <CardContent className="p-6">
            <EmptyState
              title="Connect the chat bot first"
              description="Pavisie has to be in your Twitch chat before you can connect a Discord server to it."
            />
          </CardContent>
        </Card>
      ) : !status.configured ? (
        <Alert variant="warning">
          <AlertDescription>Connecting a Discord server is not available on this deployment.</AlertDescription>
        </Alert>
      ) : status.linked ? (
        <>
          {pickRequested ? <PickAlreadyLinkedNote onDone={onPickDone} /> : null}
          <LinkedCard status={status} />
          {status.verified ? <BridgeSection /> : null}
        </>
      ) : (
        <>
          {pickRequested ? <PickServerCard onDone={onPickDone} /> : null}
          {!pickRequested ? <ConnectCard /> : null}
        </>
      )}
    </section>
  );
}

function ConnectCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connect a Discord server</CardTitle>
        <CardDescription>
          You&apos;ll sign into Discord once so Pavisie can check which servers you manage that Pavisie is in. Pavisie
          reads that list a single time and does not keep your Discord sign-in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button asChild>
          <a href={creatorDiscordConnectUrl}>
            <MessageSquare className="h-4 w-4" />
            Connect a Discord server
          </a>
        </Button>
        <p className="text-xs text-muted-foreground">
          Pavisie must already be in the server. You need the Manage Server permission there (or be its owner).
        </p>
      </CardContent>
    </Card>
  );
}

function PickAlreadyLinkedNote({ onDone }: { onDone: () => void }) {
  React.useEffect(() => {
    onDone();
  }, [onDone]);
  return null;
}

/** After the Discord sign-in: choose one of the servers you manage where Pavisie is a member. */
function PickServerCard({ onDone }: { onDone: () => void }) {
  const candidates = useCreatorDiscordCandidates(true);
  const link = useLinkCreatorDiscord();
  const { toast } = useToast();
  const [linkingId, setLinkingId] = React.useState<string | null>(null);

  function choose(server: CreatorDiscordServerDto) {
    setLinkingId(server.id);
    link.mutate(server.id, {
      onSuccess: () => {
        toast({ title: `Connected ${server.name}`, description: 'Pavisie has been turned on for chat there.', variant: 'success' });
        onDone();
      },
      onError: (err) => {
        setLinkingId(null);
        errorToast(toast, 'Could not connect that server')(err);
      },
    });
  }

  if (candidates.error) return <ErrorState error={candidates.error} onRetry={() => candidates.refetch()} />;
  if (candidates.isLoading || !candidates.data) return <Skeleton className="h-32 w-full" />;
  const data = candidates.data;

  if (!data.pending) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <p className="text-sm">Your Discord sign-in has expired. Sign in again to pick a server.</p>
          <div className="flex gap-2">
            <Button asChild>
              <a href={creatorDiscordConnectUrl}>Connect a Discord server</a>
            </Button>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Choose a server</CardTitle>
        <CardDescription>Servers you manage where Pavisie is a member.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.candidates.length === 0 ? (
          <EmptyState
            title="No matching servers"
            description="None of the servers you manage have Pavisie in them yet. Add Pavisie to a server you manage, then connect again."
            action={
              <Button asChild variant="outline">
                <a href={`${API_BASE_URL}/auth/invite`} target="_blank" rel="noreferrer">
                  Add Pavisie to a server
                </a>
              </Button>
            }
          />
        ) : (
          <ul className="divide-y rounded-md border">
            {data.candidates.map((server) => (
              <li key={server.id} className="flex items-center justify-between gap-3 p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <ServerAvatar server={server} />
                  <span className="truncate text-sm font-medium">{server.name}</span>
                </div>
                <Button size="sm" onClick={() => choose(server)} disabled={link.isPending}>
                  {linkingId === server.id ? 'Connecting…' : 'Connect'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </CardContent>
    </Card>
  );
}

function LinkedCard({ status }: { status: CreatorDiscordStatusDto }) {
  const unlink = useUnlinkCreatorDiscord();
  const { toast } = useToast();
  const [confirming, setConfirming] = React.useState(false);

  function confirmUnlink() {
    unlink.mutate(undefined, {
      onSuccess: () => {
        setConfirming(false);
        toast({ title: 'Discord server disconnected', variant: 'success' });
      },
      onError: errorToast(toast, 'Could not disconnect the server'),
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex min-w-0 items-center gap-3">
          {status.server ? <ServerAvatar server={status.server} /> : null}
          <div className="min-w-0 space-y-1">
            <CardTitle className="truncate text-base">
              {status.server ? status.server.name : 'A Discord server is connected'}
            </CardTitle>
            <CardDescription>
              {status.verified
                ? status.linkedAt
                  ? `Connected ${new Date(status.linkedAt).toLocaleDateString()}`
                  : 'Connected'
                : 'Linked from the server\'s own Discord dashboard'}
            </CardDescription>
          </div>
        </div>
        <Badge variant={status.verified ? 'success' : 'secondary'}>{status.verified ? 'connected' : 'not verified'}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status.verified ? (
          <Alert variant="warning">
            <AlertTitle>Reconnect to manage it here</AlertTitle>
            <AlertDescription>
              This server was linked from its own Discord dashboard, so it can&apos;t be managed from here yet. Disconnect it,
              then connect it again (you&apos;ll sign into Discord once) to set up the bridge and Discord rewards.
            </AlertDescription>
          </Alert>
        ) : null}

        {!status.integrationsEnabled ? (
          <Alert variant="warning">
            <AlertTitle>Your chat bot is paused</AlertTitle>
            <AlertDescription>
              Pavisie&apos;s Integrations plugin is off in this Discord server, and the chat bot only runs while it is on.
              Turn it back on from the server&apos;s Pavisie dashboard, or disconnect the server.
            </AlertDescription>
          </Alert>
        ) : null}

        <Button variant="outline" size="sm" onClick={() => setConfirming(true)} disabled={unlink.isPending}>
          Disconnect server
        </Button>
      </CardContent>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Disconnect this Discord server?"
        description="The chat bridge is switched off, and any channel-point rewards that post to Discord are removed. Your commands, timers, currency and other rewards stay. You can connect a server again later."
        variant="destructive"
        confirmLabel="Disconnect"
        loading={unlink.isPending}
        onConfirm={confirmUnlink}
      />
    </Card>
  );
}

/** The Discord <-> Twitch chat bridge of the connected server: a channel picker and two switches, both off by default. */
function BridgeSection() {
  const bridge = useCreatorDiscordBridge(true);
  const update = useUpdateCreatorDiscordBridge();
  const { toast } = useToast();

  if (bridge.error) return <ErrorState error={bridge.error} onRetry={() => bridge.refetch()} />;
  if (bridge.isLoading || !bridge.data) return <Skeleton className="h-40 w-full" />;
  const data = bridge.data;
  const onError = errorToast(toast, 'Could not update the bridge');

  return (
    <TwitchChatBridgeCard
      channelSelect={
        <CreatorDiscordChannelSelect
          guildId=""
          value={data.discordChannelId}
          onChange={(next) => update.mutate({ discordChannelId: next }, { onError })}
          placeholder="Select a channel…"
          disabled={update.isPending}
        />
      }
      hasChannel={Boolean(data.discordChannelId)}
      discordToTwitch={data.discordToTwitch}
      twitchToDiscord={data.twitchToDiscord}
      onToggleDiscordToTwitch={() => update.mutate({ discordToTwitch: !data.discordToTwitch }, { onError })}
      onToggleTwitchToDiscord={() => update.mutate({ twitchToDiscord: !data.twitchToDiscord }, { onError })}
      pending={update.isPending}
      lastError={data.lastError}
    />
  );
}
