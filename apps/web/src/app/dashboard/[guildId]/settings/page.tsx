'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
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
import { useGuildConfig, useUpdateGuildConfig, type GuildConfigPatch } from '@/lib/dashboard/queries';
import { ErrorState } from '@/components/dashboard/error-state';
import { MultiRolePicker } from '@/components/dashboard/multi-role-picker';
import { DiscordChannelSelect } from '@/components/dashboard/discord-selects';
import { ApiClientError } from '@/lib/dashboard/api';

const LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'ja', label: 'Japanese' },
];

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

export default function SettingsPage() {
  const { guildId } = useParams<{ guildId: string }>();
  const { data, isLoading, error, refetch } = useGuildConfig(guildId);
  const update = useUpdateGuildConfig(guildId);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<GuildConfigPatch | null>(null);

  React.useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  function set<K extends keyof GuildConfigPatch>(key: K, val: GuildConfigPatch[K]) {
    setDraft((prev) => ({ ...prev, [key]: val }));
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
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(data) : false;

  return (
    <div className="space-y-6 pb-24">
      <PageHeader
        title="Settings"
        description="Staff roles, logging channels, locale, and privacy defaults for this server."
        actions={
          <Button onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Staff roles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormField label="Admin roles" hint="Full access to configuration, in addition to Manage Server.">
            <MultiRolePicker
              guildId={guildId}
              value={draft.adminRoleIds ?? []}
              onChange={(v) => set('adminRoleIds', v)}
              disabled={update.isPending}
            />
          </FormField>
          <FormField label="Moderator roles" hint="Can use moderation commands and the mod dashboard.">
            <MultiRolePicker
              guildId={guildId}
              value={draft.modRoleIds ?? []}
              onChange={(v) => set('modRoleIds', v)}
              disabled={update.isPending}
            />
          </FormField>
          <FormField label="Helper roles" hint="Lowest staff tier — flag review, tickets, limited commands.">
            <MultiRolePicker
              guildId={guildId}
              value={draft.helperRoleIds ?? []}
              onChange={(v) => set('helperRoleIds', v)}
              disabled={update.isPending}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Mod log channel" hint="Moderation case embeds are posted here.">
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.modLogChannelId ?? null}
              onChange={(v) => set('modLogChannelId', v)}
              disabled={update.isPending}
            />
          </FormField>
          <FormField
            label="Staff channel"
            hint="Internal alerts (flag queue, review queue) post here by default."
          >
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.staffChannelId ?? null}
              onChange={(v) => set('staffChannelId', v)}
              disabled={update.isPending}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Locale &amp; timezone</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Locale">
            <Select
              value={draft.locale ?? 'en'}
              onValueChange={(v) => set('locale', v)}
              disabled={update.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCALES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Timezone" hint="Used for scheduled announcements, reminders, and timestamps.">
            <Select
              value={draft.timezone ?? 'UTC'}
              onValueChange={(v) => set('timezone', v)}
              disabled={update.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Moderation behavior</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Fast actions</p>
              <p className="text-xs text-muted-foreground">
                Skip the confirm/cancel step for kick, ban, softban, and small purges.
              </p>
            </div>
            <Switch
              checked={Boolean(draft.fastActions)}
              onCheckedChange={(v) => set('fastActions', v)}
              disabled={update.isPending}
            />
          </div>
          {draft.fastActions ? (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>Fast actions are on</AlertTitle>
              <AlertDescription>
                Moderators won&apos;t be asked to confirm destructive actions before they happen. Large purges
                (over 100 messages) still require confirmation regardless of this setting.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">DM users on moderation action</p>
              <p className="text-xs text-muted-foreground">
                Send a direct message explaining the action and how to appeal.
              </p>
            </div>
            <Switch
              checked={Boolean(draft.dmOnModeration)}
              onCheckedChange={(v) => set('dmOnModeration', v)}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Data collection &amp; privacy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Enable analytics data collection</p>
              <p className="text-xs text-muted-foreground">
                Stores aggregated daily counts (member growth, moderation volume, message activity) so the
                Analytics page has data. No message content is ever included. Off by default.
              </p>
            </div>
            <Switch
              checked={Boolean(draft.dataCollectionEnabled)}
              onCheckedChange={(v) => set('dataCollectionEnabled', v)}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Log message content on edit/delete</p>
              <p className="text-xs text-muted-foreground">
                When off (default), edit/delete logs record metadata only — no message text is stored. Only
                enable this if your moderation needs require it and members have been informed.
              </p>
            </div>
            <Switch
              checked={Boolean(draft.logMessageContent)}
              onCheckedChange={(v) => set('logMessageContent', v)}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
