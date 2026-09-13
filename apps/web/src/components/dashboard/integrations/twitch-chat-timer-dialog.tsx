'use client';

import * as React from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Textarea,
  useToast,
} from '@pavisie/ui';
import type { TwitchChatTimerDto } from '@pavisie/types/integrations';
import { ApiClientError } from '@/lib/dashboard/api';
import { useCreateTwitchChatTimer, useUpdateTwitchChatTimer } from '@/lib/dashboard/integrations-queries';

/** Mirrors `twitchChatNameSchema` / `twitchChatIntervalMinutesSchema` in
 * `apps/api/src/lib/integrations/twitch-chat-schemas.ts`. Client-side validation only. */
const NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1440;

export interface TwitchChatTimerDialogProps {
  guildId: string;
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing an existing timer; omitted/null when creating a new one. */
  timer?: TwitchChatTimerDto | null;
}

export function TwitchChatTimerDialog({
  guildId,
  channelId,
  open,
  onOpenChange,
  timer,
}: TwitchChatTimerDialogProps) {
  const isEdit = Boolean(timer);
  const [name, setName] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [intervalMinutes, setIntervalMinutes] = React.useState(30);
  const create = useCreateTwitchChatTimer(guildId);
  const update = useUpdateTwitchChatTimer(guildId);
  const { toast } = useToast();
  const saving = create.isPending || update.isPending;

  React.useEffect(() => {
    if (!open) return;
    setName(timer?.name ?? '');
    setMessage(timer?.message ?? '');
    setIntervalMinutes(timer?.intervalMinutes ?? 30);
  }, [open, timer]);

  const normalizedName = name.trim().toLowerCase();
  const nameValid = NAME_PATTERN.test(normalizedName);
  const trimmedMessage = message.trim();
  const messageValid = trimmedMessage.length > 0 && trimmedMessage.length <= 400;
  const intervalValid =
    Number.isInteger(intervalMinutes) &&
    intervalMinutes >= MIN_INTERVAL_MINUTES &&
    intervalMinutes <= MAX_INTERVAL_MINUTES;
  const valid = nameValid && messageValid && intervalValid;

  function handleSave() {
    if (!valid) return;
    const onSuccess = () => {
      toast({ title: isEdit ? 'Timer updated' : 'Timer added', variant: 'success' });
      onOpenChange(false);
    };
    const onError = (err: unknown) =>
      toast({
        title: 'Could not save the timer',
        description: err instanceof ApiClientError ? err.message : 'Please try again.',
        variant: 'destructive',
      });

    if (isEdit && timer) {
      update.mutate(
        {
          timerId: timer.id,
          channelId,
          patch: { name: normalizedName, message: trimmedMessage, intervalMinutes },
        },
        { onSuccess, onError },
      );
    } else {
      create.mutate(
        { channelId, input: { name: normalizedName, message: trimmedMessage, intervalMinutes } },
        { onSuccess, onError },
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit timer: ${timer?.name}` : 'Add a timer'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <FormField
            label="Name"
            required
            hint="Lowercase letters, numbers, or underscore. 1-32 characters."
            error={name.length > 0 && !nameValid ? 'Not a valid name.' : undefined}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              disabled={saving}
              placeholder="socials"
            />
          </FormField>

          <FormField label="Message" required hint="Up to 400 characters.">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={400}
              rows={3}
              disabled={saving}
            />
          </FormField>

          <FormField
            label="Interval (minutes)"
            required
            hint={`${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES} minutes.`}
          >
            <Input
              type="number"
              min={MIN_INTERVAL_MINUTES}
              max={MAX_INTERVAL_MINUTES}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value) || 0)}
              disabled={saving}
            />
          </FormField>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!valid || saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add timer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
