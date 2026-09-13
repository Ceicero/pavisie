import {
  ZodArray,
  ZodBoolean,
  ZodDefault,
  ZodNullable,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodString,
  type ZodTypeAny,
} from 'zod';
import { ValidationError } from '@pavisie/core';
import type { PluginId } from '@pavisie/types';
import { isSnowflake } from '../sdk';
import type { PluginManifest } from '../sdk';
import type { GuildConfigPatch } from '../sdk';

export type ConfigValueKind =
  'boolean' | 'string' | 'number' | 'channel' | 'role' | 'role-list' | 'channel-list' | 'locale' | 'unknown';

export interface ConfigKeyDescriptor {
  /** Full dotted key as used by `/config set <key> <value>`, e.g. `guild.locale` or `moderation.someField`. */
  key: string;
  scope: 'guild' | PluginId;
  field: string;
  kind: ConfigValueKind;
  nullable: boolean;
  description: string;
}

interface GuildKeyDef {
  field: keyof GuildConfigPatch;
  kind: ConfigValueKind;
  nullable: boolean;
  description: string;
}

/** The core `GuildConfig` fields `/config set guild.<field>` is allowed to touch. */
const GUILD_CONFIG_KEY_DEFS: GuildKeyDef[] = [
  {
    field: 'locale',
    kind: 'locale',
    nullable: false,
    description: 'Server locale (only "en" is supported today).',
  },
  {
    field: 'timezone',
    kind: 'string',
    nullable: false,
    description: 'IANA timezone name, e.g. "America/New_York".',
  },
  {
    field: 'fastActions',
    kind: 'boolean',
    nullable: false,
    description: 'Skip confirmation prompts for destructive moderation actions.',
  },
  {
    field: 'modLogChannelId',
    kind: 'channel',
    nullable: true,
    description: 'Channel moderation case logs are posted to.',
  },
  { field: 'staffChannelId', kind: 'channel', nullable: true, description: 'General staff-only channel.' },
  {
    field: 'appealsChannelId',
    kind: 'channel',
    nullable: true,
    description: 'Private channel where moderation appeals are reviewed.',
  },
  {
    field: 'adminRoleIds',
    kind: 'role-list',
    nullable: false,
    description: 'Roles treated as admin staff level.',
  },
  {
    field: 'modRoleIds',
    kind: 'role-list',
    nullable: false,
    description: 'Roles treated as moderator staff level.',
  },
  {
    field: 'helperRoleIds',
    kind: 'role-list',
    nullable: false,
    description: 'Roles treated as helper staff level.',
  },
  {
    field: 'dataCollectionEnabled',
    kind: 'boolean',
    nullable: false,
    description: 'Enable analytics data collection for this server.',
  },
  {
    field: 'logMessageContent',
    kind: 'boolean',
    nullable: false,
    description: 'Allow capturing message content in edit/delete logs.',
  },
  {
    field: 'dmOnModeration',
    kind: 'boolean',
    nullable: false,
    description: 'DM users when a moderation action is taken against them.',
  },
];

/** Descriptors for every settable `guild.<field>` key. */
export function guildConfigKeys(): ConfigKeyDescriptor[] {
  return GUILD_CONFIG_KEY_DEFS.map((def) => ({
    key: `guild.${def.field}`,
    scope: 'guild' as const,
    field: def.field,
    kind: def.kind,
    nullable: def.nullable,
    description: def.description,
  }));
}

/** Peels `ZodDefault`/`ZodOptional`/`ZodNullable` wrappers off `schema` to find its innermost type, tracking nullability. */
function unwrap(schema: ZodTypeAny): { base: ZodTypeAny; nullable: boolean } {
  let current = schema;
  let nullable = false;
  for (;;) {
    if (current instanceof ZodDefault) {
      current = current._def.innerType as ZodTypeAny;
      continue;
    }
    if (current instanceof ZodOptional) {
      current = current._def.innerType as ZodTypeAny;
      nullable = true;
      continue;
    }
    if (current instanceof ZodNullable) {
      current = current._def.innerType as ZodTypeAny;
      nullable = true;
      continue;
    }
    break;
  }
  return { base: current, nullable };
}

