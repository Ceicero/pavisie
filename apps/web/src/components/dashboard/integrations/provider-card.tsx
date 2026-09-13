'use client';

import { CheckCircle2, XCircle } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@pavisie/ui';
import type {
  IntegrationConnectionDetailDto,
  IntegrationLiveStatusDto,
  IntegrationProviderInfoDto,
} from '@pavisie/types/integrations';

export interface ProviderCardProps {
  provider: IntegrationProviderInfoDto;
  watchCount?: number;
  onAddWatch?: () => void;
  /** Every (non-chat-kind) connection for this provider, in the order `useConnections` returned them
   * (`createdAt: desc`) — unlimited, not just the first one. A guild can have any number of connections per
   * provider (several Twitch broadcasters, several Reddit subreddits, ...), so this is always an array, never
   * a single optional connection. */
  connections?: IntegrationConnectionDetailDto[];
  /** Per-connection "live now" status (Twitch only today — see `apps/api/src/lib/integrations/live-status.ts`).
   * A connectionId absent from this map, same as one present with `live: null`, means "unknown" and renders
   * no pill at all — never a fabricated online/offline state. */
  liveByConnectionId?: Map<string, IntegrationLiveStatusDto>;
  onConnect?: () => void;
  /** Disconnects one specific row's connection — a provider can have many, so there is no single "the" connection. */
  onDisconnect?: (connectionId: string) => void;
  connectPending?: boolean;
  /** The connectionId currently being disconnected, if any — disables only that row's button, not every row. */
  disconnectingConnectionId?: string | null;
}

const KIND_LABEL: Record<IntegrationProviderInfoDto['kind'], string> = {
  oauth: 'OAuth',
  apikey: 'Server API key',
  public: 'Public API',
  webhook: 'Webhook',
};

/** Section B of the multi-account-integrations spec: a small badge + dot per connection row, driven entirely
 * by data the DTO already carries (`status`) — no new persisted state. */
const STATUS_META: Record<
  IntegrationConnectionDetailDto['status'],
  { variant: 'success' | 'warning' | 'destructive' | 'secondary'; label: string; dotClassName: string }
> = {
  connected: { variant: 'success', label: 'Connected', dotClassName: 'bg-success' },
  pending: { variant: 'warning', label: 'Finishing setup', dotClassName: 'bg-warning' },
  error: { variant: 'destructive', label: 'Needs attention', dotClassName: 'bg-destructive' },
  disconnected: { variant: 'secondary', label: 'Disconnected', dotClassName: 'bg-muted-foreground' },
};

/** Falls back label -> "Account <first 6 chars of id>" so a row is never blank — some connections (e.g. the
 * generic Twitch OAuth-connect flow, which never calls Helix to identify the account) have neither
 * `externalAccountName` nor `label` set. */
function connectionDisplayName(connection: IntegrationConnectionDetailDto): string {
  if (connection.externalAccountName) return connection.externalAccountName;
  if (connection.label) return connection.label;
  return `Account ${connection.id.slice(0, 6)}`;
}

export function ProviderCard({
  provider,
  watchCount,
  onAddWatch,
  connections = [],
  liveByConnectionId,
  onConnect,
  onDisconnect,
  connectPending,
  disconnectingConnectionId,
}: ProviderCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <CardTitle className="text-base">{provider.name}</CardTitle>
        {provider.available ? (
          <Badge variant="success">Available</Badge>
        ) : (
          <Badge variant="secondary">Not configured</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {provider.available ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {KIND_LABEL[provider.kind]}
        </p>
        {!provider.available && provider.missingEnv.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            The operator needs to set: <span className="font-mono">{provider.missingEnv.join(', ')}</span>
          </p>
        ) : null}

        {provider.kind === 'oauth' && onConnect && onDisconnect ? (
          <div className="space-y-2 pt-1">
            {connections.map((connection) => {
              const meta = STATUS_META[connection.status];
              const live = liveByConnectionId?.get(connection.id);
              const isDisconnectingThis = disconnectingConnectionId === connection.id;
              return (
                <div key={connection.id} className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="truncate text-xs text-muted-foreground">
                      {connectionDisplayName(connection)}
                    </span>
                    <Badge
                      variant={meta.variant}
                      title={
                        connection.status === 'error' && connection.lastError ? connection.lastError : undefined
                      }
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClassName}`} />
                      {meta.label}
                    </Badge>
                    {/* Twitch/YouTube only, and only when we just verified it — see IntegrationLiveStatusDto.
                        `false`/`null`/unresolved all render nothing, which reads as "not confirmed live"
                        without asserting an offline state we never checked. */}
                    {live?.live ? <Badge variant="destructive">LIVE</Badge> : null}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onDisconnect(connection.id)}
                    disabled={isDisconnectingThis}
                  >
                    {isDisconnectingThis ? 'Disconnecting…' : 'Disconnect'}
                  </Button>
                </div>
              );
            })}
            <Button
              size="sm"
              variant="outline"
              onClick={onConnect}
              disabled={!provider.available || connectPending}
            >
              {connectPending ? 'Starting…' : connections.length > 0 ? 'Connect another account' : 'Connect'}
            </Button>
          </div>
        ) : null}

        {provider.supportsAlerts ? (
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-xs text-muted-foreground">
              {watchCount ?? 0} watch{watchCount === 1 ? '' : 'es'}
            </span>
            <Button size="sm" variant="outline" onClick={onAddWatch} disabled={!provider.available}>
              Add watch
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
