import type { ActionSource, ModerationCase, ModerationCaseType } from '@pavisie/database';
import type { PluginId } from '@pavisie/types';
import type { GuildConfigData, GuildConfigPatch } from './config-store';
import type { PluginAvailability } from './registry';
import type { PluginHealth, PluginManifest } from './types';

/** Input to `moderation.createCase` (ARCHITECTURE.md §7.5). */
export interface CreateModerationCaseInput {
  guildId: string;
  type: ModerationCaseType;
  targetId: string;
  moderatorId: string;
  reason?: string;
  evidenceUrls?: string[];
  durationMs?: number;
  source: ActionSource;
  metadata?: Record<string, unknown>;
  /** Whether to attempt a DM to the target explaining the action; failures are swallowed (see `safeDm`). */
  dmUser?: boolean;
}

export interface WarnInput {
  guildId: string;
  targetId: string;
  moderatorId: string;
  reason?: string;
  source: ActionSource;
  dmUser?: boolean;
}

export interface TimeoutInput {
  guildId: string;
  targetId: string;
  moderatorId: string;
  durationMs: number;
  reason?: string;
  source: ActionSource;
  dmUser?: boolean;
}

export interface ListCasesInput {
  guildId: string;
  targetId?: string;
  moderatorId?: string;
  type?: ModerationCaseType;
  cursor?: string | null;
  limit?: number;
}

export interface ListCasesResult {
  items: ModerationCase[];
  nextCursor: string | null;
}

/** Input to `moderation.openAppeal` (ARCHITECTURE.md §19). */
export interface OpenAppealInput {
  guildId: string;
  userId: string;
  caseNumber?: number;
  caseId?: string;
  content: string;
  source: 'bot' | 'dashboard';
}

export interface OpenAppealResult {
  appealId: string;
}

export interface ExportCasesOptions {
  since?: Date;
}

export interface ExportCasesResult {
  csv: string;
  count: number;
}

/** Cross-plugin moderation actions, registered by the `moderation` plugin in `onLoad`. */
export interface ModerationService {
  createCase(input: CreateModerationCaseInput): Promise<ModerationCase>;
  warn(input: WarnInput): Promise<ModerationCase>;
  timeout(input: TimeoutInput): Promise<ModerationCase>;
  getCase(guildId: string, caseNumber: number): Promise<ModerationCase | null>;
  listCases(input: ListCasesInput): Promise<ListCasesResult>;
  /** Opens an appeal through the moderation plugin's appeal workflow (used by `enforcer` and the dashboard). */
  openAppeal(input: OpenAppealInput): Promise<OpenAppealResult>;
  /** Alias of `getCase` with the ARCHITECTURE.md §19 name; looks a case up by its per-guild case number. */
  getCaseByNumber(guildId: string, caseNumber: number): Promise<ModerationCase | null>;
  /** Exports a guild's moderation cases as CSV, optionally limited to cases created since a given time. */
  exportCases(guildId: string, opts?: ExportCasesOptions): Promise<ExportCasesResult>;
}

/** Log event kinds the `logging` plugin routes to configured channels (ARCHITECTURE.md §7.5). */
export type LogKind =
  | 'member.join'
  | 'member.leave'
  | 'message.edit'
  | 'message.delete'
  | 'role.update'
  | 'channel.update'
  | 'guild.update'
  | 'moderation.action'
  | 'voice.join'
  | 'voice.leave'
  | 'invite.use'
  | 'bot.error'
  | 'webhook.failure'
  | 'automod.trigger'
  | 'ticket.event'
  | 'verification.event';

export interface LogEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface LogPayload {
  actorId?: string;
  targetId?: string;
  channelId?: string;
  messageId?: string;
  title?: string;
  description?: string;
  fields?: LogEmbedField[];
  color?: number;
  /** Only populated when the guild has opted into message-content logging (`GuildConfig.logMessageContent`). */
  contentBefore?: string;
  contentAfter?: string;
  attachments?: string[];
}

/** Routes structured log events to configured log channels, registered by the `logging` plugin. */
export interface LoggingService {
  log(guildId: string, kind: LogKind, payload: LogPayload): Promise<void>;
}

/** Registered by the `automod` plugin so other plugins can trigger a quarantine without depending on it directly. */
export interface AutomodService {
  quarantine(guildId: string, userId: string, reason: string): Promise<void>;
}

export interface CreateTicketInput {
  guildId: string;
  openerId: string;
  channelId?: string;
  subject?: string;
  intake?: Record<string, unknown>;
}

