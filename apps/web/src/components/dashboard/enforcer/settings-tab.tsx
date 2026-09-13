'use client';

import * as React from 'react';
import type { EnforcerSettingsDto } from '@pavisie/types';
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
import { useEnforcerSettings, useUpdateEnforcerSettings } from '@/lib/dashboard/enforcer-queries';
import { DiscordChannelSelect, DiscordRoleSelect } from '../discord-selects';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';

const DECISION_LABELS: Record<string, string> = {
  warn: 'Warn',
  timeout: 'Timeout',
  mute: 'Mute',
  kick: 'Kick',
  ban: 'Ban',
  dismiss: 'Dismiss',
};
const ALL_DECISIONS = ['warn', 'timeout', 'mute', 'kick', 'ban', 'dismiss'];
const REASON_DECISIONS = ['warn', 'timeout', 'mute', 'kick', 'ban'];

function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export interface SettingsTabProps {
  guildId: string;
}

export function SettingsTab({ guildId }: SettingsTabProps) {
  const { data, isLoading, error, refetch } = useEnforcerSettings(guildId);
  const update = useUpdateEnforcerSettings(guildId);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<EnforcerSettingsDto | null>(null);

  React.useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  function set<K extends keyof EnforcerSettingsDto>(key: K, value: EnforcerSettingsDto[K]) {
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
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(data) : false;

  return (
    <div className="space-y-6 pb-16">
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Channels &amp; mute role</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Ledger channel" hint="Every flag and decision is posted here, read-only.">
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.ledgerChannelId}
              onChange={(v) => set('ledgerChannelId', v)}
              disabled={update.isPending}
            />
          </FormField>
          <FormField label="Ledger visibility">
            <Select
              value={draft.ledgerVisibility}
              onValueChange={(v) => set('ledgerVisibility', v as EnforcerSettingsDto['ledgerVisibility'])}
              disabled={update.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="staff">Staff only</SelectItem>
                <SelectItem value="everyone">Everyone (transparency mode)</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label="Flag-queue channel"
            hint="Staff-only — where moderators review and decide on flags."
          >
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.flagChannelId}
              onChange={(v) => set('flagChannelId', v)}
              disabled={update.isPending}
            />
          </FormField>
          <FormField label="Mute role" hint="Required for the Mute/Unmute decisions.">
            <DiscordRoleSelect
              guildId={guildId}
              value={draft.muteRoleId}
              onChange={(v) => set('muteRoleId', v)}
              disabled={update.isPending}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Flagging behavior</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Automatic flagging</p>
              <p className="text-xs text-muted-foreground">
                Matches messages against enabled policies as they're sent. Requires the Message Content
                intent.
              </p>
            </div>
            <Switch
              checked={draft.autoFlagEnabled}
              onCheckedChange={(v) => set('autoFlagEnabled', v)}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Exempt staff from auto-flagging</p>
              <p className="text-xs text-muted-foreground">
                Members with a configured staff role are never auto-flagged.
              </p>
            </div>
            <Switch
              checked={draft.exemptStaff}
              onCheckedChange={(v) => set('exemptStaff', v)}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Capture context</p>
              <p className="text-xs text-muted-foreground">
                Store a short snapshot of the messages before a flagged one, so a moderator can read the exact
                chat context.
              </p>
            </div>
            <Switch
              checked={draft.captureContext}
              onCheckedChange={(v) => set('captureContext', v)}
              disabled={update.isPending}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="Context before (messages)">
              <Input
                type="number"
                min={1}
                max={15}
                value={draft.contextBefore}
                onChange={(e) => set('contextBefore', Number(e.target.value))}
                disabled={update.isPending}
              />
            </FormField>
            <FormField label="Context after (messages)">
              <Input
                type="number"
                min={0}
                max={10}
                value={draft.contextAfter}
                onChange={(e) => set('contextAfter', Number(e.target.value))}
                disabled={update.isPending}
              />
            </FormField>
            <FormField label="Excerpt max chars">
              <Input
                type="number"
                min={50}
                max={1000}
                value={draft.excerptMaxChars}
                onChange={(e) => set('excerptMaxChars', Number(e.target.value))}
                disabled={update.isPending}
              />
            </FormField>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Optional AI risk scoring (assistive only)</p>
              <p className="text-xs text-muted-foreground">
                Annotates a flag with a risk score/explanation. Never decides or acts on its own.
              </p>
            </div>
            <Switch
              checked={draft.aiAssist}
              onCheckedChange={(v) => set('aiAssist', v)}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Decisions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">DM the user on action</p>
              <p className="text-xs text-muted-foreground">
                Sends a message explaining the action, case/record numbers, and how to appeal.
              </p>
            </div>
            <Switch
              checked={draft.dmOnAction}
              onCheckedChange={(v) => set('dmOnAction', v)}
              disabled={update.isPending}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Default timeout (minutes)">
              <Input
                type="number"
                min={1}
                max={40320}
                value={draft.defaultTimeoutMinutes}
                onChange={(e) => set('defaultTimeoutMinutes', Number(e.target.value))}
                disabled={update.isPending}
              />
            </FormField>
            <FormField label="Default mute (minutes)" hint="Leave blank for indefinite.">
              <Input
                type="number"
                min={1}
                max={40320}
                value={draft.defaultMuteMinutes ?? ''}
                onChange={(e) =>
                  set('defaultMuteMinutes', e.target.value === '' ? null : Number(e.target.value))
                }
                disabled={update.isPending}
              />
            </FormField>
            <FormField label="Ban: delete messages from last N seconds">
              <Input
                type="number"
                min={0}
                max={604800}
                value={draft.banDeleteMessageSeconds}
                onChange={(e) => set('banDeleteMessageSeconds', Number(e.target.value))}
                disabled={update.isPending}
              />
            </FormField>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Allowed decisions</p>
            <p className="text-xs text-muted-foreground">
              Decision buttons for anything unchecked are hidden from the flag-queue embed.
            </p>
            <div className="flex flex-wrap gap-4">
              {ALL_DECISIONS.map((d) => (
                <label key={d} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.allowedDecisions.includes(
                      d as EnforcerSettingsDto['allowedDecisions'][number],
                    )}
                    onChange={() =>
                      set(
                        'allowedDecisions',
                        toggleInList(draft.allowedDecisions, d) as EnforcerSettingsDto['allowedDecisions'],
                      )
                    }
                    disabled={update.isPending}
                  />
                  {DECISION_LABELS[d]}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Require a reason</p>
            <div className="flex flex-wrap gap-4">
              {REASON_DECISIONS.map((d) => (
                <label key={d} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.requireReasonOn.includes(
                      d as EnforcerSettingsDto['requireReasonOn'][number],
                    )}
                    onChange={() =>
                      set(
                        'requireReasonOn',
                        toggleInList(draft.requireReasonOn, d) as EnforcerSettingsDto['requireReasonOn'],
                      )
                    }
                    disabled={update.isPending}
                  />
                  {DECISION_LABELS[d]}
                </label>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
