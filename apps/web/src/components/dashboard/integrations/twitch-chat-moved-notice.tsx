'use client';

import * as React from 'react';
import Link from 'next/link';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, useToast } from '@pavisie/ui';
import { useTwitchChatGuildLinks, useUnlinkTwitchChatChannel } from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';

/**
 * The Discord dashboard's only Twitch-chat surface since creator-dashboard phase 4 (ARCHITECTURE.md §19e): an honest
 * pointer to where the Twitch chat bot, channel points, currency and chat bridge now live (the creator dashboard, run
 * by the streamer), the Twitch channel(s) linked to THIS server (read-only), and the one thing a server admin can still
 * do — unlink their server from a channel. Unlinking never deletes the streamer's channel or settings.
 */
export function TwitchChatMovedNotice({ guildId }: { guildId: string }) {
  const links = useTwitchChatGuildLinks(guildId);
  const unlink = useUnlinkTwitchChatChannel(guildId);
  const { toast } = useToast();
  const [confirming, setConfirming] = React.useState<{ id: string; login: string } | null>(null);

  function confirmUnlink() {
    if (!confirming) return;
    const target = confirming;
    unlink.mutate(target.id, {
      onSuccess: () => {
        toast({ title: `Unlinked ${target.login}`, variant: 'success' });
        setConfirming(null);
      },
      onError: (err) =>
        toast({
          title: 'Could not unlink the channel',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  const channels = links.data?.channels ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Twitch chat, channel points and currency</CardTitle>
        <CardDescription>
          The Twitch chat bot, channel-point rewards, the Twitch currency and the Discord ↔ Twitch chat bridge are now
          managed by the streamer on the creator dashboard. This page keeps stream-live alerts and webhooks only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link href="/creator">Open the creator dashboard</Link>
        </Button>

        {links.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : links.error ? (
          <p className="text-sm text-muted-foreground">
            Could not check whether a Twitch channel is linked to this server.
          </p>
        ) : channels.length === 0 ? null : (
          <div className="space-y-3">
            <p className="text-sm font-medium">Linked to this server</p>
            {channels.map((channel) => (
              <div
                key={channel.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium">{channel.broadcasterLogin}</p>
                  <div className="flex items-center gap-2">
                    <Badge variant={channel.enabled ? 'secondary' : 'warning'}>
                      {channel.enabled ? 'chat bot on' : 'chat bot off'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The streamer manages this channel from their creator dashboard. Unlinking only disconnects this
                    server: the bridge is switched off and any reward that posts to Discord is removed. The streamer
                    keeps their chat bot, commands, currency and other rewards.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={unlink.isPending}
                  onClick={() => setConfirming({ id: channel.id, login: channel.broadcasterLogin })}
                >
                  Unlink this server
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Unlink ${confirming?.login ?? 'this channel'} from this server?`}
        description="The chat bridge is switched off and any channel-point reward that posts into this server is removed. The streamer's chat bot, commands, timers, currency and other rewards are not touched. They can connect a server again from their creator dashboard."
        variant="destructive"
        confirmLabel="Unlink"
        loading={unlink.isPending}
        onConfirm={confirmUnlink}
      />
    </Card>
  );
}
