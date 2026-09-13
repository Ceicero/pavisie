'use client';

import * as React from 'react';
import { Folder, Hash, Megaphone, MessagesSquare, Volume2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

/** Minimal channel shape needed for the picker — deliberately not coupled to `@pavisie/types` so `@pavisie/ui` has no runtime dependency on it. Structurally compatible with `DiscordChannelOption`. */
export interface ChannelPickerOption {
  id: string;
  name: string;
  /** Discord channel type (0 text, 2 voice, 4 category, 5 announcement, 13 stage, 15 forum, 16 media). Drives the icon and `kinds` filtering; unknown/undefined is always kept. */
  type?: number;
}

/** Human-level channel kind a picker can be restricted to. Maps onto one or more Discord channel `type` numbers via `CHANNEL_KIND_TYPES`. */
export type ChannelKind = 'text' | 'announcement' | 'voice' | 'stage' | 'category' | 'forum';

/** Discord channel `type` numbers that belong to each `ChannelKind`. */
export const CHANNEL_KIND_TYPES: Record<ChannelKind, readonly number[]> = {
  text: [0],
  announcement: [5],
  voice: [2],
  stage: [13],
  category: [4],
  forum: [15, 16],
};

/**
 * Keeps only the options whose Discord `type` belongs to one of `kinds`. `kinds` undefined/empty → every option.
 * Options with an undefined `type` are always kept (unknown → keep) so the raw-id fallback path still works.
 */
export function filterChannelOptions(
  options: ChannelPickerOption[],
  kinds?: ChannelKind[],
): ChannelPickerOption[] {
  if (!kinds || kinds.length === 0) return options;
  const allowed = new Set<number>();
  for (const kind of kinds) {
    for (const type of CHANNEL_KIND_TYPES[kind]) allowed.add(type);
  }
  return options.filter((opt) => opt.type === undefined || allowed.has(opt.type));
}

export interface ChannelPickerProps {
  options: ChannelPickerOption[];
  value: string | null;
  onChange: (channelId: string | null) => void;
  placeholder?: string;
  allowNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
  /** Restrict the selectable options to these channel kinds. Omit/empty for any kind. */
  kinds?: ChannelKind[];
}

const NONE = '__none__';

/** Icon for a Discord channel `type`: 2/13 speaker, 4 folder, 5 megaphone, 15/16 forum, else hash. */
function ChannelTypeIcon({ type }: { type: number | undefined }) {
  const className = 'h-3.5 w-3.5 text-muted-foreground';
  switch (type) {
    case 2:
    case 13:
      return <Volume2 className={className} />;
    case 4:
      return <Folder className={className} />;
    case 5:
      return <Megaphone className={className} />;
    case 15:
    case 16:
      return <MessagesSquare className={className} />;
    default:
      return <Hash className={className} />;
  }
}

/** Select over provided Discord channel options, with a per-type icon and optional `kinds` filtering. */
export function ChannelPicker({
  options,
  value,
  onChange,
  placeholder = 'Select a channel',
  allowNone = true,
  noneLabel = 'None',
  disabled,
  kinds,
}: ChannelPickerProps) {
  const visible = filterChannelOptions(options, kinds);
  // A stored value that isn't among the (filtered) options — e.g. legacy config pointing at a category in a
  // text-only field — still gets rendered (disabled) so the select doesn't silently show empty.
  const orphanValue =
    value !== null && value !== '' && !visible.some((opt) => opt.id === value) ? value : null;
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
        {orphanValue !== null ? (
          <SelectItem value={orphanValue} disabled>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              Unknown / not allowed here ({orphanValue})
            </span>
          </SelectItem>
        ) : null}
        {visible.map((opt) => (
          <SelectItem key={opt.id} value={opt.id}>
            <span className="flex items-center gap-1.5">
              <ChannelTypeIcon type={opt.type} />
              {opt.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
