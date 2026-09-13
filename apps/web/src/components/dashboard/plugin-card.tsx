'use client';

import type { PluginSummary } from '@pavisie/types';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Switch, useToast } from '@pavisie/ui';
import { useTogglePlugin } from '@/lib/dashboard/queries';
import { ApiClientError } from '@/lib/dashboard/api';

export interface PluginCardProps {
  plugin: PluginSummary;
  guildId: string;
  onConfigure: () => void;
}

/** Plugin marketplace card: enable/disable switch (optimistic + toast), availability/health badges, Configure action. */
export function PluginCard({ plugin, guildId, onConfigure }: PluginCardProps) {
  const toggle = useTogglePlugin(guildId);
  const { toast } = useToast();

  function handleToggle(next: boolean) {
    toggle.mutate(
      { pluginId: plugin.id, enabled: next },
      {
        onSuccess: () =>
          toast({ title: `${plugin.name} ${next ? 'enabled' : 'disabled'}`, variant: 'success' }),
        onError: (err) =>
          toast({
            title: 'Could not update plugin',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="truncate">{plugin.name}</span>
            {plugin.alwaysEnabled ? (
              <Badge variant="outline" className="shrink-0">
                Always on
              </Badge>
            ) : null}
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{plugin.description}</p>
        </div>
        <Switch
          checked={plugin.enabled}
          disabled={plugin.alwaysEnabled || !plugin.available || toggle.isPending}
          onCheckedChange={handleToggle}
          aria-label={`Toggle ${plugin.name}`}
          className="mt-1 shrink-0"
        />
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="capitalize">
          {plugin.category}
        </Badge>
        {!plugin.available ? (
          <Badge variant="destructive">
            Unavailable{plugin.availabilityReason ? `: ${plugin.availabilityReason}` : ''}
          </Badge>
        ) : null}
        {plugin.health && plugin.health.status !== 'ok' ? (
          <Badge
            variant={plugin.health.status === 'unavailable' ? 'destructive' : 'warning'}
            className="capitalize"
          >
            {plugin.health.status}
          </Badge>
        ) : null}
        {plugin.privilegedIntents.length > 0 ? <Badge variant="outline">Privileged intents</Badge> : null}
        <Button variant="outline" size="sm" className="ml-auto" onClick={onConfigure}>
          Configure
        </Button>
      </CardContent>
    </Card>
  );
}
