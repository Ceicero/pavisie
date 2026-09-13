'use client';

import * as React from 'react';
import type { EnforcerRecordDto } from '@pavisie/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Textarea,
  useToast,
} from '@pavisie/ui';
import { useDecideEnforcerRecord, type DecideInput } from '@/lib/dashboard/enforcer-queries';
import { ApiClientError } from '@/lib/dashboard/api';

const NEEDS_DURATION: DecideInput['decision'][] = ['TIMEOUT', 'MUTE'];

export interface DecideDialogProps {
  guildId: string;
  record: EnforcerRecordDto | null;
  decision: DecideInput['decision'] | null;
  onOpenChange: (open: boolean) => void;
}

export function DecideDialog({ guildId, record, decision, onOpenChange }: DecideDialogProps) {
  const decide = useDecideEnforcerRecord(guildId);
  const { toast } = useToast();
  const [reason, setReason] = React.useState('');
  const [duration, setDuration] = React.useState('');
  const [deleteDays, setDeleteDays] = React.useState('');

  React.useEffect(() => {
    if (record && decision) {
      setReason('');
      setDuration('');
      setDeleteDays('');
    }
  }, [record, decision]);

  const open = Boolean(record && decision);

  function handleConfirm() {
    if (!record || !decision) return;
    const durationMs = duration.trim() ? parseDurationLoose(duration.trim()) : undefined;
    const banDeleteMessageSeconds =
      decision === 'BAN' && deleteDays.trim()
        ? Math.min(7, Math.max(0, Number(deleteDays))) * 86_400
        : undefined;

    decide.mutate(
      {
        recordNumber: record.recordNumber,
        decision,
        reason: reason.trim() || undefined,
        durationMs,
        banDeleteMessageSeconds,
      },
      {
        onSuccess: () => {
          toast({ title: `${decision} queued for record #E-${record.recordNumber}`, variant: 'success' });
          onOpenChange(false);
        },
        onError: (err) =>
          toast({
            title: 'Could not record decision',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {decision} — record #E-{record?.recordNumber}
          </DialogTitle>
          <DialogDescription>
            This is executed through the bot (moderation plugin, hierarchy checks, and — unless turned off — a
            DM to the user).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Reason">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={1000}
              disabled={decide.isPending}
            />
          </FormField>
          {decision && NEEDS_DURATION.includes(decision) ? (
            <FormField label="Duration" hint="e.g. 30m, 2h — blank uses the server default.">
              <Input
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                disabled={decide.isPending}
              />
            </FormField>
          ) : null}
          {decision === 'BAN' ? (
            <FormField label="Delete messages from the last N days (0-7)">
              <Input
                type="number"
                min={0}
                max={7}
                value={deleteDays}
                onChange={(e) => setDeleteDays(e.target.value)}
                disabled={decide.isPending}
              />
            </FormField>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={decide.isPending}>
            Cancel
          </Button>
          <Button
            variant={decision === 'KICK' || decision === 'BAN' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={decide.isPending}
          >
            {decide.isPending ? 'Recording…' : `Confirm ${decision}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Minimal duration parser mirroring `@pavisie/core`'s `parseDuration` (dashboard has no dependency on core). */
function parseDurationLoose(input: string): number | undefined {
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(input.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return value * unitMs[match[2].toLowerCase()];
}
