'use client';

import * as React from 'react';
import { usePathname, useParams, useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@pavisie/ui';
import type { AlertProviderId, IntegrationLiveStatusDto } from '@pavisie/types/integrations';
import {
  groupConnectionsByProvider,
  useAlertConnections,
  useConnectionsLive,
  useConnectProvider,
  useConnections,
  useDisconnectConnection,
  useIntegrationProviders,
  type CreateInboundWebhookResult,
  type CreateOutboundWebhookResult,
} from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ErrorState } from '@/components/dashboard/error-state';
import { AlertFormDialog } from '@/components/dashboard/integrations/alert-form-dialog';
import { AlertsList } from '@/components/dashboard/integrations/alerts-list';
import { ProviderCard } from '@/components/dashboard/integrations/provider-card';
import { InboundWebhookDialog } from '@/components/dashboard/integrations/inbound-webhook-dialog';
import { InboundWebhooksList } from '@/components/dashboard/integrations/inbound-webhooks-list';
import { OutboundWebhookDialog } from '@/components/dashboard/integrations/outbound-webhook-dialog';
import { OutboundWebhooksList } from '@/components/dashboard/integrations/outbound-webhooks-list';
import { SecretRevealDialog } from '@/components/dashboard/integrations/secret-reveal-dialog';
import { TwitchChatMovedNotice } from '@/components/dashboard/integrations/twitch-chat-moved-notice';

/** Readable messages for the `?error=` codes an OAuth callback redirects back with when it bails out instead of
 * completing. Falls back to a generic message for any code not in this table, so a new error redirect never renders as
 * a raw, un-mapped code. The old `twitch-chat-already-linked` code went away with the Discord-side Twitch chat connect
 * (creator-dashboard phase 4), so a stale link carrying it just gets the generic message. */
const OAUTH_CALLBACK_ERROR_MESSAGES: Record<string, string> = {};