/** Registered by the `tickets` plugin. */
export interface TicketsService {
  createTicket(input: CreateTicketInput): Promise<{ id: string; number: number }>;
  closeTicket(guildId: string, ticketId: string, closedBy: string, reason?: string): Promise<void>;
  /** Posts (or re-posts) a ticket panel message to its configured channel. */
  postPanel(guildId: string, panelId: string): Promise<void>;
  /** Closes a ticket initiated from the dashboard (as opposed to a Discord interaction). */
  closeTicketFromDashboard(
    guildId: string,
    ticketId: string,
    closedBy: string,
    reason?: string,
  ): Promise<void>;
}

export interface AssignRolesInput {
  guildId: string;
  userId: string;
  addRoleIds?: string[];
  removeRoleIds?: string[];
  reason?: string;
}

export interface VerifyMemberInput {
  guildId: string;
  userId: string;
  method: string;
}

export interface VerificationDecisionInput {
  guildId: string;
  requestId: string;
  approve: boolean;
  reviewerId: string;
  note?: string;
}

/** Registered by the `roles` plugin. */
export interface RolesService {
  assignRoles(input: AssignRolesInput): Promise<void>;
  verifyMember(input: VerifyMemberInput): Promise<void>;
  /** Posts (or re-posts) a role panel message to its configured channel. */
  postPanel(guildId: string, panelId: string, requestedBy?: string): Promise<void>;
  /** Sends a preview of the guild's configured welcome message, optionally to a specific channel. */
  testWelcome(guildId: string, requestedBy: string, channelId?: string): Promise<void>;
  /** Approves or denies a pending verification request from staff review (bot or dashboard). */
  verificationDecision(input: VerificationDecisionInput): Promise<void>;
}

/** Registered by the `integrations` plugin. */
export interface IntegrationsService {
  sendOutbound(
    guildId: string,
    endpointId: string,
    payload: unknown,
  ): Promise<{ delivered: boolean; error?: string }>;
  /** Sends a synthetic test payload through a configured outbound webhook endpoint. */
  testWebhook(guildId: string, endpointId: string): Promise<{ delivered: boolean; error?: string }>;
}

export interface AiCompleteInput {
  guildId: string;
  userId: string;
  command: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
}

export interface AiCompleteResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
  provider: string;
}

/** Registered by the `ai` plugin. */
export interface AiService {
  complete(input: AiCompleteInput): Promise<AiCompleteResult>;
  /** Round-trips a trivial prompt against the configured provider to verify credentials/connectivity. */
  test(guildId: string): Promise<{ ok: boolean; detail?: string }>;
}

/** Input to `enforcer.decide` (ARCHITECTURE.md §19). */
export interface EnforcerDecideInput {
  guildId: string;
  recordId: string;
  decision: 'WARN' | 'TIMEOUT' | 'MUTE' | 'UNMUTE' | 'KICK' | 'BAN' | 'DISMISS';
  moderatorId: string;
  reason?: string;
  durationMs?: number;
  banDeleteMessageSeconds?: number;
  source: 'bot' | 'dashboard';
}

export interface EnforcerDecideResult {
  recordNumber: number;
}

/** Input to `enforcer.flag` (ARCHITECTURE.md §19). */
export interface EnforcerFlagInput {
  guildId: string;
  userId: string;
  moderatorId?: string;
  reason?: string;
  policyId?: string;
  channelId?: string;
  messageId?: string;
  source: 'MANUAL' | 'DASHBOARD';
}

export interface EnforcerFlagResult {
  recordId: string;
  recordNumber: number;
}

/** Registered by the `enforcer` plugin. */
export interface EnforcerService {
  decide(input: EnforcerDecideInput): Promise<EnforcerDecideResult>;
  flag(input: EnforcerFlagInput): Promise<EnforcerFlagResult>;
  /** Re-applies the ledger/flag-queue channel permission overwrites, and the mute-role deny-overwrites (when a
   * mute role is configured and still exists), across every manageable channel (`/enforcer setup` → "repair
   * channel"). Returns how many channels the mute-role overwrite was applied to / failed on (both 0 when no
   * mute role is configured or it no longer exists). */
  repairChannels(guildId: string): Promise<{ muteApplied: number; muteFailed: number }>;
}

/** Snapshot of the Twitch chat bot's EventSub WebSocket connection, for `/twitch status` and the plugin's `health()`. */
export interface TwitchChatRuntimeStatus {
  /** False when TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET are unset or no `TwitchBotIdentity` row exists — everything else no-ops. */
  enabled: boolean;
  /** Why `enabled` is false, or why the socket is currently down; undefined when healthy. */
  reason?: string;
  connected: boolean;
  sessionId: string | null;
  joinedChannels: number;
  lastError: string | null;
}

