'use client';

import * as React from 'react';
import type { ModerationAppealDto } from '@pavisie/types/moderation';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useToast,
} from '@pavisie/ui';
import { ErrorState } from '../error-state';
import { formatDateTime } from '@/lib/dashboard/format';
import { useDecideAppeal, useModerationAppeals } from '@/lib/dashboard/moderation-queries';
import { ApiClientError } from '@/lib/dashboard/api';

const STATUS_BADGE: Record<ModerationAppealDto['status'], 'warning' | 'success' | 'destructive'> = {
  PENDING: 'warning',
  ACCEPTED: 'success',
  DENIED: 'destructive',
};

export function AppealsTab({ guildId }: { guildId: string }) {
  const [statusFilter, setStatusFilter] = React.useState('PENDING');
  const { data, isLoading, error, refetch } = useModerationAppeals(
    guildId,
    statusFilter === 'ALL' ? undefined : statusFilter,
  );
  const decide = useDecideAppeal(guildId);
  const { toast } = useToast();

  const [pending, setPending] = React.useState<{ appeal: ModerationAppealDto; accept: boolean } | null>(null);
  const [note, setNote] = React.useState('');

  function openDecision(appeal: ModerationAppealDto, accept: boolean) {
    setPending({ appeal, accept });
    setNote('');
  }

  function confirmDecision() {
    if (!pending) return;
    decide.mutate(
      { appealId: pending.appeal.id, accept: pending.accept, decisionNote: note || undefined },
      {
        onSuccess: () => {
          toast({ title: pending.accept ? 'Appeal accepted' : 'Appeal denied', variant: 'success' });
          setPending(null);
        },
        onError: (err) =>
          toast({
            title: 'Could not decide appeal',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Label htmlFor="appeal-status-filter" className="text-sm text-muted-foreground">
          Status
        </Label>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger id="appeal-status-filter" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="ACCEPTED">Accepted</SelectItem>
            <SelectItem value="DENIED">Denied</SelectItem>
            <SelectItem value="ALL">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (data?.items ?? []).length === 0 ? (
        <EmptyState title="No appeals" description="Appeals opened with /appeal will show up here." />
      ) : (
        <ul className="space-y-3">
          {data?.items.map((appeal) => (
            <li key={appeal.id} className="rounded-md border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    <span className="font-mono">{appeal.userId}</span>
                    {appeal.caseNumber ? <> — Case #{appeal.caseNumber}</> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(appeal.createdAt)}</p>
                </div>
                <Badge variant={STATUS_BADGE[appeal.status]}>{appeal.status}</Badge>
              </div>
              <p className="mt-2 text-sm">{appeal.content}</p>
              {appeal.decisionNote ? (
                <p className="mt-2 text-xs italic text-muted-foreground">Staff note: {appeal.decisionNote}</p>
              ) : null}
              {appeal.status === 'PENDING' ? (
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => openDecision(appeal, true)}>
                    Accept
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => openDecision(appeal, false)}>
                    Deny
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.accept ? 'Accept' : 'Deny'} this appeal?</DialogTitle>
            <DialogDescription>
              {pending?.accept
                ? 'Accepting a timeout case removes it immediately. Accepting a ban case only offers an "Unban now" button in Discord — it isn\'t automatic.'
                : 'The user will be notified that their appeal was denied.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="decision-note">Note to the user (optional)</Label>
            <Textarea id="decision-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={decide.isPending}>
              Cancel
            </Button>
            <Button
              variant={pending?.accept ? 'default' : 'destructive'}
              onClick={confirmDecision}
              disabled={decide.isPending}
            >
              {decide.isPending ? 'Working…' : pending?.accept ? 'Accept appeal' : 'Deny appeal'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
