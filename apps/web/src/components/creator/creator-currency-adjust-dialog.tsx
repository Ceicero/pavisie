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
  useToast,
} from '@pavisie/ui';
import { ApiClientError } from '@/lib/dashboard/api';
import { useAdjustCreatorEconomy } from '@/lib/creator/queries';
import { ADJUST_REASON_MAX, formatAmount, validateAdjust, type AdjustDraft } from '@/lib/creator/economy-form';

const EMPTY: AdjustDraft = { login: '', direction: 'add', amount: '', reason: '' };

export interface CreatorCurrencyAdjustDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  symbol: string;
}

/** The streamer's manual add/remove on one viewer's balance. The viewer is identified by their Twitch username; the
 * API resolves it to their Twitch id and writes the change (with the reason) to the currency's ledger. */
export function CreatorCurrencyAdjustDialog({ open, onOpenChange, symbol }: CreatorCurrencyAdjustDialogProps) {
  const adjust = useAdjustCreatorEconomy();
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<AdjustDraft>(EMPTY);
  const [serverError, setServerError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setDraft(EMPTY);
    setServerError(null);
  }, [open]);

  const checked = validateAdjust(draft);
  // Only show a problem once the streamer has typed something in every box; the button stays disabled until valid.
  const touched = draft.login !== '' && draft.amount !== '' && draft.reason !== '';

  function submit() {
    if (!checked.ok) return;
    setServerError(null);
    adjust.mutate(checked.input, {
      onSuccess: (result) => {
        toast({
          title: `${result.direction === 'add' ? 'Added' : 'Removed'} ${formatAmount(result.amount)} ${symbol} ${
            result.direction === 'add' ? 'to' : 'from'
          } ${result.viewer.displayName}`,
          description: `New balance: ${formatAmount(result.newBalance)} ${symbol}.`,
          variant: 'success',
        });
        onOpenChange(false);
      },
      onError: (err) => setServerError(err instanceof ApiClientError ? err.message : 'Please try again.'),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust a viewer&apos;s balance</DialogTitle>
          <DialogDescription>
            The change and your reason are recorded on the currency&apos;s ledger. A balance can never go below zero.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Twitch username" required hint="The viewer's Twitch login, with or without the @.">
            <Input
              value={draft.login}
              onChange={(e) => setDraft((d) => ({ ...d, login: e.target.value }))}
              maxLength={26}
              disabled={adjust.isPending}
              placeholder="someviewer"
              autoComplete="off"
            />
          </FormField>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">What to do</p>
            <div className="flex gap-2" role="group" aria-label="Add or remove">
              <Button
                type="button"
                size="sm"
                variant={draft.direction === 'add' ? 'default' : 'outline'}
                aria-pressed={draft.direction === 'add'}
                onClick={() => setDraft((d) => ({ ...d, direction: 'add' }))}
                disabled={adjust.isPending}
              >
                Add
              </Button>
              <Button
                type="button"
                size="sm"
                variant={draft.direction === 'remove' ? 'default' : 'outline'}
                aria-pressed={draft.direction === 'remove'}
                onClick={() => setDraft((d) => ({ ...d, direction: 'remove' }))}
                disabled={adjust.isPending}
              >
                Remove
              </Button>
            </div>
          </div>

          <FormField label={`Amount (${symbol})`} required>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={draft.amount}
              onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
              disabled={adjust.isPending}
            />
          </FormField>

          <FormField label="Reason" required hint={`Up to ${ADJUST_REASON_MAX} characters.`}>
            <Input
              value={draft.reason}
              onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
              maxLength={ADJUST_REASON_MAX}
              disabled={adjust.isPending}
              placeholder="Giveaway winner"
            />
          </FormField>

          {touched && !checked.ok ? <p className="text-xs text-destructive">{checked.error}</p> : null}
          {serverError ? (
            <p role="alert" className="text-sm text-destructive">
              {serverError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adjust.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!checked.ok || adjust.isPending}>
            {adjust.isPending ? 'Saving…' : draft.direction === 'add' ? 'Add to balance' : 'Remove from balance'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
