'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  EscalationRuleDto,
  ModerationSettingsDto,
  RequireReasonAction,
} from '@pavisie/types/moderation';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
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
import { DiscordChannelSelect } from '../discord-selects';
import { ErrorState } from '../error-state';
import { useModerationSettings, useUpdateModerationSettings } from '@/lib/dashboard/moderation-queries';
import { ApiClientError } from '@/lib/dashboard/api';

const REQUIRE_REASON_OPTIONS: RequireReasonAction[] = ['kick', 'ban', 'softban'];
const ESCALATION_ACTIONS: EscalationRuleDto['action'][] = ['timeout', 'kick', 'ban'];

function emptyRule(): EscalationRuleDto {
  return { warnings: 3, action: 'timeout', durationMs: 3_600_000 };
}

export function SettingsTab({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useModerationSettings(guildId);
  const update = useUpdateModerationSettings(guildId);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<ModerationSettingsDto | null>(null);

  React.useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  function set<K extends keyof ModerationSettingsDto>(key: K, value: ModerationSettingsDto[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function toggleRequireReason(action: RequireReasonAction, checked: boolean) {
    if (!draft) return;
    const next = checked
      ? [...draft.requireReasonFor, action]
      : draft.requireReasonFor.filter((a) => a !== action);
    set('requireReasonFor', next);
  }

  function updateRule(index: number, patch: Partial<EscalationRuleDto>) {
    if (!draft) return;
    const next = draft.escalations.map((rule, i) => (i === index ? { ...rule, ...patch } : rule));
    set('escalations', next);
  }

  function addRule() {
    if (!draft) return;
    set('escalations', [...draft.escalations, emptyRule()]);
  }

  function removeRule(index: number) {
    if (!draft) return;
    set(
      'escalations',
      draft.escalations.filter((_, i) => i !== index),
    );
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
          <CardTitle>Channels</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Mod-log channel override"
            hint="Leave unset to use the server's default mod-log channel (Settings page)."
          >
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.modLogChannelId}
              onChange={(v) => set('modLogChannelId', v)}
              disabled={update.isPending}
            />
          </FormField>
          <FormField
            label="Appeals channel override"
            hint="Leave unset to use the server's appeals or staff channel."
          >
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.appealsChannelId}
              onChange={(v) => set('appealsChannelId', v)}
              disabled={update.isPending}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Behavior</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">DM users on moderation action</p>
              <p className="text-xs text-muted-foreground">
                Also requires the server-wide &quot;DM on moderation action&quot; toggle (Settings page) to be
                on — both must allow it.
              </p>
            </div>
            <Switch
              checked={draft.dmOnAction}
              onCheckedChange={(v) => set('dmOnAction', v)}
              disabled={update.isPending}
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Allow temporary bans</p>
              <p className="text-xs text-muted-foreground">Lets /mod ban accept a duration option.</p>
            </div>
            <Switch
              checked={draft.tempBanEnabled}
              onCheckedChange={(v) => set('tempBanEnabled', v)}
              disabled={update.isPending}
            />
          </div>
          <FormField
            label="Purge limit"
            hint="Maximum messages /mod purge can delete at once (Discord's own cap is 100)."
          >
            <Input
              type="number"
              min={1}
              max={100}
              value={draft.purgeMax}
              onChange={(e) => set('purgeMax', Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
              disabled={update.isPending}
              className="max-w-32"
            />
          </FormField>
          <FormField label="Require a reason for">
            <div className="flex gap-4">
              {REQUIRE_REASON_OPTIONS.map((action) => (
                <label key={action} className="flex items-center gap-2 text-sm capitalize">
                  <Checkbox
                    checked={draft.requireReasonFor.includes(action)}
                    onCheckedChange={(checked) => toggleRequireReason(action, checked === true)}
                    disabled={update.isPending}
                  />
                  {action}
                </label>
              ))}
            </div>
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Warning escalation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            When a member reaches exactly this many active warnings, the action fires automatically.
          </p>
          {draft.escalations.map((rule, index) => (
            <div key={index} className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
              <FormField label="Warnings">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={rule.warnings}
                  onChange={(e) => updateRule(index, { warnings: Number(e.target.value) || 1 })}
                  disabled={update.isPending}
                  className="w-24"
                />
              </FormField>
              <FormField label="Action">
                <Select
                  value={rule.action}
                  onValueChange={(v) => updateRule(index, { action: v as EscalationRuleDto['action'] })}
                  disabled={update.isPending}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ESCALATION_ACTIONS.map((a) => (
                      <SelectItem key={a} value={a} className="capitalize">
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              {rule.action !== 'kick' ? (
                <FormField
                  label="Duration (minutes)"
                  hint={
                    rule.action === 'timeout'
                      ? 'Required for timeout.'
                      : 'Optional — omit for a permanent ban.'
                  }
                >
                  <Input
                    type="number"
                    min={1}
                    value={rule.durationMs ? Math.round(rule.durationMs / 60000) : ''}
                    onChange={(e) => {
                      const minutes = Number(e.target.value);
                      updateRule(index, { durationMs: minutes > 0 ? minutes * 60000 : undefined });
                    }}
                    disabled={update.isPending}
                    className="w-32"
                  />
                </FormField>
              ) : null}
              <Button
                variant="outline"
                size="icon"
                onClick={() => removeRule(index)}
                disabled={update.isPending}
                aria-label="Remove rule"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addRule} disabled={update.isPending}>
            <Plus className="h-4 w-4" />
            Add rule
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
