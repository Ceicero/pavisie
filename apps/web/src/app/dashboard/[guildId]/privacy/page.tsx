'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { Download, ShieldAlert, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  Input,
  PageHeader,
  Skeleton,
  useToast,
} from '@pavisie/ui';
import {
  useDataRequests,
  useRequestDataDelete,
  useRequestDataExport,
  useRetention,
  useUpdateRetention,
} from '@/lib/dashboard/queries';
import { ErrorState } from '@/components/dashboard/error-state';
import { ConfirmDialog } from '@/components/dashboard/confirm-dialog';
import { ApiClientError } from '@/lib/dashboard/api';
import { formatDateTime } from '@/lib/dashboard/format';
import type { DataRequestDto, RetentionPolicyDto } from '@pavisie/types';

const STATUS_VARIANT: Record<DataRequestDto['status'], 'default' | 'success' | 'destructive' | 'secondary'> =
  {
    pending: 'secondary',
    processing: 'default',
    completed: 'success',
    failed: 'destructive',
    cancelled: 'secondary',
  };

type RetentionDraft = Partial<Omit<RetentionPolicyDto, 'guildId' | 'updatedAt'>>;

const RETENTION_FIELDS: { key: keyof RetentionDraft; label: string; hint: string }[] = [
  {
    key: 'moderationRetentionDays',
    label: 'Moderation cases',
    hint: 'Days to keep resolved moderation cases. Leave blank to keep indefinitely.',
  },
  {
    key: 'logRetentionDays',
    label: 'Log events',
    hint: 'Days to keep join/leave, edit/delete, and role-change log entries.',
  },
  {
    key: 'ticketTranscriptRetentionDays',
    label: 'Ticket transcripts',
    hint: 'Days to keep closed ticket transcripts.',
  },
  {
    key: 'automodEventRetentionDays',
    label: 'Automod events',
    hint: 'Days to keep automod trigger events, including dry-run logs.',
  },
];

export default function PrivacyPage() {
  const { guildId } = useParams<{ guildId: string }>();
  const { data: retention, isLoading, error, refetch } = useRetention(guildId);
  const updateRetention = useUpdateRetention(guildId);
  const { data: requests, refetch: refetchRequests } = useDataRequests(guildId);
  const requestExport = useRequestDataExport(guildId);
  const requestDelete = useRequestDataDelete(guildId);
  const { toast } = useToast();

  const [draft, setDraft] = React.useState<RetentionDraft | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  React.useEffect(() => {
    if (retention) setDraft(retention);
  }, [retention]);

  function setField(key: keyof RetentionDraft, value: number | null) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleSaveRetention() {
    if (!draft) return;
    updateRetention.mutate(draft, {
      onSuccess: () => toast({ title: 'Retention policy saved', variant: 'success' }),
      onError: (err) =>
        toast({
          title: 'Could not save policy',
          description: err instanceof ApiClientError ? err.message : undefined,
          variant: 'destructive',
        }),
    });
  }

  function handleExport() {
    requestExport.mutate(undefined, {
      onSuccess: () => {
        toast({
          title: 'Export requested',
          description: 'We will list it below once it is ready to download.',
          variant: 'success',
        });
        void refetchRequests();
      },
      onError: (err) =>
        toast({
          title: 'Could not start export',
          description: err instanceof ApiClientError ? err.message : undefined,
          variant: 'destructive',
        }),
    });
  }

  function handleDelete() {
    // apps/api's routes/privacy.ts requires `confirm` to exactly match this guild's name or id;
    // the guild id is always available here (unlike the name, which would need an extra fetch),
    // and doubles as the phrase the user is asked to type below.
    requestDelete.mutate(guildId, {
      onSuccess: () => {
        toast({ title: 'Deletion requested', variant: 'success' });
        setDeleteOpen(false);
        void refetchRequests();
      },
      onError: (err) =>
        toast({
          title: 'Could not start deletion',
          description: err instanceof ApiClientError ? err.message : undefined,
          variant: 'destructive',
        }),
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Privacy &amp; data retention"
        description="Control how long Pavisie keeps this server's data, and export or delete it."
      />

      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Retention policy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading || !draft ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {RETENTION_FIELDS.map((field) => (
                    <FormField key={field.key} label={field.label} hint={field.hint}>
                      <Input
                        type="number"
                        min={1}
                        placeholder="Indefinite"
                        value={draft[field.key] ?? ''}
                        onChange={(e) =>
                          setField(field.key, e.target.value === '' ? null : Number(e.target.value))
                        }
                      />
                    </FormField>
                  ))}
                </div>
                <Button onClick={handleSaveRetention} disabled={updateRetention.isPending}>
                  {updateRetention.isPending ? 'Saving…' : 'Save policy'}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Export server data</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Generates a JSON export of this server&apos;s Pavisie data (config, moderation cases, tickets,
            and similar records). Large exports can take a few minutes to prepare.
          </p>
          <Button variant="outline" onClick={handleExport} disabled={requestExport.isPending}>
            <Download className="h-4 w-4" />
            {requestExport.isPending ? 'Requesting…' : 'Request export'}
          </Button>

          {requests && requests.length > 0 ? (
            <div className="space-y-2 pt-2">
              {requests.map((req) => (
                <div
                  key={req.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm"
                >
                  <div>
                    <p className="font-medium capitalize">{req.type}</p>
                    <p className="text-xs text-muted-foreground">Requested {formatDateTime(req.createdAt)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_VARIANT[req.status]} className="capitalize">
                      {req.status}
                    </Badge>
                    {req.status === 'completed' && req.resultUrl ? (
                      <Button size="sm" variant="outline" asChild>
                        <a href={req.resultUrl}>Download</a>
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No requests yet"
              description="Export and deletion requests will show up here."
            />
          )}
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="h-4 w-4" />
            Delete server data
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Permanently deletes this server&apos;s Pavisie data — moderation cases, tickets, automod rules,
            configuration, and everything else stored for this guild. This does not remove the bot from your
            server or affect Discord itself. This cannot be undone.
          </p>
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-4 w-4" />
            Delete all server data
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete all server data?"
        description="This permanently deletes every record Pavisie has for this server. This cannot be undone."
        confirmLabel="Delete permanently"
        variant="destructive"
        loading={requestDelete.isPending}
        onConfirm={handleDelete}
        typedConfirmationPhrase={guildId}
      />
    </div>
  );
}
