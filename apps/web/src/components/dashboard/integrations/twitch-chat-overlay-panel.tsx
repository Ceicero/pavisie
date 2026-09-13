'use client';

import * as React from 'react';
import {
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
import type { TwitchChatChannelDto } from '@pavisie/types/integrations';
import {
  useRegenerateTwitchChatOverlay,
  useTwitchChatOverlay,
  useUpdateTwitchChatChannel,
} from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';

export interface TwitchChatOverlayPanelProps {
  guildId: string;
  channel: TwitchChatChannelDto;
}

export function TwitchChatOverlayPanel({ guildId, channel }: TwitchChatOverlayPanelProps) {
  const { data: overlay, isLoading, error, refetch } = useTwitchChatOverlay(guildId, channel.id);
  const updateChannel = useUpdateTwitchChatChannel(guildId);
  const regenerate = useRegenerateTwitchChatOverlay(guildId);
  const { toast } = useToast();
  const [regenerating, setRegenerating] = React.useState(false);

  function toggleRewardsEnabled() {
    updateChannel.mutate(
      { channelId: channel.id, patch: { rewardsEnabled: !channel.rewardsEnabled } },
      {
        onError: (err) =>
          toast({
            title: 'Could not update rewards',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  function confirmRegenerate() {
    regenerate.mutate(
      { channelId: channel.id },
      {
        onSuccess: () => {
          toast({ title: 'Overlay URL regenerated', variant: 'success' });
          setRegenerating(false);
        },
        onError: (err) =>
          toast({
            title: 'Could not regenerate the overlay',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  function copyUrl() {
    if (overlay?.url) {
      navigator.clipboard.writeText(overlay.url);
      toast({ title: 'URL copied', variant: 'success' });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Rewards overlay</CardTitle>
        <CardDescription>Browser source for OBS / Streamlabs / similar</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField label="Rewards alerts enabled">
          <Switch
            checked={channel.rewardsEnabled}
            onCheckedChange={toggleRewardsEnabled}
            disabled={updateChannel.isPending}
            aria-label="Enable rewards alerts in overlay"
          />
        </FormField>

        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : overlay && overlay.url ? (
          <div className="space-y-3">
            <FormField label="Overlay URL" hint="Keep this secret — anyone with the link can see alerts.">
              <div className="flex items-center gap-2">
                <Input value={overlay.url} readOnly className="text-xs" />
                <Button size="sm" variant="outline" onClick={copyUrl}>
                  Copy
                </Button>
              </div>
            </FormField>

            <div className="space-y-2 rounded-md bg-muted p-3 text-sm">
              <p className="font-medium">Add to OBS:</p>
              <ol className="list-inside list-decimal space-y-1 text-xs text-muted-foreground">
                <li>Sources → Add → Browser Source (or text source with URL)</li>
                <li>Paste the URL above</li>
                <li>Set size to match your stream (e.g., 1920×1080)</li>
              </ol>
            </div>

            <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-xs text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-100">
              Anyone with this link can watch your alerts. Regenerate it if it leaks.
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setRegenerating(true)}
              disabled={regenerate.isPending}
            >
              Regenerate URL
            </Button>
          </div>
        ) : overlay && overlay.hasToken ? (
          <p className="text-sm text-muted-foreground">Overlay URL created. Refresh to view.</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No overlay created yet. Enable rewards alerts to generate one.
          </p>
        )}
      </CardContent>

      <ConfirmDialog
        open={regenerating}
        onOpenChange={setRegenerating}
        title="Regenerate overlay URL?"
        description="The old link will stop working. Anyone using it will lose access to the alerts."
        variant="destructive"
        confirmLabel="Regenerate"
        loading={regenerate.isPending}
        onConfirm={confirmRegenerate}
      />
    </Card>
  );
}
