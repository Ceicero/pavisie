'use client';

import * as React from 'react';
import type { ModerationCaseDto } from '@pavisie/types';
import {
  Badge,
  Button,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Textarea,
  useToast,
} from '@pavisie/ui';
import { formatDateTime } from '@/lib/dashboard/format';
import { useModerationNotes, useModerationWarnings, useUpdateCaseReason } from '@/lib/dashboard/moderation-queries';
import { ApiClientError } from '@/lib/dashboard/api';

export interface CaseDetailDrawerProps {
  guildId: string;
  caseRow: ModerationCaseDto | null;
  onOpenChange: (open: boolean) => void;
}

const TYPE_LABEL: Record<string, string> = {
  WARN: 'Warn',
  TIMEOUT: 'Timeout',
  UNTIMEOUT: 'Timeout removed',
  KICK: 'Kick',
  BAN: 'Ban',
  UNBAN: 'Unban',
  SOFTBAN: 'Softban',
  PURGE: 'Purge',
  LOCK: 'Channel lock',
  UNLOCK: 'Channel unlock',
  SLOWMODE: 'Slowmode',
  NICK: 'Nickname change',
  ROLE_ADD: 'Role added',
  ROLE_REMOVE: 'Role removed',
  QUARANTINE: 'Quarantine',
  NOTE: 'Note',
};

/** Detail drawer for one moderation case: full metadata, evidence links, an editable reason, and the target's recent warnings/notes. */
export function CaseDetailDrawer({ guildId, caseRow, onOpenChange }: CaseDetailDrawerProps) {
  const [reasonDraft, setReasonDraft] = React.useState('');
  const updateReason = useUpdateCaseReason(guildId);
  const { toast } = useToast();

  const warnings = useModerationWarnings(guildId, caseRow?.targetId);
  const notes = useModerationNotes(guildId, caseRow?.targetId);

  React.useEffect(() => {
    setReasonDraft(caseRow?.reason ?? '');
  }, [caseRow?.id, caseRow?.reason]);

  const open = Boolean(caseRow);

  function handleSaveReason() {
    if (!caseRow) return;
    updateReason.mutate(
      { caseNumber: caseRow.caseNumber, reason: reasonDraft },
      {
        onSuccess: () => toast({ title: 'Reason updated', variant: 'success' }),
        onError: (err) =>
          toast({
            title: 'Could not update reason',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        {caseRow ? (
          <>
            <SheetHeader>
              <SheetTitle>
                Case #{caseRow.caseNumber} — {TYPE_LABEL[caseRow.type] ?? caseRow.type}
              </SheetTitle>
              <SheetDescription>Opened {formatDateTime(caseRow.createdAt)}</SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-4 overflow-y-auto">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Target</p>
                  <p className="font-mono">{caseRow.targetId}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Moderator</p>
                  <p className="font-mono">{caseRow.moderatorId}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Source</p>
                  <Badge variant="outline" className="capitalize">
                    {caseRow.source.toLowerCase()}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">DM sent</p>
                  <Badge variant={caseRow.dmSent ? 'success' : 'outline'}>
                    {caseRow.dmSent ? 'Yes' : 'No'}
                  </Badge>
                </div>
                {caseRow.durationMs ? (
                  <div>
                    <p className="text-xs text-muted-foreground">Duration</p>
                    <p>{Math.round(caseRow.durationMs / 60000)} min</p>
                  </div>
                ) : null}
                {caseRow.expiresAt ? (
                  <div>
                    <p className="text-xs text-muted-foreground">Expires</p>
                    <p>
                      {formatDateTime(caseRow.expiresAt)}
                      {caseRow.expiredAt ? ' (already applied)' : ''}
                    </p>
                  </div>
                ) : null}
              </div>

              {caseRow.evidenceUrls.length > 0 ? (
                <div>
                  <Label>Evidence</Label>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                    {caseRow.evidenceUrls.map((url) => (
                      <li key={url}>
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline break-all"
                        >
                          {url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="case-reason">Reason</Label>
                <Textarea
                  id="case-reason"
                  value={reasonDraft}
                  onChange={(e) => setReasonDraft(e.target.value)}
                  rows={3}
                />
                <Button
                  size="sm"
                  onClick={handleSaveReason}
                  disabled={updateReason.isPending || reasonDraft === (caseRow.reason ?? '')}
                >
                  {updateReason.isPending ? 'Saving…' : 'Save reason'}
                </Button>
              </div>

              <div className="border-t border-border" />

              <div>
                <Label>Warnings for this user</Label>
                {warnings.isLoading ? (
                  <Skeleton className="mt-2 h-16 w-full" />
                ) : (
                  <ul className="mt-2 space-y-1 text-sm">
                    {(warnings.data?.items ?? []).length === 0 ? (
                      <p className="text-muted-foreground">None.</p>
                    ) : null}
                    {(warnings.data?.items ?? []).map((w) => (
                      <li key={w.id} className="flex items-center gap-2">
                        <Badge variant={w.active ? 'warning' : 'outline'}>
                          {w.active ? 'Active' : 'Cleared'}
                        </Badge>
                        <span className="truncate">{w.reason ?? 'No reason'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <Label>Staff notes for this user</Label>
                {notes.isLoading ? (
                  <Skeleton className="mt-2 h-16 w-full" />
                ) : (
                  <ul className="mt-2 space-y-1 text-sm">
                    {(notes.data?.items ?? []).length === 0 ? (
                      <p className="text-muted-foreground">None.</p>
                    ) : null}
                    {(notes.data?.items ?? []).map((n) => (
                      <li key={n.id} className="rounded-md border border-border p-2">
                        <p>{n.content}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatDateTime(n.createdAt)} · by {n.authorId}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
