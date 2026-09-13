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
import { useRolePersistence, useSetRolePersistence } from '@/lib/dashboard/roles-queries';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';

export function PersistenceTab({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useRolePersistence(guildId);
  const setPersistence = useSetRolePersistence(guildId);
  const { toast } = useToast();

  const [maxDays, setMaxDays] = React.useState(30);

  React.useEffect(() => {
    if (data) setMaxDays(data.maxDays);
  }, [data]);

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  function handleToggle(enabled: boolean) {
    setPersistence.mutate(
      { enabled, maxDays, acknowledge: enabled },
      {
        onSuccess: () =>
          toast({ title: `Role persistence is now ${enabled ? 'on' : 'off'}`, variant: 'success' }),
        onError: (err) =>
          toast({
            title: 'Could not save',
            description: err instanceof ApiClientError ? err.message : undefined,
            variant: 'destructive',
          }),
      },
    );
  }

  function handleSaveDays() {
    // Guarded by the `!data` early return above; this closure is only reachable after that guard passed for
    // the render it was created in.
    setPersistence.mutate(
      { enabled: data!.enabled, maxDays },
      { onSuccess: () => toast({ title: 'Restore window updated', variant: 'success' }) },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Role persistence</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <ShieldCheck />
          <AlertTitle>Disclosure</AlertTitle>
          <AlertDescription>{data.disclosure}</AlertDescription>
        </Alert>

        <div className="flex items-center justify-between rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium">Enabled</p>
            <p className="text-xs text-muted-foreground">
              Off by default. Turning this on is logged to the audit log.
            </p>
          </div>
          <Switch checked={data.enabled} onCheckedChange={handleToggle} disabled={setPersistence.isPending} />
        </div>

        <FormField label="Restore window (days)">
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              max={365}
              value={maxDays}
              onChange={(e) => setMaxDays(Number(e.target.value))}
            />
            <Button variant="outline" onClick={handleSaveDays} disabled={setPersistence.isPending}>
              Save
            </Button>
          </div>
        </FormField>
      </CardContent>
    </Card>
  );
}
