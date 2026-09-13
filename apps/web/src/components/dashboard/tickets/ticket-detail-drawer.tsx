'use client';

import * as React from 'react';
import { Download, X as XIcon } from 'lucide-react';
import {
  Badge,
  Button,
  Input,
  Label,
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
  useToast,
} from '@pavisie/ui';
import { ApiClientError } from '@/lib/dashboard/api';
import { formatDateTime } from '@/lib/dashboard/format';
import { useAssignTicket, useCloseTicket, useTicket, ticketTranscriptUrl } from '@/lib/dashboard/tickets-queries';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';

export interface TicketDetailDrawerProps {
  guildId: string;
  ticketId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function TicketDetailDrawer({ guildId, ticketId, onOpenChange }: TicketDetailDrawerProps) {
  const { data: ticket, isLoading, error, refetch } = useTicket(guildId, ticketId ?? undefined);
  const assign = useAssignTicket(guildId);
  const close = useCloseTicket(guildId);
  const { toast } = useToast();

  const [assigneeInput, setAssigneeInput] = React.useState('');
  const [closeOpen, setCloseOpen] = React.useState(false);
  const [closeReason, setCloseReason] = React.useState('');

  React.useEffect(() => {
    setAssigneeInput(ticket?.assigneeId ?? '');
  }, [ticket?.assigneeId]);

  function handleAssign() {
    if (!ticket) return;
    assign.mutate(
      { ticketId: ticket.id, assigneeId: assigneeInput.trim() || null },
      {
        onSuccess: () => toast({ title: 'Assignee updated', variant: 'success' }),
        onError: (err) =>
          toast({
            title: 'Could not update assignee',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  function handleClose() {
    if (!ticket) return;
    close.mutate(
      { ticketId: ticket.id, reason: closeReason.trim() || undefined },
      {
        onSuccess: () => {
          toast({
            title: 'Closing ticket…',
            description: 'The bot is generating the transcript and locking the channel.',
            variant: 'success',
          });
          setCloseOpen(false);
          setCloseReason('');
        },
        onError: (err) =>
          toast({
            title: 'Could not close ticket',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <Sheet open={ticketId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        {!ticket || isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>Ticket #{ticket.number}</SheetTitle>
            </SheetHeader>

            <div className="flex-1 space-y-5 overflow-y-auto py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={ticket.status === 'OPEN' ? 'success' : 'outline'}>{ticket.status}</Badge>
                <Badge variant="outline">
                  {ticket.mode === 'CHANNEL' ? 'Private channel' : 'Private thread'}
                </Badge>
                {ticket.slaBreached ? <Badge variant="destructive">SLA breached</Badge> : null}
                {ticket.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>

              {ticket.subject ? <p className="text-sm text-foreground">{ticket.subject}</p> : null}

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Opener</dt>
                <dd>{ticket.openerId}</dd>
                <dt className="text-muted-foreground">Opened</dt>
                <dd>{formatDateTime(ticket.createdAt)}</dd>
                {ticket.closedAt ? (
                  <>
                    <dt className="text-muted-foreground">Closed</dt>
                    <dd>{formatDateTime(ticket.closedAt)}</dd>
                  </>
                ) : null}
                {ticket.closeReason ? (
                  <>
                    <dt className="text-muted-foreground">Close reason</dt>
                    <dd>{ticket.closeReason}</dd>
                  </>
                ) : null}
                {ticket.slaDueAt ? (
                  <>
                    <dt className="text-muted-foreground">SLA due</dt>
                    <dd>{formatDateTime(ticket.slaDueAt)}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">First response</dt>
                <dd>{ticket.firstResponseAt ? formatDateTime(ticket.firstResponseAt) : 'None yet'}</dd>
              </dl>

              <div className="space-y-2">
                <Label htmlFor="assignee">Assignee</Label>
                <div className="flex gap-2">
                  <Input
                    id="assignee"
                    value={assigneeInput}
                    placeholder="Staff user ID"
                    onChange={(e) => setAssigneeInput(e.target.value)}
                    disabled={assign.isPending}
                  />
                  <Button variant="outline" onClick={handleAssign} disabled={assign.isPending}>
                    Save
                  </Button>
                  {assigneeInput ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Clear assignee"
                      onClick={() => setAssigneeInput('')}
                      disabled={assign.isPending}
                    >
                      <XIcon className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">Participants</p>
                {ticket.participants.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Just the opener.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {ticket.participants.map((p) => (
                      <li key={p.id} className="text-muted-foreground">
                        {p.userId} <span className="text-xs">(added by {p.addedBy})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">Transcript</p>
                {ticket.hasTranscript ? (
                  <div className="flex gap-2">
                    <a href={ticketTranscriptUrl(guildId, ticket.id, 'html')}>
                      <Button variant="outline" size="sm" type="button">
                        <Download className="h-4 w-4" />
                        HTML
                      </Button>
                    </a>
                    <a href={ticketTranscriptUrl(guildId, ticket.id, 'json')}>
                      <Button variant="outline" size="sm" type="button">
                        <Download className="h-4 w-4" />
                        JSON
                      </Button>
                    </a>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {ticket.status === 'OPEN'
                      ? 'Generated when the ticket closes.'
                      : 'No transcript available.'}
                  </p>
                )}
              </div>
            </div>

            {ticket.status === 'OPEN' ? (
              <SheetFooter>
                <Button variant="destructive" onClick={() => setCloseOpen(true)}>
                  Close ticket
                </Button>
              </SheetFooter>
            ) : null}

            <ConfirmDialog
              open={closeOpen}
              onOpenChange={setCloseOpen}
              title={`Close ticket #${ticket.number}?`}
              description={
                <div className="space-y-2 text-left">
                  <p>A transcript will be generated and the channel/thread will be locked.</p>
                  <Input
                    placeholder="Reason (optional)"
                    value={closeReason}
                    onChange={(e) => setCloseReason(e.target.value)}
                  />
                </div>
              }
              confirmLabel="Close ticket"
              variant="destructive"
              loading={close.isPending}
              onConfirm={handleClose}
            />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
