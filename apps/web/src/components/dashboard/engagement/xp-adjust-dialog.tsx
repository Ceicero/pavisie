'use client';

import * as React from 'react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@pavisie/ui';
import { useXpAdjust } from '@/lib/dashboard/engagement-queries';
import { ApiClientError } from '@/lib/dashboard/api';

export interface XpAdjustDialogProps {
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** Give/remove/set a member's XP directly from the dashboard. Identifies the member by Discord user id (the dashboard has no member picker yet). */
export function XpAdjustDialog({ guildId, open, onOpenChange }: XpAdjustDialogProps) {
  const adjust = useXpAdjust(guildId);
  const { toast } = useToast();

  const [userId, setUserId] = React.useState('');
  const [mode, setMode] = React.useState<'give' | 'remove' | 'set'>('give');
  const [amount, setAmount] = React.useState('');
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (!open) {
      setUserId('');
      setMode('give');
      setAmount('');
      setReason('');
    }
  }, [open]);

  const amountNum = Number(amount);
  const valid = SNOWFLAKE_PATTERN.test(userId.trim()) && Number.isInteger(amountNum) && amountNum >= 0;

  function handleSubmit() {
    if (!valid) return;
    adjust.mutate(
      { userId: userId.trim(), mode, amount: amountNum, reason: reason.trim() || undefined },
      {
        onSuccess: (result) => {
          toast({
            title: 'XP updated',
            description: `Now level ${result.level} (${result.xp.toLocaleString()} XP).`,
            variant: 'success',
          });
          onOpenChange(false);
        },
        onError: (err) =>
          toast({
            title: 'Could not adjust XP',
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
          <DialogTitle>Adjust XP</DialogTitle>
          <DialogDescription>
            Give, remove, or set a member&apos;s XP total directly. Every adjustment is written to the audit
            log.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField
            label="Member's Discord user ID"
            hint="Right-click a member in Discord with Developer Mode on → Copy User ID."
          >
            <Input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="123456789012345678"
              autoComplete="off"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Action">
              <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="give">Give XP</SelectItem>
                  <SelectItem value="remove">Remove XP</SelectItem>
                  <SelectItem value="set">Set XP to</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Amount">
              <Input
                type="number"
                min={0}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="100"
              />
            </FormField>
          </div>

          <FormField label="Reason" hint="Optional — recorded in the audit log.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
          </FormField>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adjust.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!valid || adjust.isPending}>
            {adjust.isPending ? 'Applying…' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