/** Guesses a config value's UI/parsing "kind" from its field name and unwrapped zod base type. */
function kindFor(field: string, base: ZodTypeAny): ConfigValueKind {
  const lower = field.toLowerCase();
  if (base instanceof ZodBoolean) return 'boolean';
  if (base instanceof ZodNumber) return 'number';
  if (base instanceof ZodArray) {
    if (lower.includes('roleid')) return 'role-list';
    if (lower.includes('channelid')) return 'channel-list';
    return 'unknown';
  }
  if (base instanceof ZodString) {
    if (lower.includes('channelid')) return 'channel';
    if (lower.includes('roleid')) return 'role';
    if (lower === 'locale') return 'locale';
    return 'string';
  }
  return 'unknown';
}

/** Descriptors for every top-level key of `manifest.configSchema` (empty if the schema isn't a `z.object(...)`). */
export function pluginConfigKeys(manifest: PluginManifest): ConfigKeyDescriptor[] {
  const schema = manifest.configSchema;
  if (!(schema instanceof ZodObject)) return [];

  const shape = schema.shape as Record<string, ZodTypeAny>;
  return Object.entries(shape).map(([field, fieldSchema]) => {
    const { base, nullable } = unwrap(fieldSchema);
    return {
      key: `${manifest.id}.${field}`,
      scope: manifest.id,
      field,
      kind: kindFor(field, base),
      nullable,
      description: `${manifest.name} setting.`,
    };
  });
}

/** Every settable config key across `guild.*` and every loaded plugin's `<pluginId>.*`, for `/config set` autocomplete. */
export function allConfigKeys(manifests: PluginManifest[]): ConfigKeyDescriptor[] {
  return [...guildConfigKeys(), ...manifests.flatMap((manifest) => pluginConfigKeys(manifest))];
}

/** Finds the descriptor for a dotted key, across `guild.*` and every manifest's plugin-scoped keys. */
export function findConfigKey(manifests: PluginManifest[], key: string): ConfigKeyDescriptor | undefined {
  return allConfigKeys(manifests).find((descriptor) => descriptor.key === key);
}

const MENTION_PATTERN = /^<[@#][!&]?(\d{17,20})>$/;

/** Extracts a snowflake id from a raw value that may be a `<#id>`/`<@id>`/`<@&id>` mention or a bare id string. */
function extractSnowflake(value: string): string | null {
  const mentionMatch = MENTION_PATTERN.exec(value);
  if (mentionMatch) return mentionMatch[1];
  return isSnowflake(value) ? value : null;
}

const NULL_WORDS = new Set(['none', 'null', 'clear', 'unset']);
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1', 'enable', 'enabled']);
const FALSE_WORDS = new Set(['false', 'no', 'off', '0', 'disable', 'disabled']);

/** Parses a raw `/config set` string value according to `descriptor.kind`. Throws `ValidationError` on bad input. */
export function parseConfigValue(descriptor: ConfigKeyDescriptor, raw: string): unknown {
  const trimmed = raw.trim();

  if (descriptor.nullable && NULL_WORDS.has(trimmed.toLowerCase())) {
    return null;
  }

  switch (descriptor.kind) {
    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (TRUE_WORDS.has(lower)) return true;
      if (FALSE_WORDS.has(lower)) return false;
      throw new ValidationError(`"${raw}" isn't a valid boolean. Use true/false.`);
    }
    case 'number': {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) throw new ValidationError(`"${raw}" isn't a valid number.`);
      return parsed;
    }
    case 'channel':
    case 'role': {
      const id = extractSnowflake(trimmed);
      if (!id) throw new ValidationError(`"${raw}" isn't a valid ${descriptor.kind} mention or id.`);
      return id;
    }
    case 'role-list':
    case 'channel-list': {
      if (trimmed.length === 0) return [];
      const singular = descriptor.kind === 'role-list' ? 'role' : 'channel';
      return trimmed
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => {
          const id = extractSnowflake(part);
          if (!id) throw new ValidationError(`"${part}" isn't a valid ${singular} mention or id.`);
          return id;
        });
    }
    case 'locale': {
      if (trimmed !== 'en')
        throw new ValidationError(`"${raw}" isn't a supported locale. Only "en" is available today.`);
      return trimmed;
    }
    case 'string':
    default:
      return trimmed;
  }
}
