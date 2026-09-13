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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@pavisie/ui';
import {
  TWITCH_CHAT_LEVELS,
  TWITCH_CHAT_RESERVED_COMMAND_NAMES,
  type TwitchChatCommandDto,
  type TwitchChatLevelId,
} from '@pavisie/types/integrations';
import { ApiClientError } from '@/lib/dashboard/api';
import { useCreateTwitchChatCommand, useUpdateTwitchChatCommand } from '@/lib/dashboard/integrations-queries';
import { TWITCH_CHAT_LEVEL_LABEL } from './twitch-chat-commands-table';

/** Mirrors `twitchChatNameSchema` in `apps/api/src/lib/integrations/twitch-chat-schemas.ts`. Client-side
 * validation only — the server re-validates and is the source of truth. */
const NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
const RESERVED_NAMES: readonly string[] = TWITCH_CHAT_RESERVED_COMMAND_NAMES;

export interface TwitchChatCommandDialogProps {
  guildId: string;
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing an existing command; omitted/null when creating a new one. */
  command?: TwitchChatCommandDto | null;
}

export function TwitchChatCommandDialog({
  guildId,
  channelId,
  open,
  onOpenChange,
  command,
}: TwitchChatCommandDialogProps) {
  const isEdit = Boolean(command);
  const [name, setName] = React.useState('');
  const [response, setResponse] = React.useState('');
  const [cooldownSeconds, setCooldownSeconds] = React.useState(5);
  const [minLevel, setMinLevel] = React.useState<TwitchChatLevelId>('everyone');
  const create = useCreateTwitchChatCommand(guildId);
  const update = useUpdateTwitchChatCommand(guildId);
  const { toast } = useToast();
  const saving = create.isPending || update.isPending;

  React.useEffect(() => {
    if (!open) return;
    setName(command?.name ?? '');
    setResponse(command?.response ?? '');
    setCooldownSeconds(command?.cooldownSeconds ?? 5);
    setMinLevel(command?.minLevel ?? 'everyone');
  }, [open, command]);

  const normalizedName = name.trim().toLowerCase();
  const nameValid = NAME_PATTERN.test(normalizedName) && !RESERVED_NAMES.includes(normalizedName);
  const trimmedResponse = response.trim();
  const responseValid = trimmedResponse.length > 0 && trimmedResponse.length <= 400;
  const cooldownValid = Number.isInteger(cooldownSeconds) && cooldownSeconds >= 0 && cooldownSeconds <= 3600;
  const valid = nameValid && responseValid && cooldownValid;

  function handleSave() {
    if (!valid) return;
    const onSuccess = () => {
      toast({ title: isEdit ? 'Command updated' : 'Command added', variant: 'success' });
      onOpenChange(false);
    };
    const onError = (err: unknown) =>
      toast({
        title: 'Could not save the command',
        description: err instanceof ApiClientError ? err.message : 'Please try again.',
        variant: 'destructive',
      });

    if (isEdit && command) {
      update.mutate(
        {
          commandId: command.id,
          channelId,
          patch: { name: normalizedName, response: trimmedResponse, cooldownSeconds, minLevel },
        },
        { onSuccess, onError },
      );
    } else {
      create.mutate(
        { channelId, input: { name: normalizedName, response: trimmedResponse, cooldownSeconds, minLevel } },
        { onSuccess, onError },
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit !${command?.name}` : 'Add a command'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <FormField
            label="Name"
            required
            hint="Lowercase letters, numbers, or underscore. 1-32 characters, no ! prefix."
            error={name.length > 0 && !nameValid ? 'Not a valid or available command name.' : undefined}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              disabled={saving}
              placeholder="hello"
            />
          </FormField>

          <FormField label="Response" required hint="Up to 400 characters. {user} and {channel} are replaced.">
            <Textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              maxLength={400}
              rows={3}
              disabled={saving}
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Cooldown (seconds)">
              <Input
                type="number"
                min={0}
                max={3600}
                value={cooldownSeconds}
                onChange={(e) => setCooldownSeconds(Number(e.target.value) || 0)}
                disabled={saving}
              />
            </FormField>
            <FormField label="Minimum level">
              <Select value={minLevel} onValueChange={(v) => setMinLevel(v as TwitchChatLevelId)} disabled={saving}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TWITCH_CHAT_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {TWITCH_CHAT_LEVEL_LABEL[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!valid || saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add command'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
