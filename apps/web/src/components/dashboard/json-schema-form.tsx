'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import {
  Badge,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  CHANNEL_KIND_TYPES,
  type ChannelKind,
} from '@pavisie/ui';
import { defaultForSchema, type JsonSchemaNode } from '@/lib/dashboard/json-schema';
import { DiscordChannelSelect, DiscordRoleSelect } from './discord-selects';

export interface JsonSchemaFormProps {
  schema: JsonSchemaNode;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  guildId: string;
  disabled?: boolean;
}

/**
 * Renders a form from the API's `configJsonSchema` for a plugin's per-guild config.
 * Supports string/number/boolean/enum/array-of-strings (tag input) and nullable fields.
 * `format: 'discord-channel' | 'discord-role'` route to the channel/role pickers; if the
 * `GET /guilds/:id/discord/channels|roles` endpoints error (not yet implemented by the API),
 * those fields fall back to a plain text input for the raw id.
 */
export function JsonSchemaForm({ schema, value, onChange, guildId, disabled }: JsonSchemaFormProps) {
  const properties = schema.properties ?? {};
  const entries = Object.entries(properties);

  function setField(key: string, next: unknown) {
    onChange({ ...value, [key]: next });
  }

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">This plugin has no configurable options.</p>;
  }

  return (
    <div className="space-y-5">
      {entries.map(([key, node]) => (
        <SchemaField
          key={key}
          fieldKey={key}
          node={node}
          value={value[key]}
          onChange={(next) => setField(key, next)}
          guildId={guildId}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

/** Parses an optional `x-channel-kinds` schema hint into known `ChannelKind`s; undefined when absent/empty/unrecognized. */
function readChannelKinds(raw: unknown): ChannelKind[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const kinds = raw.filter((k): k is ChannelKind => typeof k === 'string' && k in CHANNEL_KIND_TYPES);
  return kinds.length > 0 ? kinds : undefined;
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface SchemaFieldProps {
  fieldKey: string;
  node: JsonSchemaNode;
  value: unknown;
  onChange: (next: unknown) => void;
  guildId: string;
  disabled?: boolean;
}

function SchemaField({ fieldKey, node, value, onChange, guildId, disabled }: SchemaFieldProps) {
  const label = node.title ?? humanizeKey(fieldKey);
  const htmlId = `field-${fieldKey}`;
  const resolved = value === undefined ? defaultForSchema(node) : value;

  // Union types (zod `.union()`/`.discriminatedUnion()`) — no single control fits every branch, so fall back
  // to raw JSON rather than silently rendering '[object Object]' or corrupting the value on the first keystroke.
  if (node.anyOf && node.anyOf.length > 0) {
    return (
      <FormField
        label={label}
        htmlFor={htmlId}
        hint={node.description ?? 'Advanced field — edit as raw JSON.'}
      >
        <JsonTextareaField id={htmlId} value={resolved} onChange={onChange} disabled={disabled} />
      </FormField>
    );
  }

  // Nested object (zod `.object()` inside a config schema, e.g. roles.welcome/verification, engagement.leveling).
  // Renders a nested field per property instead of falling through to a plain text input (which used to show
  // "[object Object]" and, on any keystroke, replace the whole nested value with a string).
  if (node.type === 'object' && node.properties) {
    const objectValue = (resolved && typeof resolved === 'object' ? resolved : {}) as Record<string, unknown>;
    const body = (
      <fieldset className="space-y-3 rounded-md border border-border p-3" disabled={disabled}>
        <legend className="px-1 text-sm font-medium text-foreground">{label}</legend>
        {node.description ? <p className="-mt-1 text-xs text-muted-foreground">{node.description}</p> : null}
        {Object.entries(node.properties).map(([childKey, childNode]) => (
          <SchemaField
            key={childKey}
            fieldKey={childKey}
            node={childNode}
            value={objectValue[childKey]}
            onChange={(next) => onChange({ ...objectValue, [childKey]: next })}
            guildId={guildId}
            disabled={disabled}
          />
        ))}
      </fieldset>
    );

    if (!node.nullable) return body;

    // Nullable object (e.g. roles.welcome.embed): a checkbox toggles between null and an actual object, so
    // "clear this section" stays possible without a JSON escape hatch.
    return (
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={resolved !== null && resolved !== undefined}
            disabled={disabled}
            onChange={(e) =>
              onChange(e.target.checked ? defaultForSchema({ ...node, nullable: false }) : null)
            }
          />
          Set {label}
        </label>
        {resolved !== null && resolved !== undefined ? body : null}
      </div>
    );
  }

  // Record<string, T> (zod `.record()`, e.g. logging.channels) and arrays of objects (e.g. roles.steps,
  // tickets.intakeForm) have no fixed set of keys/one-control-per-item — raw JSON, parsed on blur, is safer
  // than silently mangling the structure.
  const isRecord = node.type === 'object' && !node.properties && (node.additionalProperties ?? false);
  const isArrayOfObjects = node.type === 'array' && node.items?.type === 'object';
  if (isRecord || isArrayOfObjects) {
    return (
      <FormField
        label={label}
        htmlFor={htmlId}
        hint={node.description ?? 'Advanced field — edit as raw JSON.'}
      >
        <JsonTextareaField id={htmlId} value={resolved} onChange={onChange} disabled={disabled} />
      </FormField>
    );
  }

  // Array of numbers (e.g. community.eventReminderMinutes) → tag input parsing each tag as a number.
  if (node.type === 'array' && node.items?.type === 'number') {
    return (
      <FormField label={label} htmlFor={htmlId} hint={node.description}>
        <TagInput
          id={htmlId}
          value={Array.isArray(resolved) ? (resolved as number[]).map(String) : []}
          onChange={(tags) => onChange(tags.map((t) => Number(t)).filter((n) => !Number.isNaN(n)))}
          disabled={disabled}
        />
      </FormField>
    );
  }

  // Boolean → Switch, on its own row (no separate label control needed beyond FormField's).
  if (node.type === 'boolean') {
    return (
      <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {node.description ? <p className="text-xs text-muted-foreground">{node.description}</p> : null}
        </div>
        <Switch
          checked={Boolean(resolved)}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-label={label}
        />
      </div>
    );
  }

  // Discord channel/role formats.
  if (node.format === 'discord-channel') {
    // Optional `x-channel-kinds` (string[]) narrows the picker; nothing emits it yet (forward-compatible plumbing).
    const kinds = readChannelKinds(node['x-channel-kinds']);
    return (
      <FormField label={label} htmlFor={htmlId} hint={node.description}>
        <DiscordChannelSelect
          guildId={guildId}
          value={(resolved as string | null) ?? null}
          onChange={onChange}
          disabled={disabled}
          {...(kinds ? { kinds } : {})}
        />
      </FormField>
    );
  }
  if (node.format === 'discord-role') {
    return (
      <FormField label={label} htmlFor={htmlId} hint={node.description}>
        <DiscordRoleSelect
          guildId={guildId}
          value={(resolved as string | null) ?? null}
          onChange={onChange}
          disabled={disabled}
        />
      </FormField>
    );
  }

  // Enum → Select.
  if (node.enum && node.enum.length > 0) {
    return (
      <FormField label={label} htmlFor={htmlId} hint={node.description}>
        <Select value={String(resolved ?? '')} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={htmlId}>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {node.enum.map((opt) => (
              <SelectItem key={String(opt)} value={String(opt)}>
                {String(opt)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    );
  }

  // Array of strings → tag input.
  if (node.type === 'array' && (!node.items || node.items.type === 'string')) {
    return (
      <FormField label={label} htmlFor={htmlId} hint={node.description}>
        <TagInput
          id={htmlId}
          value={Array.isArray(resolved) ? (resolved as string[]) : []}
          onChange={onChange}
          disabled={disabled}
        />
      </FormField>
    );
  }

  // Number / integer.
  if (node.type === 'number' || node.type === 'integer') {
    return (
      <FormField label={label} htmlFor={htmlId} hint={node.description}>
        <Input
          id={htmlId}
          type="number"
          step={node.type === 'integer' ? 1 : 'any'}
          min={node.minimum}
          max={node.maximum}
          value={resolved === null || resolved === undefined ? '' : String(resolved)}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange(node.nullable ? null : 0);
              return;
            }
            const n = node.type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
            if (!Number.isNaN(n)) onChange(n);
          }}
        />
      </FormField>
    );
  }

  // Long text (format hint) vs short text.
  if (node.format === 'textarea') {
    return (
      <FormField label={label} htmlFor={htmlId} hint={node.description}>
        <Textarea
          id={htmlId}
          value={typeof resolved === 'string' ? resolved : ''}
          disabled={disabled}
          maxLength={node.maxLength}
          onChange={(e) => onChange(e.target.value)}
        />
      </FormField>
    );
  }

  // Default: plain string input.
  return (
    <FormField label={label} htmlFor={htmlId} hint={node.description}>
      <Input
        id={htmlId}
        value={typeof resolved === 'string' ? resolved : resolved === null ? '' : String(resolved ?? '')}
        disabled={disabled}
        minLength={node.minLength}
        maxLength={node.maxLength}
        onChange={(e) => onChange(node.nullable && e.target.value === '' ? null : e.target.value)}
      />
    </FormField>
  );
}

/**
 * Raw-JSON fallback for shapes `SchemaField` can't offer a dedicated control for (unions, records, arrays of
 * objects). Edits a local text buffer and only calls `onChange` once the buffer parses as valid JSON — an
 * in-progress/invalid edit never corrupts the stored config value, unlike the old plain `<Input>` fallback
 * which sent every keystroke straight through as a string.
 */
function JsonTextareaField({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}) {
  const [text, setText] = React.useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);

  // Reflect external changes (e.g. loading a different plugin's config) as long as the user hasn't started
  // typing a not-yet-committed edit here.
  React.useEffect(() => {
    if (!dirty) setText(JSON.stringify(value ?? null, null, 2));
  }, [value, dirty]);

  function commit() {
    try {
      const parsed = JSON.parse(text) as unknown;
      setError(null);
      setDirty(false);
      onChange(parsed);
    } catch {
      setError('Not valid JSON — edit not saved. Fix the syntax and click away again.');
    }
  }

  return (
    <div className="space-y-1">
      <Textarea
        id={id}
        value={text}
        disabled={disabled}
        className="font-mono text-xs"
        rows={6}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        onBlur={commit}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function TagInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = React.useState('');

  function commit() {
    const tag = draft.trim();
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft('');
  }

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              {tag}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${tag}`}
                  onClick={() => onChange(value.filter((t) => t !== tag))}
                  className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </Badge>
          ))}
        </div>
      ) : null}
      <Input
        id={id}
        value={draft}
        disabled={disabled}
        placeholder="Type a value and press Enter"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
