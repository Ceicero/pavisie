'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
} from '@pavisie/ui';
import { usePluginConfig, useUpdatePluginConfig } from '@/lib/dashboard/queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ErrorState } from '../error-state';
import { DiscordChannelSelect, DiscordRoleSelect } from '../discord-selects';

/** Mirrors `packages/plugins/src/automod/manifest.ts`'s `configSchema` (hand-kept in sync; the dashboard doesn't depend on `@pavisie/plugins`). */
export interface AutomodPluginConfig {
  dryRun: boolean;
  alertChannelId: string | null;
  quarantineRoleId: string | null;
  exemptStaff: boolean;
  defaultTimeoutMs: number;
  raidLockdown: 'none' | 'raise-verification' | 'quarantine-new-joins';
  raidLockdownMinutes: number;
}

const RAID_LOCKDOWN_OPTIONS: { value: AutomodPluginConfig['raidLockdown']; label: string }[] = [
  { value: 'none', label: 'None (alert only)' },
  { value: 'raise-verification', label: 'Raise verification level' },
  { value: 'quarantine-new-joins', label: 'Quarantine new joins' },
];

/** Settings tab (TASK: "Settings tab") — the `automod` plugin's own guild config: dry-run, alert channel, quarantine role, staff exemption, default timeout, and raid lockdown. */
export function SettingsTab() {
  const { guildId } = useParams<{ guildId: string }>();
  const { data, isLoading, error, refetch } = usePluginConfig<AutomodPluginConfig>(guildId, 'automod');
  const update = useUpdatePluginConfig<AutomodPluginConfig>(guildId, 'automod');
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<AutomodPluginConfig | null>(null);

  React.useEffect(() => {
    if (data) setDraft(data.config);
  }, [data]);

  function set<K extends keyof AutomodPluginConfig>(key: K, value: AutomodPluginConfig[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleSave() {
    if (!draft) return;
    update.mutate(draft, {
      onSuccess: () => toast({ title: 'Settings saved', variant: 'success' }),
      onError: (err) =>
        toast({
          title: 'Could not save settings',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;

  if (isLoading || !draft) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(data.config) : false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Guild-wide automod behavior."
        actions={
          <Button onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        }
      />

      {draft.dryRun ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
          🧪 Guild-wide dry-run is <strong>on</strong> — every rule logs matches without taking real action,
          regardless of each rule&apos;s own dry-run switch.
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Dry-run</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Guild-wide dry-run</p>
              <p className="text-xs text-muted-foreground">
                ORed with each rule&apos;s own dry-run — either being on means "log only".
              </p>
            </div>
            <Switch
              checked={draft.dryRun}
              onCheckedChange={(v) => set('dryRun', v)}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Channels &amp; roles</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Alert channel"
            hint='Where the "alert staff" action and review-queue embeds post.'
          >
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.alertChannelId}
              onChange={(v) => set('alertChannelId', v)}
              disabled={update.isPending}
            />
          </FormField>
          <FormField
            label="Quarantine role"
            hint='Assigned by the "quarantine" action and raid-lockdown quarantine.'
          >
            <DiscordRoleSelect
              guildId={guildId}
              value={draft.quarantineRoleId}
              onChange={(v) => set('quarantineRoleId', v)}
              disabled={update.isPending}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exemptions &amp; defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Exempt staff</p>
              <p className="text-xs text-muted-foreground">
                Members at or above the helper staff level are exempt from every rule.
              </p>
            </div>
            <Switch
              checked={draft.exemptStaff}
              onCheckedChange={(v) => set('exemptStaff', v)}
              disabled={update.isPending}
            />
          </div>
          <FormField
            label="Default timeout (minutes)"
            hint='Used when a "timeout" action doesn&apos;t specify its own duration.'
          >
            <input
              type="number"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
              min={1}
              value={Math.round(draft.defaultTimeoutMs / 60000)}
              disabled={update.isPending}
              onChange={(e) => {
                const minutes = Number(e.target.value);
                if (Number.isFinite(minutes) && minutes > 0) set('defaultTimeoutMs', minutes * 60_000);
              }}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Raid lockdown</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Response"
            hint="Additional guild-wide response to a RAID_DETECTION match. Never bans automatically."
          >
            <Select
              value={draft.raidLockdown}
              onValueChange={(v) => set('raidLockdown', v as AutomodPluginConfig['raidLockdown'])}
              disabled={update.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RAID_LOCKDOWN_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Lockdown duration (minutes)" hint='Only used for "Quarantine new joins".'>
            <input
              type="number"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
              min={1}
              max={1440}
              value={draft.raidLockdownMinutes}
              disabled={update.isPending || draft.raidLockdown !== 'quarantine-new-joins'}
              onChange={(e) => {
                const minutes = Number(e.target.value);
                if (Number.isFinite(minutes) && minutes > 0) set('raidLockdownMinutes', minutes);
              }}
            />
          </FormField>
        </CardContent>
      </Card>
    </div>
  );
}
