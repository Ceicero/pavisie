'use client';

import { Switch } from '@pavisie/ui';
import { REQUIRE_TIMESTAMP_HELP } from '@/lib/dashboard/webhook-require-timestamp';

/** One help node for the inbound list; every row's switch points at it. */
export const INBOUND_LIST_REQUIRE_TIMESTAMP_HELP_ID = 'inbound-webhook-require-timestamp-help';

/** Separate id so the create dialog can be open on top of the list without duplicating the list id. */
export const INBOUND_CREATE_REQUIRE_TIMESTAMP_HELP_ID = 'inbound-webhook-create-require-timestamp-help';

export function RequireTimestampHelp({ id }: { id: string }) {
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {REQUIRE_TIMESTAMP_HELP}
    </p>
  );
}

export function RequireTimestampSwitch({
  checked,
  pending = false,
  disabled = false,
  helpId,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  pending?: boolean;
  disabled?: boolean;
  helpId: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        aria-label={label}
        aria-describedby={helpId}
      />
      {pending ? <span className="text-xs text-muted-foreground">Saving…</span> : null}
    </div>
  );
}

/** Label, help text, and switch for one incoming endpoint (the create form). */
export function RequireTimestampField({
  checked,
  pending = false,
  disabled = false,
  helpId,
  onCheckedChange,
}: {
  checked: boolean;
  pending?: boolean;
  disabled?: boolean;
  helpId: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">Require timestamp</p>
        <RequireTimestampHelp id={helpId} />
      </div>
      <RequireTimestampSwitch
        checked={checked}
        pending={pending}
        disabled={disabled}
        helpId={helpId}
        label="Require timestamp"
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
