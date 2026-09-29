'use client';

import * as React from 'react';
import { Copy, Eye, EyeOff, KeyRound, Link2 } from 'lucide-react';
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
  FormField,
  Input,
  Skeleton,
  Switch,
  useToast,
} from '@pavisie/ui';
import type { CreatorRewardsStatusDto } from '@pavisie/types/creator';
import { ApiClientError } from '@/lib/dashboard/api';
import {
  creatorTwitchRewardsBackend,
  useAuthorizeCreatorChannelPoints,
  useClearCreatorTtsKey,
  useCreatorRewardsOverlay,
  useCreatorRewardsStatus,
  useCreatorTwitchChannel,
  useDisconnectCreatorChannelPoints,
  useResetCreatorRewardsOverlay,
  useSetCreatorRewardsEnabled,
  useSetCreatorTtsKey,
} from '@/lib/creator/queries';
import { isPlausibleOpenAiKey } from '@/lib/creator/tts-key';
import { ConfirmDialog } from '@/components/dashboard/confirm-dialog';
import { ErrorState } from '@/components/dashboard/error-state';
import { CreatorDiscordChannelSelect } from './creator-discord';
import { TwitchChatRewardsTable } from '@/components/dashboard/integrations/twitch-chat-rewards-table';

function errorToast(toast: ReturnType<typeof useToast>['toast'], title: string) {
  return (err: unknown) =>
    toast({
      title,
      description: err instanceof ApiClientError ? err.message : 'Please try again.',
      variant: 'destructive',
    });
}

/**
 * The "Channel points" section: connect channel points (Twitch permission to see redemptions), the on/off switch,
 * your rewards, the OBS overlay URL and your own text-to-speech key. It works with no Discord server. Honest by
 * construction: everything shown comes from the API, and rewards can only be switched on once Pavisie really holds
 * the permission it needs.
 */
