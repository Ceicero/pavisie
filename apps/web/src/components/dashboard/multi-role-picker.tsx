'use client';

import { X } from 'lucide-react';
import { Badge, Input, RolePicker } from '@pavisie/ui';
import { useGuildRoles } from '@/lib/dashboard/queries';

export interface MultiRolePickerProps {
  guildId: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

/** Add-one-at-a-time multi-select over guild roles (staff role lists etc.), with removable chips. Falls back to a comma-separated id input if the roles endpoint is unavailable. */
export function MultiRolePicker({ guildId, value, onChange, disabled }: MultiRolePickerProps) {
  const { data: roles, isError, isLoading } = useGuildRoles(guildId);

  const roleName = (id: string) => roles?.find((r) => r.id === id)?.name ?? id;

  if (isError) {
    return (
      <Input
        value={value.join(', ')}
        placeholder="Role IDs, comma separated"
        disabled={disabled}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <Badge key={id} variant="secondary" className="gap-1 pr-1">
              {roleName(id)}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${roleName(id)}`}
                  onClick={() => onChange(value.filter((v) => v !== id))}
                  className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </Badge>
          ))}
        </div>
      ) : null}
      <RolePicker
        options={(roles ?? []).filter((r) => !value.includes(r.id))}
        value={null}
        onChange={(id) => id && onChange([...value, id])}
        placeholder="Add a role…"
        allowNone={false}
        disabled={disabled || isLoading}
      />
    </div>
  );
}
