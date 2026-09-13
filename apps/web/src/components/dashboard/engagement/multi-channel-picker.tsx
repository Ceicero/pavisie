'use client';

import { X } from 'lucide-react';
import { Badge, ChannelPicker, Input, type ChannelKind } from '@pavisie/ui';
import { useGuildChannels } from '@/lib/dashboard/queries';

export interface MultiChannelPickerProps {
  guildId: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** Discord channel type to restrict the picker to (e.g. 2 = voice). Omit for any type. */
  filterType?: number;
  /** Restrict the add-picker to these channel kinds. Omit for any kind. Combines with `filterType`. */
  kinds?: ChannelKind[];
  disabled?: boolean;
}

/** Add-one-at-a-time multi-select over guild channels (temp-voice hub channels, etc.), with removable chips. Falls back to a comma-separated id input if the channels endpoint is unavailable. */
export function MultiChannelPicker({
  guildId,
  value,
  onChange,
  filterType,
  kinds,
  disabled,
}: MultiChannelPickerProps) {
  const { data: channels, isError, isLoading } = useGuildChannels(guildId);
  const options = (channels ?? []).filter((c) => filterType === undefined || c.type === filterType);
  const channelName = (id: string) => channels?.find((c) => c.id === id)?.name ?? id;

  if (isError) {
    return (
      <Input
        value={value.join(', ')}
        placeholder="Channel IDs, comma separated"
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
              #{channelName(id)}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${channelName(id)}`}
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
      <ChannelPicker
        options={options.filter((c) => !value.includes(c.id))}
        value={null}
        onChange={(id) => id && onChange([...value, id])}
        placeholder="Add a channel…"
        allowNone={false}
        disabled={disabled || isLoading}
        kinds={kinds}
      />
    </div>
  );
}