/** Registered by the `integrations` plugin's Twitch chat runtime (packages/plugins/src/integrations/twitch-chat/manager.ts). */
export interface TwitchChatService {
  status(): TwitchChatRuntimeStatus;
  /** Forces an immediate reconcile (create/delete EventSub subscriptions for changed channels) instead of waiting for the next job tick. */
  reconcileNow(): Promise<void>;
  /** Closes the EventSub socket and clears in-memory state; called from the host `shutdown()` before Redis/Prisma disconnect. */
  stop(): Promise<void>;
}

export interface HostEnableActor {
  id: string;
  source: 'bot' | 'dashboard' | 'system';
}

export interface HostBotStats {
  wsPingMs: number;
  uptimeSec: number;
  guildCount: number;
  memoryMb: number;
}

/**
 * Registered by the bot/api host process itself (not a feature plugin). The `admin` plugin is the one place
 * that needs cross-plugin, host-level operations (arbitrary plugin enablement/config, core `GuildConfig`,
 * bot-wide stats) that a normal `PluginContext` deliberately doesn't expose to every plugin — this is that
 * seam, so `admin`'s `/setup`, `/config`, `/plugin`, `/permissions`, and `/health` commands can reach them
 * without importing the bot host or holding their own `PluginRegistry`/`GuildConfigStore` instance.
 */
export interface HostService {
  /** Enables `pluginId` for `guildId` and runs its `onGuildEnable` hook, if any. Refuses always-enabled plugins. */
  enable(guildId: string, pluginId: PluginId, actor: HostEnableActor): Promise<void>;
  /** Disables `pluginId` for `guildId` and runs its `onGuildDisable` hook, if any. Refuses always-enabled plugins. */
  disable(guildId: string, pluginId: PluginId, actor: HostEnableActor): Promise<void>;
  isPluginEnabled(guildId: string, pluginId: PluginId): Promise<boolean>;
  /** Every loaded plugin's manifest, in registration order (ARCHITECTURE.md §7.1). */
  listManifests(): PluginManifest[];
  getManifest(pluginId: PluginId): PluginManifest | undefined;
  /** Availability (env/intents) for every loaded plugin, as computed by `PluginRegistry.availability`. */
  getPluginAvailability(): Map<PluginId, PluginAvailability>;
  /** Result of `plugin.health(ctx)` for a loaded plugin that declares one; `undefined` if it doesn't or isn't loaded. */
  getPluginHealth(pluginId: PluginId): Promise<PluginHealth | undefined>;
  getPluginConfig<T = unknown>(guildId: string, pluginId: PluginId): Promise<T>;
  setPluginConfig<T = unknown>(
    guildId: string,
    pluginId: PluginId,
    patch: Partial<T>,
    actor: HostEnableActor,
  ): Promise<T>;
  getGuildConfig(guildId: string): Promise<GuildConfigData>;
  updateGuildConfig(
    guildId: string,
    patch: GuildConfigPatch,
    actor: HostEnableActor,
  ): Promise<GuildConfigData>;
  getBotStats(): HostBotStats;
}

/** Typed map of cross-plugin service keys to their implementation shape (ARCHITECTURE.md §7.5). */
export interface ServiceMap {
  moderation: ModerationService;
  logging: LoggingService;
  automod: AutomodService;
  tickets: TicketsService;
  roles: RolesService;
  integrations: IntegrationsService;
  ai: AiService;
  host: HostService;
  enforcer: EnforcerService;
  twitchChat: TwitchChatService;
}

/** Registry of cross-plugin services. Consumers call `.get(key)` and no-op gracefully when the provider isn't loaded. */
export class ServiceRegistry {
  private readonly services = new Map<keyof ServiceMap, ServiceMap[keyof ServiceMap]>();

  /** Registers (overwriting any existing) implementation for `key`. */
  register<K extends keyof ServiceMap>(key: K, impl: ServiceMap[K]): void {
    this.services.set(key, impl);
  }

  /** Returns the implementation for `key`, or `undefined` if no plugin has registered it (e.g. it's disabled/unavailable). */
  get<K extends keyof ServiceMap>(key: K): ServiceMap[K] | undefined {
    return this.services.get(key) as ServiceMap[K] | undefined;
  }

  /** Like `get`, but throws a descriptive error if the service isn't registered. */
  require<K extends keyof ServiceMap>(key: K): ServiceMap[K] {
    const impl = this.get(key);
    if (!impl) {
      throw new Error(
        `Service "${key}" is not registered (its owning plugin may be disabled or unavailable).`,
      );
    }
    return impl;
  }

  /** True if `key` currently has a registered implementation. */
  has(key: keyof ServiceMap): boolean {
    return this.services.has(key);
  }
}
