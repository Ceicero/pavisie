'use client';

import { Plus, Trash2 } from 'lucide-react';
import type { TicketIntakeFieldDto } from '@pavisie/types/tickets';
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@pavisie/ui';

export interface IntakeFormBuilderProps {
  value: TicketIntakeFieldDto[];
  onChange: (next: TicketIntakeFieldDto[]) => void;
  disabled?: boolean;
  max?: number;
}

/** Editable list of up to `max` (default 5) intake-form questions asked in a modal when a ticket is opened. */
export function IntakeFormBuilder({ value, onChange, disabled, max = 5 }: IntakeFormBuilderProps) {
  function update(index: number, patch: Partial<TicketIntakeFieldDto>) {
    onChange(value.map((field, i) => (i === index ? { ...field, ...patch } : field)));
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...value, { label: '', style: 'short', required: true }]);
  }

  return (
    <div className="space-y-3">
      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No intake questions configured. Tickets open directly with no form.
        </p>
      ) : null}

      {value.map((field, index) => (
        <div
          key={index}
          className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center"
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor={`intake-label-${index}`} className="sr-only">
              Question {index + 1}
            </Label>
            <Input
              id={`intake-label-${index}`}
              value={field.label}
              placeholder="Question text"
              maxLength={100}
              disabled={disabled}
              onChange={(e) => update(index, { label: e.target.value })}
            />
          </div>
          <Select
            value={field.style}
            onValueChange={(v) => update(index, { style: v as TicketIntakeFieldDto['style'] })}
            disabled={disabled}
          >
            <SelectTrigger className="sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="short">Short answer</SelectItem>
              <SelectItem value="paragraph">Paragraph</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={field.required}
              onCheckedChange={(v) => update(index, { required: v === true })}
              disabled={disabled}
            />
            Required
          </label>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => remove(index)}
            disabled={disabled}
            aria-label={`Remove question ${index + 1}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={add}
        disabled={disabled || value.length >= max}
      >
        <Plus className="h-4 w-4" />
        Add question{value.length > 0 ? '' : ' (optional)'}
      </Button>
      {value.length >= max ? <p className="text-xs text-muted-foreground">Maximum {max} questions.</p> : null}
    </div>
  );
}
