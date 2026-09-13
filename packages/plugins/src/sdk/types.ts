import type { z } from 'zod';
import type {
  Client,
  ChatInputCommandInteraction,
  ContextMenuCommandInteraction,
  AutocompleteInteraction,
  ButtonInteraction,
  AnySelectMenuInteraction,
  ModalSubmitInteraction,
  ClientEvents,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandOptionsOnlyBuilder,
  ContextMenuCommandBuilder,
  PermissionResolvable,
  GatewayIntentBits,
  Locale,
} from 'discord.js';
import type { Job, Queue } from 'bullmq';
import type { PrismaClient } from '@pavisie/database';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { PluginId, StaffLevel } from '@pavisie/types';
import type { PlatformEvents, RateLimiterLike, AuditEntry, env as coreEnv } from '@pavisie/core';
import type { ServiceRegistry } from './services';

export type PluginCategory =
  'admin' | 'moderation' | 'community' | 'utility' | 'integrations' | 'ai' | 'media';
export type PrivilegedIntent = 'MessageContent' | 'GuildMembers' | 'GuildPresences';

export interface PluginPermissionDoc {
  permission: PermissionResolvable; // e.g. PermissionFlagsBits.BanMembers
  feature: string; // "ban / softban"
  optional: boolean;
  fallback: string; // behaviour when missing
}

export interface PluginManifest {
  id: PluginId;
  name: string;
  description: string;
  category: PluginCategory;
  version: string;
  defaultEnabled: boolean;
  alwaysEnabled?: boolean; // admin only
  permissions: PluginPermissionDoc[]; // used by /permissions audit + README matrix
  intents: GatewayIntentBits[]; // non-privileged intents needed
  privilegedIntents?: PrivilegedIntent[]; // features degrade if not enabled
  requiredEnv: string[]; // ALL must be set or plugin status = 'unavailable'
  optionalEnv?: string[];
  configSchema: z.ZodTypeAny; // per-guild config; MUST have defaults for every field
  defaultConfig: unknown; // = configSchema.parse({})
  dashboard?: { path: string; label: string; icon: string }; // icon = lucide icon name
  privacyNotes?: string[]; // shown in dashboard + README
}

export type CommandBuilder =
  | SlashCommandBuilder
  | SlashCommandSubcommandsOnlyBuilder
  | SlashCommandOptionsOnlyBuilder
  | ContextMenuCommandBuilder
  | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;

export interface CommandRequirement {
  staffLevel?: StaffLevel; // minimum configured staff level (see core resolveStaffLevel)
  discordPermissions?: PermissionResolvable[]; // actor must have ALL (checked in addition to staffLevel when both given: staffLevel OR discordPermissions satisfies)
  botPermissions?: PermissionResolvable[]; // bot must have in guild/channel; else friendly error
  botOwnerOnly?: boolean;
  guildOnly?: boolean; // default true
  cooldown?: { seconds: number; scope: 'user' | 'guild' | 'channel' };
}

export interface CommandContext {
  interaction: ChatInputCommandInteraction<'cached'>;
  ctx: PluginContext;
  guildId: string;
  staffLevel: StaffLevel;
  locale: Locale;
  t: (key: string, vars?: Record<string, string | number>) => string;
  config: <T = unknown>() => Promise<T>; // this plugin's guild config (parsed with configSchema)
}
export interface ContextMenuContext extends Omit<CommandContext, 'interaction'> {
  interaction: ContextMenuCommandInteraction<'cached'>;
}
export interface AutocompleteContext extends Omit<CommandContext, 'interaction'> {
  interaction: AutocompleteInteraction<'cached'>;
}
export interface ComponentContext<
  I = ButtonInteraction<'cached'> | AnySelectMenuInteraction<'cached'> | ModalSubmitInteraction<'cached'>,
> extends Omit<CommandContext, 'interaction'> {
  interaction: I;
  args: string[];
}

export interface PluginCommand {
  data: CommandBuilder; // name must be unique across ALL plugins
  requirement?: CommandRequirement;
  execute(c: CommandContext): Promise<void>;
  executeContextMenu?(c: ContextMenuContext): Promise<void>;
  autocomplete?(c: AutocompleteContext): Promise<void>;
}

export interface PluginEventHandler<K extends keyof ClientEvents = keyof ClientEvents> {
  event: K;
  once?: boolean;
  /** Return the guildId the event belongs to (so the host can gate on plugin enablement); return null for non-guild events (then handler runs unconditionally). */
  guildIdOf?: (...args: ClientEvents[K]) => string | null | undefined;
  handler: (ctx: PluginContext, ...args: ClientEvents[K]) => Promise<void>;
}

/** Component custom ids are `<pluginId>:<action>:<arg1>:<arg2>...` (max 100 chars). Host routes by pluginId then action. */
export interface ComponentHandler {
  action: string; // e.g. 'confirm-ban'
  kind: 'button' | 'select' | 'modal';
  handler: (c: ComponentContext) => Promise<void>;
  requirement?: Pick<CommandRequirement, 'staffLevel' | 'discordPermissions' | 'botOwnerOnly'>;
  /** if true (default), only the user who created the component may use it. Encode owner user id as first arg for that check: `<plugin>:<action>:<ownerUserId>:...`. */
  ownerOnly?: boolean;
}

export interface PluginJob<T = unknown> {
  name: string; // queue name = `${pluginId}.${name}` (BullMQ forbids ":" in queue names)
  processor: (ctx: PluginContext, job: Job<T>) => Promise<void>;
  concurrency?: number;
  repeat?: { pattern: string }; // cron; scheduled at load with jobId = name (idempotent)
}

export interface PluginHealth {
  status: 'ok' | 'degraded' | 'unavailable' | 'disabled';
  details?: string;
}

export interface PluginContext {
  client: Client<true>;
  prisma: PrismaClient;
  redis: Redis;
  logger: Logger; // child logger with { plugin: id }
  events: PlatformEvents; // in-process typed bus
  rateLimiter: RateLimiterLike;
  queue: (jobName: string) => Queue; // returns/creates queue `${pluginId}.${jobName}`
  getConfig: <T>(guildId: string) => Promise<T>; // this plugin's guild config with defaults applied
  setConfig: <T>(
    guildId: string,
    patch: Partial<T>,
    actor: { id: string; source: 'bot' | 'dashboard' | 'system' },
  ) => Promise<T>;
  isEnabled: (guildId: string, pluginId?: PluginId) => Promise<boolean>;
  services: ServiceRegistry; // cross-plugin services (see §7.5)
  audit: (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>, locale?: string) => string;
  env: typeof coreEnv;
  botOwnerIds: string[];
  intentsEnabled: { messageContent: boolean; guildMembers: boolean; guildPresences: boolean };
}

export interface Plugin {
  manifest: PluginManifest;
  commands: PluginCommand[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event handlers are heterogeneous over ClientEvents keys; a plugin's `events` array mixes handlers for different event names, so a common element type needs `any` here (each individual PluginEventHandler<K> stays fully typed).
  events?: PluginEventHandler<any>[];
  components?: ComponentHandler[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- job payload types vary per job; the array element type must erase them (each PluginJob<T> stays fully typed at its declaration site).
  jobs?: PluginJob<any>[];
  onLoad?(ctx: PluginContext): Promise<void>;
  onGuildEnable?(ctx: PluginContext, guildId: string): Promise<void>;
  onGuildDisable?(ctx: PluginContext, guildId: string): Promise<void>;
  health?(ctx: PluginContext): Promise<PluginHealth>;
  migrations?: { id: string; run(ctx: PluginContext): Promise<void> }[]; // recorded in PluginMigration table
}
