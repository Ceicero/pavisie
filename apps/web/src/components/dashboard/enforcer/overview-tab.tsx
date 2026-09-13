'use client';

import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from '@pavisie/ui';
import { usePlugins } from '@/lib/dashboard/queries';
import { useEnforcerSettings } from '@/lib/dashboard/enforcer-queries';
import { ErrorState } from '../error-state';

export interface OverviewTabProps {
  guildId: string;
}

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-border p-3">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      )}
      <div>
        <p className="text-sm font-medium">{label}</p>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </div>
    </div>
  );
}

export function OverviewTab({ guildId }: OverviewTabProps) {
  const { data: plugins, isLoading: pluginsLoading, error: pluginsError, refetch } = usePlugins(guildId);
  const { data: settings, isLoading: settingsLoading } = useEnforcerSettings(guildId);

  if (pluginsError) return <ErrorState error={pluginsError} onRetry={() => refetch()} />;
  if (pluginsLoading || settingsLoading || !plugins || !settings) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  const enforcerPlugin = plugins.find((p) => p.id === 'enforcer');
  const moderationPlugin = plugins.find((p) => p.id === 'moderation');
  // Enforcer declares exactly one privileged intent (MessageContent) and no required env vars, so it can only
  // ever be fully available or available-but-degraded — an availabilityReason at all means that intent is off.
  const hasMessageContentIntent = !enforcerPlugin?.availabilityReason;

  return (
    <div className="space-y-6">
      {!moderationPlugin?.enabled ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>The moderation plugin is not enabled</AlertTitle>
          <AlertDescription>
            Enforcer executes every decision through the moderation plugin (cases, hierarchy checks, appeals).
            Enable it from the Plugins page first.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Setup status</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <StatusRow
            ok={Boolean(enforcerPlugin?.enabled)}
            label="Enforcer enabled"
            detail={enforcerPlugin?.enabled ? undefined : 'Enable it from the Plugins page.'}
          />
          <StatusRow
            ok={Boolean(moderationPlugin?.enabled)}
            label="Moderation plugin enabled"
            detail={moderationPlugin?.enabled ? undefined : 'Required — decisions cannot execute without it.'}
          />
          <StatusRow
            ok={Boolean(settings.ledgerChannelId)}
            label="Ledger channel configured"
            detail={
              settings.ledgerChannelId
                ? `Visibility: ${settings.ledgerVisibility}`
                : 'Set it in the Settings tab or run /enforcer setup.'
            }
          />
          <StatusRow
            ok={Boolean(settings.flagChannelId)}
            label="Flag-queue channel configured"
            detail={settings.flagChannelId ? undefined : 'Set it in the Settings tab or run /enforcer setup.'}
          />
          <StatusRow
            ok={Boolean(settings.muteRoleId)}
            label="Mute role configured"
            detail={settings.muteRoleId ? undefined : 'Optional — required only for the Mute decision.'}
          />
          <StatusRow
            ok={hasMessageContentIntent}
            label="Message Content intent"
            detail={
              hasMessageContentIntent
                ? 'Automatic flagging is active.'
                : 'Off — manual flagging only (context menu / /enforcer flag).'
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Privacy &amp; transparency</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          {(enforcerPlugin?.privacyNotes ?? []).map((note, i) => (
            <p key={i}>{note}</p>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
