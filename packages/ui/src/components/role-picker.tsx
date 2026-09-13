'use client';

import * as React from 'react';
import { Shield } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

/** Minimal role shape needed for the picker — deliberately not coupled to `@pavisie/types` so `@pavisie/ui` has no runtime dependency on it. Structurally compatible with `DiscordRoleOption`. */
export interface RolePickerOption {
  id: string;
  name: string;
}

export interface RolePickerProps {
  options: RolePickerOption[];
  value: string | null;
  onChange: (roleId: string | null) => void;
  placeholder?: string;
  allowNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
}

const NONE = '__none__';

/** Select over provided Discord role options. */
export function RolePicker({
  options,
  value,
  onChange,
  placeholder = 'Select a role',
  allowNone = true,
  noneLabel = 'None',
  disabled,
}: RolePickerProps) {
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowNone ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
        {options.map((opt) => (
          <SelectItem key={opt.id} value={opt.id}>
            <span className="flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5 text-muted-foreground" />
              {opt.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
