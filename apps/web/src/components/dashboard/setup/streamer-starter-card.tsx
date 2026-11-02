'use client';

import * as React from 'react';
import { Rocket } from 'lucide-react';
import type { StreamerStarterReportDto, StreamerStarterStepStatus } from '@pavisie/types';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  useToast,
} from '@pavisie/ui';
import { ApiClientError } from '@/lib/dashboard/api';
import {
  STREAMER_STARTER_TIMEOUT_MS,
  useStartStreamerStarter,
  useStreamerStarterResult,
} from '@/lib/dashboard/setup-queries';
import { isStarterFormValid, plainDiscordText } from '@/lib/dashboard/starter-format';
import { DiscordChannelSelect } from '../discord-selects';

const STATUS_BADGE: Record<
  StreamerStarterStepStatus,
  { label: string; variant: 'success' | 'secondary' | 'warning' | 'destructive' }
> = {
  enabled: { label: 'Turned on', variant: 'success' },
  already: { label: 'Already set up', variant: 'secondary' },
  skipped: { label: 'Skipped', variant: 'warning' },
  failed: { label: 'Failed', variant: 'destructive' },
};

function ReportView({ report }: { report: StreamerStarterReportDto }) {
  return (
    <div className="space-y-3">
      {report.steps.map((step) => {
        const badge = STATUS_BADGE[step.status];
        return (
          <div key={step.id} className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{step.title}</p>
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </div>
            <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
              {plainDiscordText(step.text)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Change it: {plainDiscordText(step.where)}</p>
          </div>
        );
      })}
      {report.notes.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>Heads up</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              {report.notes.map((note) => (
                <li key={note}>{plainDiscordText(note)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function StreamerStarterDialog({
  guildId,
  open,
  onOpenChange,
}: {
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [twitchLogin, setTwitchLogin] = React.useState('');
  const [alertChannelId, setAlertChannelId] = React.useState<string | null>(null);
  const [requestId, setRequestId] = React.useState<string | null>(null);
  const [timedOut, setTimedOut] = React.useState(false);
  const start = useStartStreamerStarter(guildId);
  const result = useStreamerStarterResult(guildId, requestId);
  const { toast } = useToast();

  React.useEffect(() => {
    if (!open) return;
    setTwitchLogin('');
    setAlertChannelId(null);
    setRequestId(null);
    setTimedOut(false);
  }, [open]);

  const pending = Boolean(requestId) && (!result.data || result.data.status === 'pending') && !timedOut;

  // The job sits in the bot's queue; if the bot never picks it up, stop spinning and say so.
  React.useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setTimedOut(true), STREAMER_STARTER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending, requestId]);

  const valid = isStarterFormValid(twitchLogin, alertChannelId);

  function handleRun() {
    if (!valid) return;
    const login = twitchLogin.trim();
    start.mutate(
      { twitchLogin: login || null, alertChannelId: login ? alertChannelId : null },
      {
        onSuccess: (queued) => setRequestId(queued.requestId),
        onError: (err) =>
          toast({
            title: 'Could not start the starter pack',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  const data = result.data;
  const finished = data && data.status !== 'pending';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Streamer starter pack</DialogTitle>
          <DialogDescription>
            Turns on Twitch go-live alerts, a member-count stats channel, leveling and basic automod. Anything
            you have already set up is left exactly as it is, and every setting stays editable afterwards.
          </DialogDescription>
        </DialogHeader>

        {!requestId ? (
          <div className="space-y-4">
            <FormField
              label="Twitch username"
              hint="Optional. Leave blank to skip the alert for now; you can add it later under Integrations."
            >
              <Input
                value={twitchLogin}
                placeholder="shroud"
                maxLength={100}
                onChange={(e) => setTwitchLogin(e.target.value)}
                disabled={start.isPending}
              />
            </FormField>
            {twitchLogin.trim() ? (
              <FormField label="Alert channel" required hint="Where the go-live post appears.">
                <DiscordChannelSelect
                  guildId={guildId}
                  value={alertChannelId}
                  onChange={setAlertChannelId}
                  disabled={start.isPending}
                />
              </FormField>
            ) : null}
          </div>
        ) : null}

        {requestId && pending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Setting things up…
          </p>
        ) : null}

        {requestId && timedOut && !finished ? (
          <Alert variant="warning">
            <AlertTitle>The bot has not answered yet</AlertTitle>
            <AlertDescription>
              Pavisie may be offline or not in this server. Nothing was changed. Try again in a moment.
            </AlertDescription>
          </Alert>
        ) : null}

        {data?.status === 'failed' ? (
          <Alert variant="destructive">
            <AlertTitle>Could not finish</AlertTitle>
            <AlertDescription>{plainDiscordText(data.error)}</AlertDescription>
          </Alert>
        ) : null}

        {data?.status === 'done' ? <ReportView report={data.report} /> : null}

        <DialogFooter>
          {!requestId ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={start.isPending}>
                Cancel
              </Button>
              <Button onClick={handleRun} disabled={!valid || start.isPending}>
                {start.isPending ? 'Starting…' : 'Set it up'}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)} disabled={pending}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Overview-page card: the one-click streamer preset (same code as `/setup streamer` in Discord). */
export function StreamerStarterCard({ guildId }: { guildId: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-muted-foreground" />
          Streamer starter pack
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          One click for Twitch go-live alerts, a member-count stats channel, leveling and basic automod. It
          only fills gaps and never changes what you have already configured.
        </p>
        <Button onClick={() => setOpen(true)} className="shrink-0">
          Set up for streaming
        </Button>
      </CardContent>
      <StreamerStarterDialog guildId={guildId} open={open} onOpenChange={setOpen} />
    </Card>
  );
}
