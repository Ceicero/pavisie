'use client';

import * as React from 'react';
import type { TicketsSettingsDto } from '@pavisie/types/tickets';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
} from '@pavisie/ui';
import { ApiClientError } from '@/lib/dashboard/api';
import { useTicketSettings, useUpdateTicketSettings } from '@/lib/dashboard/tickets-queries';
import { DiscordChannelSelect } from '../discord-selects';
import { ErrorState } from '../error-state';
import { MultiRolePicker } from '../multi-role-picker';
import { IntakeFormBuilder } from './intake-form-builder';

export interface TicketsSettingsTabProps {
  guildId: string;
}

type Draft = TicketsSettingsDto;

export function TicketsSettingsTab({ guildId }: TicketsSettingsTabProps) {
  const { data, isLoading, error, refetch } = useTicketSettings(guildId);
  const update = useUpdateTicketSettings(guildId);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<Draft | null>(null);

  React.useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleSave() {
    if (!draft) return;
    update.mutate(draft, {
      onSuccess: () => toast({ title: 'Ticket settings saved', variant: 'success' }),
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
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(data) : false;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Defaults</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Default mode" hint="Used by /ticket open and any panel that doesn't override it.">
            <Select
              value={draft.mode}
              onValueChange={(v) => set('mode', v as Draft['mode'])}
              disabled={update.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="channel">Private channel</SelectItem>
                <SelectItem value="thread">Private thread</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Default category" hint="Parent category for channel-mode tickets.">
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.categoryId}
              onChange={(v) => set('categoryId', v)}
              disabled={update.isPending}
              kinds={['category']}
            />
          </FormField>
          <FormField label="Default support roles" className="sm:col-span-2">
            <MultiRolePicker
              guildId={guildId}
              value={draft.supportRoleIds}
              onChange={(v) => set('supportRoleIds', v)}
              disabled={update.isPending}
            />
          </FormField>
          <FormField label="Max open tickets per user">
            <Input
              type="number"
              min={1}
              max={10}
              value={draft.maxOpenPerUser}
              disabled={update.isPending}
              onChange={(e) => set('maxOpenPerUser', Number(e.target.value) || 1)}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>SLA</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Default response SLA (minutes)"
            hint="Blank/0 disables the default SLA. Panels can override this."
          >
            <Input
              type="number"
              min={0}
              value={draft.slaMinutes ?? ''}
              placeholder="No SLA"
              disabled={update.isPending}
              onChange={(e) => set('slaMinutes', e.target.value === '' ? null : Number(e.target.value))}
            />
          </FormField>
          <FormField
            label="Alert channel"
            hint="SLA-breach alerts are also posted here (in addition to the ticket itself)."
          >
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.alertChannelId}
              onChange={(v) => set('alertChannelId', v)}
              disabled={update.isPending}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transcripts</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Transcript channel" hint="Closing summary + HTML transcript are posted here.">
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.transcriptChannelId}
              onChange={(v) => set('transcriptChannelId', v)}
              disabled={update.isPending}
            />
          </FormField>
          <FormField label="Transcript retention (days)">
            <Input
              type="number"
              min={1}
              max={3650}
              value={draft.transcriptRetentionDays}
              disabled={update.isPending}
              onChange={(e) => set('transcriptRetentionDays', Number(e.target.value) || 90)}
            />
          </FormField>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3 sm:col-span-2">
            <div>
              <p className="text-sm font-medium">DM the transcript to the ticket opener</p>
              <p className="text-xs text-muted-foreground">
                Sent on close, in addition to the transcript channel.
              </p>
            </div>
            <Switch
              checked={draft.dmTranscript}
              onCheckedChange={(v) => set('dmTranscript', v)}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Closing behavior</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              label="Reopen window (hours)"
              hint="How long after close a ticket can be reopened. 0 disables reopening."
            >
              <Input
                type="number"
                min={0}
                max={720}
                value={draft.reopenWindowHours}
                disabled={update.isPending}
                onChange={(e) => set('reopenWindowHours', Number(e.target.value) || 0)}
              />
            </FormField>
            <FormField
              label="Delete closed channel after (seconds)"
              hint="Only applies to channel-mode tickets, and only when channels aren't kept."
            >
              <Input
                type="number"
                min={0}
                value={draft.deleteAfterCloseSeconds}
                disabled={update.isPending || draft.keepClosedChannels}
                onChange={(e) => set('deleteAfterCloseSeconds', Number(e.target.value) || 0)}
              />
            </FormField>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Never auto-delete closed channels</p>
              <p className="text-xs text-muted-foreground">
                Closed channels stay (with the opener's access removed) instead of being deleted.
              </p>
            </div>
            <Switch
              checked={draft.keepClosedChannels}
              onCheckedChange={(v) => set('keepClosedChannels', v)}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Intake form</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            Asked in a modal when a ticket is opened from a panel with the &quot;intake&quot; toggle on. New
            panels snapshot this list at creation time.
          </p>
          <IntakeFormBuilder
            value={draft.intakeForm}
            onChange={(v) => set('intakeForm', v)}
            disabled={update.isPending}
          />
        </CardContent>
      </Card>
    </div>
  );
}
