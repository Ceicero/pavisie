'use client';

import * as React from 'react';
import { ShieldCheck } from 'lucide-react';
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
  Input,
  Skeleton,
  Switch,
  useToast,
} from '@pavisie/ui';
import { useAutoRoles, useSetAutoRoles } from '@/lib/dashboard/roles-queries';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';
import { MultiRolePicker } from '../multi-role-picker';

const MAX_HUMAN_ROLES = 5;
const MAX_BOT_ROLES = 3;
const MAX_DELAY_SECONDS = 604_800;

/** "10 minutes" / "1.5 hours" / "2 days" helper text for the delay input. */
function describeDelay(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Immediately after the member finishes joining.';
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} after joining.`;
  if (seconds < 3600) {
    const minutes = Math.round((seconds / 60) * 10) / 10;
    return `About ${minutes} minute${minutes === 1 ? '' : 's'} after joining.`;
  }
  if (seconds < 86_400) {
    const hours = Math.round((seconds / 3600) * 10) / 10;
    return `About ${hours} hour${hours === 1 ? '' : 's'} after joining.`;
  }
  const days = Math.round((seconds / 86_400) * 10) / 10;
  return `About ${days} day${days === 1 ? '' : 's'} after joining.`;
}

export function AutoRolesTab({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useAutoRoles(guildId);
  const setAutoRoles = useSetAutoRoles(guildId);
  const { toast } = useToast();

  const [roleIds, setRoleIds] = React.useState<string[]>([]);
  const [botRoleIds, setBotRoleIds] = React.useState<string[]>([]);
  const [delaySeconds, setDelaySeconds] = React.useState(0);

  React.useEffect(() => {
    if (data) {
      setRoleIds(data.roleIds);
      setBotRoleIds(data.botRoleIds);
      setDelaySeconds(data.delaySeconds);
    }
  }, [data]);

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const delayInvalid =
    !Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS;
  const dirty =
    delaySeconds !== data.delaySeconds ||
    roleIds.join(',') !== data.roleIds.join(',') ||
    botRoleIds.join(',') !== data.botRoleIds.join(',');

  function onError(err: unknown) {
    toast({
      title: 'Could not save',
      description: err instanceof ApiClientError ? err.message : undefined,
      variant: 'destructive',
    });
  }

  /** Removing is always allowed; adding past `max` is refused with a toast (mirrors the bot's `autorole.limit` reply). */
  function limitedSet(next: string[], max: number, set: (v: string[]) => void) {
    if (next.length > max) {
      toast({ title: `You can pick at most ${max} roles here`, variant: 'destructive' });
      return;
    }
    set(next);
  }

  function handleToggle(enabled: boolean) {
    setAutoRoles.mutate(
      { enabled },
      {
        onSuccess: () => toast({ title: `Auto-roles are now ${enabled ? 'on' : 'off'}`, variant: 'success' }),
        onError,
      },
    );
  }

  function handleSave() {
    if (delayInvalid) return;
    setAutoRoles.mutate(
      { roleIds, botRoleIds, delaySeconds },
      { onSuccess: () => toast({ title: 'Auto-roles saved', variant: 'success' }), onError },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Auto-roles on join</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <ShieldCheck />
          <AlertTitle>Safety check at assignment time</AlertTitle>
          <AlertDescription>{data.note}</AlertDescription>
        </Alert>

        <div className="flex items-center justify-between rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium">Enabled</p>
            <p className="text-xs text-muted-foreground">
              Off by default. Roles are given once a member finishes joining (after Discord&apos;s membership
              screening, if your server uses it). Every assignment is written to the audit log.
            </p>
          </div>
          <Switch checked={data.enabled} onCheckedChange={handleToggle} disabled={setAutoRoles.isPending} />
        </div>

        <FormField
          label={`Roles for human members (${roleIds.length}/${MAX_HUMAN_ROLES})`}
          hint="Given to every new human member."
        >
          <MultiRolePicker
            guildId={guildId}
            value={roleIds}
            onChange={(next) => limitedSet(next, MAX_HUMAN_ROLES, setRoleIds)}
            disabled={setAutoRoles.isPending}
          />
          {roleIds.length >= MAX_HUMAN_ROLES ? (
            <p className="text-xs text-muted-foreground">Limit reached — remove a role to add another.</p>
          ) : null}
        </FormField>

        <FormField
          label={`Roles for bots (${botRoleIds.length}/${MAX_BOT_ROLES})`}
          hint="Given to bot accounts instead of the human list."
        >
          <MultiRolePicker
            guildId={guildId}
            value={botRoleIds}
            onChange={(next) => limitedSet(next, MAX_BOT_ROLES, setBotRoleIds)}
            disabled={setAutoRoles.isPending}
          />
          {botRoleIds.length >= MAX_BOT_ROLES ? (
            <p className="text-xs text-muted-foreground">Limit reached — remove a role to add another.</p>
          ) : null}
        </FormField>

        <FormField
          label="Delay (seconds)"
          hint={describeDelay(delaySeconds)}
          error={
            delayInvalid ? `Enter a whole number between 0 and ${MAX_DELAY_SECONDS} (7 days).` : undefined
          }
        >
          <Input
            type="number"
            min={0}
            max={MAX_DELAY_SECONDS}
            step={1}
            value={delaySeconds}
            onChange={(e) => setDelaySeconds(Number(e.target.value))}
            disabled={setAutoRoles.isPending}
          />
        </FormField>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={setAutoRoles.isPending || delayInvalid || !dirty}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
