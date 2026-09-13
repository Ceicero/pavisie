'use client';

import { Plus, X } from 'lucide-react';
import type { AutomodActionInput, AutomodActionType } from '@pavisie/types/automod';
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pavisie/ui';

const ACTION_OPTIONS: { value: AutomodActionType; label: string }[] = [
  { value: 'warn', label: 'Warn' },
  { value: 'delete', label: 'Delete message' },
  { value: 'timeout', label: 'Timeout' },
  { value: 'quarantine', label: 'Quarantine' },
  { value: 'alert_staff', label: 'Alert staff' },
  { value: 'ignore', label: 'Log only (ignore)' },
];

export interface RuleActionsEditorProps {
  actions: AutomodActionInput[];
  onChange: (next: AutomodActionInput[]) => void;
  disabled?: boolean;
}

/** Ordered list of per-rule actions (SPEC.md §C: "Per-rule actions: warn, delete, timeout, quarantine, alert staff, or ignore"). Applied in order when the rule matches and dry-run is off. */
export function RuleActionsEditor({ actions, onChange, disabled }: RuleActionsEditorProps) {
  function update(index: number, patch: Partial<AutomodActionInput>) {
    onChange(actions.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }
  function remove(index: number) {
    onChange(actions.filter((_, i) => i !== index));
  }
  function add() {
    onChange([...actions, { type: 'warn' }]);
  }

  return (
    <div className="space-y-2">
      {actions.map((action, i) => (
        <div key={i} className="flex items-center gap-2">
          <Select
            value={action.type}
            onValueChange={(v) => update(i, { type: v as AutomodActionType })}
            disabled={disabled}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {action.type === 'timeout' ? (
            <Input
              type="number"
              className="w-32"
              placeholder="Minutes"
              min={1}
              value={action.timeoutMs ? Math.round(action.timeoutMs / 60000) : ''}
              onChange={(e) => {
                const minutes = Number(e.target.value);
                update(i, {
                  timeoutMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined,
                });
              }}
              disabled={disabled}
            />
          ) : null}
          {!disabled ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove action"
              onClick={() => remove(i)}
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      ))}
      {!disabled ? (
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="h-4 w-4" /> Add action
        </Button>
      ) : null}
      {actions.length === 0 ? (
        <p className="text-xs text-destructive">At least one action is required.</p>
      ) : null}
    </div>
  );
}