export default function IntegrationsPage() {
  const { guildId } = useParams<{ guildId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const providersQuery = useIntegrationProviders(guildId);
  const alertsQuery = useAlertConnections(guildId);
  const connectionsQuery = useConnections(guildId);
  const liveQuery = useConnectionsLive(guildId);
  const connectProvider = useConnectProvider(guildId);
  const disconnectConnection = useDisconnectConnection(guildId);
  const { toast } = useToast();

  const [addAlertProvider, setAddAlertProvider] = React.useState<AlertProviderId | 'pick' | null>(null);
  const [inboundDialogOpen, setInboundDialogOpen] = React.useState(false);
  const [outboundDialogOpen, setOutboundDialogOpen] = React.useState(false);
  const [revealed, setRevealed] = React.useState<{ title: string; url?: string; secret: string } | null>(
    null,
  );
  /** The connection currently mid-disconnect, so only that row's button (not every row's) shows "Disconnecting…". */
  const [disconnectingConnectionId, setDisconnectingConnectionId] = React.useState<string | null>(null);

  // Surfaces the OAuth callback's `?error=...` redirect as a readable toast instead of leaving it as a silent, unexplained query string — then strips it from the
  // URL so refreshing the page doesn't re-show the same toast.
  React.useEffect(() => {
    const error = searchParams.get('error');
    if (!error) return;
    toast({
      title: 'Could not connect',
      description:
        OAUTH_CALLBACK_ERROR_MESSAGES[error] ??
        'Something went wrong finishing that connection. Please try again.',
      variant: 'destructive',
    });
    router.replace(pathname);
    // Deliberately keyed on `searchParams` alone (not `toast`/`router`/`pathname`, which don't change
    // meaningfully here) — this must fire once per incoming `?error=`, not on every render.
  }, [searchParams]);

  const watchCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const conn of alertsQuery.data ?? []) {
      counts.set(conn.provider.toLowerCase(), (counts.get(conn.provider.toLowerCase()) ?? 0) + 1);
    }
    return counts;
  }, [alertsQuery.data]);

  const connectionsByProvider = React.useMemo(
    () => groupConnectionsByProvider(connectionsQuery.data ?? []),
    [connectionsQuery.data],
  );

  const liveByConnectionId = React.useMemo(() => {
    const map = new Map<string, IntegrationLiveStatusDto>();
    for (const status of liveQuery.data ?? []) map.set(status.connectionId, status);
    return map;
  }, [liveQuery.data]);

  function handleConnect(providerId: string) {
    connectProvider.mutate(providerId, {
      onSuccess: (result) => {
        if (result.url) window.location.assign(result.url);
        else toast({ title: 'Connected', variant: 'success' });
      },
      onError: (err) =>
        toast({
          title: 'Could not connect',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  function handleDisconnect(connectionId: string) {
    setDisconnectingConnectionId(connectionId);
    disconnectConnection.mutate(connectionId, {
      onSuccess: () => toast({ title: 'Disconnected', variant: 'success' }),
      onError: (err) =>
        toast({
          title: 'Could not disconnect',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
      onSettled: () => setDisconnectingConnectionId(null),
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Get Twitch, YouTube, Instagram, Reddit and Steam alerts, calendar reminders, and your own webhooks in Discord. Every connector is optional and off until you set it up."
      />

      <Card>
        <CardHeader>
          <CardTitle>Providers</CardTitle>
        </CardHeader>
        <CardContent>
          {providersQuery.error ? (
            <ErrorState error={providersQuery.error} onRetry={() => providersQuery.refetch()} />
          ) : providersQuery.isLoading || !providersQuery.data ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-32 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {providersQuery.data.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  watchCount={watchCounts.get(provider.id)}
                  onAddWatch={() => setAddAlertProvider(provider.id as AlertProviderId)}
                  connections={connectionsByProvider.get(provider.id)}
                  liveByConnectionId={liveByConnectionId}
                  onConnect={() => handleConnect(provider.id)}
                  onDisconnect={handleDisconnect}
                  connectPending={connectProvider.isPending}
                  disconnectingConnectionId={disconnectingConnectionId}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <TwitchChatMovedNotice guildId={guildId} />

      <Tabs defaultValue="alerts">
        <TabsList>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="inbound">Inbound webhooks</TabsTrigger>
          <TabsTrigger value="outbound">Outbound webhooks</TabsTrigger>
        </TabsList>

        <TabsContent value="alerts" className="space-y-4 pt-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAddAlertProvider('pick')}>
              <Plus className="h-4 w-4" /> Add watch
            </Button>
          </div>
          <AlertsList guildId={guildId} />
        </TabsContent>

        <TabsContent value="inbound" className="space-y-4 pt-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setInboundDialogOpen(true)}>
              <Plus className="h-4 w-4" /> Create webhook
            </Button>
          </div>
          <InboundWebhooksList guildId={guildId} />
        </TabsContent>

        <TabsContent value="outbound" className="space-y-4 pt-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setOutboundDialogOpen(true)}>
              <Plus className="h-4 w-4" /> Create webhook
            </Button>
          </div>
          <OutboundWebhooksList guildId={guildId} />
        </TabsContent>

      </Tabs>

      <AlertFormDialog
        guildId={guildId}
        open={addAlertProvider !== null}
        onOpenChange={(open) => !open && setAddAlertProvider(null)}
        provider={addAlertProvider && addAlertProvider !== 'pick' ? addAlertProvider : undefined}
      />

      <InboundWebhookDialog
        guildId={guildId}
        open={inboundDialogOpen}
        onOpenChange={setInboundDialogOpen}
        onCreated={(result: CreateInboundWebhookResult) =>
          setRevealed({ title: 'Inbound webhook created', url: result.url, secret: result.secret })
        }
      />

      <OutboundWebhookDialog
        guildId={guildId}
        open={outboundDialogOpen}
        onOpenChange={setOutboundDialogOpen}
        onCreated={(result: CreateOutboundWebhookResult) =>
          setRevealed({ title: 'Outbound webhook created', secret: result.secret })
        }
      />

      {revealed ? (
        <SecretRevealDialog
          open
          onOpenChange={(open) => !open && setRevealed(null)}
          title={revealed.title}
          url={revealed.url}
          secret={revealed.secret}
        />
      ) : null}
    </div>
  );
}
