import type { PluginId } from './plugins';

/** Standard error envelope returned by every API error response. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** The authenticated dashboard user, derived from their Discord OAuth identity. */
export interface SessionUser {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
}

/** `GET /me/twitch-link` — the caller's own Discord↔Twitch account link, if any (ARCHITECTURE.md §19d).
 * Never carries `twitchUserId`: the dashboard has no reason to see it, only the login for display. */
export type TwitchAccountLinkDto =
  | { linked: false }
  | { linked: true; twitchLogin: string; linkedAt: string };

/** A guild the dashboard user can see, with bot presence and manage-permission info. */
export interface GuildSummary {
  id: string;
  name: string;
  iconUrl: string | null;
  botPresent: boolean;
  canManage: boolean;
  owner: boolean;
}

export interface PluginPermissionDto {
  permission: string;
  feature: string;
  optional: boolean;
  fallback: string;
}

export interface PluginHealthDto {
  status: 'ok' | 'degraded' | 'unavailable' | 'disabled';
  details?: string;
}

/** A plugin's dashboard-facing summary: metadata, enablement, availability, and health. */
export interface PluginSummary {
  id: PluginId;
  name: string;
  description: string;
  category: string;
  version: string;
  enabled: boolean;
  defaultEnabled: boolean;
  alwaysEnabled: boolean;
  available: boolean;
  availabilityReason?: string;
  health?: PluginHealthDto;
  dashboardPath?: string;
  privacyNotes: string[];
  permissions: PluginPermissionDto[];
  privilegedIntents: string[];
}

/** Per-guild core configuration (staff roles, locale, logging/data-collection toggles). */
export interface GuildConfigDto {
  guildId: string;
  locale: string;
  timezone: string;
  adminRoleIds: string[];
  modRoleIds: string[];
  helperRoleIds: string[];
  modLogChannelId: string | null;
  staffChannelId: string | null;
  fastActions: boolean;
  dataCollectionEnabled: boolean;
  logMessageContent: boolean;
  dmOnModeration: boolean;
}

export interface GuildOverviewStats {
  memberCount?: number;
  pluginsEnabled: number;
  pluginCount: number;
  openTickets: number;
  pendingReviews: number;
  moderationCasesLast7d: number;
}

/** `GET /guilds/:guildId` — overview stats for a guild's dashboard home page (ARCHITECTURE.md §10). */
export interface GuildOverviewDto {
  guild: {
    id: string;
    name: string;
    iconUrl: string | null;
    memberCount: number | null;
    ownerId: string | null;
    joinedAt: string | null;
    botPresent: boolean;
    canManage: true;
    owner: boolean;
  };
  config: GuildConfigDto;
  stats: GuildOverviewStats;
  plugins: PluginSummary[];
  setupIncomplete: boolean;
  setupIssues: string[];
  /** @deprecated use stats.pluginCount */
  pluginCount: number;
  /** @deprecated use stats.pluginsEnabled */
  pluginsEnabled: number;
}

export interface AuditLogEntryDto {
  id: string;
  guildId: string;
  actorId: string;
  actorType: 'user' | 'system';
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  source: 'bot' | 'dashboard' | 'system';
  createdAt: string;
}

export interface ModerationCaseDto {
  id: string;
  guildId: string;
  caseNumber: number;
  type: string;
  targetId: string;
  moderatorId: string;
  reason: string | null;
  evidenceUrls: string[];
  durationMs: number | null;
  expiresAt: string | null;
  expiredAt: string | null;
  dmSent: boolean;
  metadata: Record<string, unknown>;
  source: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ModerationWarningDto {
  id: string;
  guildId: string;
  caseId: string;
  targetId: string;
  moderatorId: string;
  reason: string | null;
  active: boolean;
  createdAt: string;
}

export interface AutomodRuleDto {
  id: string;
  guildId: string;
  name: string;
  type: string;
  enabled: boolean;
  dryRun: boolean;
  /** Best-effort summary of `actions` (e.g. the primary action's type, or a comma-joined list) for older consumers. */
  action: string;
  /** Added by apps/api (ARCHITECTURE.md §10): the rule's full per-action config list; `AutomodRule.actions` in Prisma is a Json array, not a single string. Optional so existing consumers reading only `action` keep working. */
  actions?: Record<string, unknown>[];
  config: Record<string, unknown>;
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  exemptUserIds: string[];
  /** Link-based rules (scam links, etc.) never flag these domains. Added by the automod build stage — optional so older consumers reading only the fields above keep working. */
  trustedDomains?: string[];
  /** Per-user, per-rule cooldown in seconds (0 = none). Added by the automod build stage. */
  cooldownSeconds?: number;
  /** Lower runs first. Added by the automod build stage. */
  priority?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AutomodEventDto {
  id: string;
  guildId: string;
  ruleId: string;
  userId: string;
  channelId: string;
  action: string;
  dryRun: boolean;
  reviewStatus: 'PENDING' | 'APPROVED' | 'FALSE_POSITIVE';
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TicketDto {
  id: string;
  guildId: string;
  channelId: string | null;
  threadId: string | null;
  openerId: string;
  status: 'open' | 'closed';
  category: string | null;
  assigneeId: string | null;
  tags: string[];
  createdAt: string;
  closedAt: string | null;
  deletedAt: string | null;
}

export interface RolePanelOptionDto {
  id: string;
  roleId: string;
  label: string;
  emoji?: string | null;
  description?: string | null;
}

export interface RolePanelDto {
  id: string;
  guildId: string;
  channelId: string | null;
  messageId: string | null;
  title: string;
  description: string | null;
  mode: 'reaction' | 'button' | 'select';
  maxSelections: number | null;
  options: RolePanelOptionDto[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface IntegrationConnectionDto {
  id: string;
  guildId: string;
  provider: string;
  /** 'pending' added by apps/api (ARCHITECTURE.md §10): Prisma's ConnectionStatus enum has a fourth PENDING state (OAuth flow started, not yet completed) that the original 3-value union couldn't represent. */
  status: 'connected' | 'disconnected' | 'error' | 'pending';
  externalAccountId: string | null;
  externalAccountName: string | null;
  scopes: string[];
  connectedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEndpointDto {
  id: string;
  guildId: string;
  provider: string;
  direction: 'inbound' | 'outbound';
  url: string | null;
  active: boolean;
  createdAt: string;
  deletedAt: string | null;
}

export interface AnalyticsDto {
  range: string;
  memberGrowth: { date: string; joins: number; leaves: number; total: number }[];
  moderationVolume: { date: string; count: number }[];
  messageActivity: { date: string; count: number }[];
}

export interface RetentionPolicyDto {
  guildId: string;
  moderationRetentionDays: number | null;
  logRetentionDays: number | null;
  ticketTranscriptRetentionDays: number | null;
  automodEventRetentionDays: number | null;
  /** Added by apps/api (ARCHITECTURE.md §10): DataRetentionPolicy fields with no prior DTO mapping. Optional/nullable so existing consumers are unaffected. */
  auditLogRetentionDays?: number | null;
  levelInactivityRetentionDays?: number | null;
  analyticsRetentionDays?: number | null;
  updatedAt: string;
}

export interface DataRequestDto {
  id: string;
  guildId: string;
  type: 'export' | 'delete';
  /** 'cancelled' added by apps/api (ARCHITECTURE.md §10): Prisma's shared JobStatus enum includes CANCELLED, which the original 4-value union couldn't represent. */
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  requestedByUserId: string;
  resultUrl?: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface LogEventDto {
  id: string;
  guildId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Generic cursor-paginated response envelope. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