export function CreatorChannelPoints() {
  const statusQuery = useCreatorRewardsStatus();
  const channelQuery = useCreatorTwitchChannel();

  if (statusQuery.error) {
    return <ErrorState error={statusQuery.error} onRetry={() => statusQuery.refetch()} />;
  }
  if (statusQuery.isLoading || !statusQuery.data || !channelQuery.data) {
    return <Skeleton className="h-40 w-full" />;
  }
  // The chat-bot section above already explains a deployment without Twitch credentials.
  if (!channelQuery.data.envConfigured) return null;

  const status = statusQuery.data;
  const channelId = channelQuery.data.channel?.id ?? null;

  return (
    <section aria-labelledby="channel-points-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="channel-points-heading" className="text-lg font-semibold">
          Channel points
        </h2>
        <p className="text-sm text-muted-foreground">
          Turn your channel-point rewards into actions on stream: play a sound on your OBS overlay, read the
          viewer&apos;s message aloud, post to your chat, or (with a Discord server connected below) post to Discord.
        </p>
      </div>

      <AuthorizationCard status={status} />

      {channelId ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Rewards</CardTitle>
              <CardDescription>
                A reward runs when a viewer redeems a channel-point reward with the same title on Twitch.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TwitchChatRewardsTable
                backend={creatorTwitchRewardsBackend}
                discordChannelSelect={status.discordVerified ? CreatorDiscordChannelSelect : undefined}
                channelId={channelId}
                maxRewards={status.maxRewards}
              />
            </CardContent>
          </Card>
          <OverlayCard status={status} />
          <TtsKeyCard status={status} />
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Connect + master switch
// ---------------------------------------------------------------------------------------------------------------

function AuthorizationCard({ status }: { status: CreatorRewardsStatusDto }) {
  const authorize = useAuthorizeCreatorChannelPoints();
  const disconnect = useDisconnectCreatorChannelPoints();
  const setEnabled = useSetCreatorRewardsEnabled();
  const { toast } = useToast();
  const [confirmingDisconnect, setConfirmingDisconnect] = React.useState(false);

  function startAuthorize() {
    authorize.mutate(undefined, {
      onSuccess: (result) => window.location.assign(result.url),
      onError: errorToast(toast, 'Could not start the Twitch connection'),
    });
  }

  function confirmDisconnect() {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        toast({ title: 'Channel points disconnected', variant: 'success' });
        setConfirmingDisconnect(false);
      },
      onError: errorToast(toast, 'Could not disconnect channel points'),
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Connection</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {status.authorized ? (
              <Badge variant="success">connected</Badge>
            ) : status.authorizationError ? (
              <Badge variant="destructive">needs re-connecting</Badge>
            ) : (
              <Badge variant="secondary">not connected</Badge>
            )}
            {status.authorized && status.rewardsEnabled ? <Badge variant="success">rewards on</Badge> : null}
          </div>
        </div>
        {status.authorized ? (
          <div className="flex items-center gap-3">
            <Switch
              checked={status.rewardsEnabled}
              onCheckedChange={(next) =>
                setEnabled.mutate(next, { onError: errorToast(toast, 'Could not update channel-point rewards') })
              }
              disabled={setEnabled.isPending}
              aria-label="Channel-point rewards on"
            />
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDisconnect(true)}>
              Disconnect
            </Button>
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        {status.authorizationError ? (
          <Alert variant="destructive">
            <AlertTitle>Pavisie lost permission to see your redemptions</AlertTitle>
            <AlertDescription>
              {status.authorizationError} Connect channel points again to fix this.
            </AlertDescription>
          </Alert>
        ) : null}

        {!status.authorized ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Twitch only lets the channel owner share redemptions, so you will be asked to approve one permission:
              seeing which channel-point rewards your viewers redeem. Pavisie keeps that permission encrypted until you
              disconnect it here. It never spends your points and never changes your rewards on Twitch.
            </p>
            <Button onClick={startAuthorize} disabled={authorize.isPending}>
              <Link2 className="h-4 w-4" />
              {authorize.isPending ? 'Starting…' : status.authorizationError ? 'Connect again' : 'Connect channel points'}
            </Button>
          </div>
        ) : null}

        {status.channelExists && !status.channelEnabled ? (
          <Alert variant="warning">
            <AlertDescription>
              Your chat bot is switched off in the Chat bot section, and rewards only run while it is on.
            </AlertDescription>
          </Alert>
        ) : null}

        {status.authorized && !status.rewardsEnabled ? (
          <p className="text-xs text-muted-foreground">
            Rewards are off. Add your rewards below, then switch rewards on.
          </p>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        title="Disconnect channel points?"
        description="Pavisie forgets its permission to see your redemptions and switches rewards off. Your rewards, overlay link and TTS key are kept, and you can connect again any time."
        variant="destructive"
        confirmLabel="Disconnect"
        loading={disconnect.isPending}
        onConfirm={confirmDisconnect}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// OBS overlay URL (a secret: hidden until revealed, shown only to you)
// ---------------------------------------------------------------------------------------------------------------

function OverlayCard({ status }: { status: CreatorRewardsStatusDto }) {
  const overlayQuery = useCreatorRewardsOverlay(status.hasOverlay);
  const reset = useResetCreatorRewardsOverlay();
  const { toast } = useToast();
  const [revealed, setRevealed] = React.useState(false);
  const [confirmingReset, setConfirmingReset] = React.useState(false);

  const url = overlayQuery.data?.url ?? null;

  function create() {
    reset.mutate(undefined, {
      onSuccess: () => toast({ title: 'Overlay link created', variant: 'success' }),
      onError: errorToast(toast, 'Could not create the overlay link'),
    });
  }

  function confirmReset() {
    reset.mutate(undefined, {
      onSuccess: () => {
        setRevealed(false);
        setConfirmingReset(false);
        toast({ title: 'Overlay link reset', description: 'Paste the new link into OBS.', variant: 'success' });
      },
      onError: errorToast(toast, 'Could not reset the overlay link'),
    });
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Link copied', variant: 'success' });
    } catch {
      toast({ title: 'Could not copy', description: 'Reveal the link and copy it by hand.', variant: 'destructive' });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">OBS overlay</CardTitle>
        <CardDescription>
          A browser source that plays your sound and text-to-speech rewards on stream.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status.hasOverlay ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">You have not created your overlay link yet.</p>
            <Button onClick={create} disabled={reset.isPending}>
              {reset.isPending ? 'Creating…' : 'Create overlay link'}
            </Button>
          </div>
        ) : overlayQuery.error ? (
          <ErrorState error={overlayQuery.error} onRetry={() => overlayQuery.refetch()} />
        ) : overlayQuery.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : url ? (
          <div className="space-y-3">
            <FormField label="Overlay link" hint="Secret: anyone with this link can watch your alerts.">
              <div className="flex items-center gap-2">
                <Input
                  type={revealed ? 'text' : 'password'}
                  value={url}
                  readOnly
                  autoComplete="off"
                  className="font-mono text-xs"
                  aria-label="Overlay link"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRevealed((v) => !v)}
                  aria-label={revealed ? 'Hide the link' : 'Show the link'}
                >
                  {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void copy()}>
                  <Copy className="h-4 w-4" />
                  Copy
                </Button>
              </div>
            </FormField>
            <ol className="list-inside list-decimal space-y-1 rounded-md bg-muted p-3 text-xs text-muted-foreground">
              <li>In OBS, add a Browser source.</li>
              <li>Paste the link as the URL, and set the size to match your canvas (for example 1920 by 1080).</li>
              <li>Tick &quot;Control audio via OBS&quot; so you can set the volume there.</li>
            </ol>
            <Button variant="outline" size="sm" onClick={() => setConfirmingReset(true)} disabled={reset.isPending}>
              Reset link
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Your overlay link exists but can no longer be shown. Reset it to get a new one.
            </p>
            <Button variant="outline" size="sm" onClick={() => setConfirmingReset(true)} disabled={reset.isPending}>
              Reset link
            </Button>
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmingReset}
        onOpenChange={setConfirmingReset}
        title="Reset the overlay link?"
        description="The current link stops working right away. Your OBS browser source will go blank until you paste in the new link."
        variant="destructive"
        confirmLabel="Reset link"
        loading={reset.isPending}
        onConfirm={confirmReset}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Text-to-speech key (bring your own; write-only)
// ---------------------------------------------------------------------------------------------------------------

function TtsKeyCard({ status }: { status: CreatorRewardsStatusDto }) {
  const setKey = useSetCreatorTtsKey();
  const clearKey = useClearCreatorTtsKey();
  const { toast } = useToast();
  const [draft, setDraft] = React.useState('');
  const [confirmingRemove, setConfirmingRemove] = React.useState(false);

  const trimmed = draft.trim();
  const valid = isPlausibleOpenAiKey(trimmed);

  function save() {
    if (!valid) return;
    setKey.mutate(trimmed, {
      onSuccess: () => {
        setDraft(''); // never keep the key in the page once it is saved
        toast({ title: 'TTS key saved', variant: 'success' });
      },
      onError: errorToast(toast, 'Could not save the key'),
    });
  }

  function confirmRemove() {
    clearKey.mutate(undefined, {
      onSuccess: () => {
        setConfirmingRemove(false);
        toast({ title: 'TTS key removed', variant: 'success' });
      },
      onError: errorToast(toast, 'Could not remove the key'),
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Text-to-speech key</CardTitle>
          <CardDescription>
            Reading a viewer&apos;s message aloud uses your own OpenAI account: you pay OpenAI directly, Pavisie never
            pays for speech.
          </CardDescription>
        </div>
        {status.ttsKeyConfigured ? <Badge variant="success">key saved</Badge> : <Badge variant="secondary">no key</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          label={status.ttsKeyConfigured ? 'Replace your OpenAI API key' : 'Your OpenAI API key'}
          hint="Stored encrypted and never shown again. Used only to turn your TTS rewards into speech."
          error={draft.length > 0 && !valid ? 'An OpenAI key starts with "sk-" and has no spaces.' : undefined}
        >
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
              disabled={setKey.isPending}
            />
            <Button size="sm" onClick={save} disabled={!valid || setKey.isPending}>
              <KeyRound className="h-4 w-4" />
              {setKey.isPending ? 'Saving…' : 'Save key'}
            </Button>
          </div>
        </FormField>

        {status.ttsKeyConfigured ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(true)} disabled={clearKey.isPending}>
            Remove key
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            Without a key, text-to-speech rewards stay silent
            {status.discordLinked ? " (unless your Discord server's AI plugin has an OpenAI key, which is used instead)" : ''}.
          </p>
        )}
        {status.ttsKeyConfigured && status.discordLinked ? (
          <p className="text-xs text-muted-foreground">
            This key is used instead of your Discord server&apos;s AI-plugin key.
          </p>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Remove your TTS key?"
        description="Text-to-speech rewards stop speaking until you add a key again."
        variant="destructive"
        confirmLabel="Remove key"
        loading={clearKey.isPending}
        onConfirm={confirmRemove}
      />
    </Card>
  );
}
