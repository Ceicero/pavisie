/**
 * DTOs for the owner-only ops metrics API (`GET /owner/metrics/*`) — the data source for the local
 * "Pavisie Dev" desktop app (Electron, Brandon's machine) that monitors the bot. Cross-guild by design, same
 * as `developer-reports.ts`: `apps/api`'s `/owner/metrics/*` routes are gated on bot-owner identity
 * (`requireBotOwner`), never `requireGuildAccess`. Read-only — there is no mutating counterpart.
 */

/** `GET /owner/metrics/overview` — headline counts for the dashboard's home screen. */
export interface OwnerMetricsOverviewDto {
  guilds: {
    total: number;
    active: number;
    inactive: number;
    joined7d: number;
    joined30d: number;
    left30d: number;
  };
  members: {
    /** Sum of `memberCount` across guilds the bot is currently in (`botPresent: true`); a left guild's last-known count is stale and excluded. */
    totalAcrossGuilds: number;
    largestGuild: { id: string; name: string; memberCount: number } | null;
  };
  reports: {
    open: number;
    handled: number;
    total: number;
  };
  activity: {
    moderationCases7d: number;
    ticketsOpen: number;
    automodEvents7d: number;
    enforcerPending: number;
  };
}

/** One row of `GET /owner/metrics/guilds` — cursor-paginated, newest-joined first. */
export interface OwnerMetricsGuildDto {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number | null;
  ownerId: string;
  botPresent: boolean;
  joinedAt: string;
  leftAt: string | null;
  /** Count of `PluginState` rows with `enabled: true` for this guild — an approximation of the full per-guild `PluginSummary[]` (`lib/plugin-summaries.ts`), which also folds in manifest defaults/always-enabled plugins; not worth the per-guild manifest walk for an ops list. */
  pluginsEnabled: number;
  moderationCases30d: number;
  ticketsOpen: number;
  /** Most recent `AuditLog.createdAt` for this guild, or `null` if it has none yet — the closest thing to a general "something happened here" signal; there's no dedicated last-activity column. */
  lastActivityAt: string | null;
}

/**
 * `GET /owner/metrics/errors` source tags. The schema has no dedicated error table — this feed is assembled
 * from the four models that carry an error column: `IntegrationConnection.lastError`, `ScheduledJob.lastError`,
 * `WebhookDelivery.error`, and `DataRequest.error`.
 */
export type OwnerMetricsErrorSource = 'integration' | 'job' | 'webhook' | 'data-request';

/** One row of `GET /owner/metrics/errors` — cursor-paginated, newest first across all sources merged. */
export interface OwnerMetricsErrorDto {
  id: string;
  source: OwnerMetricsErrorSource;
  /** `null` for a `ScheduledJob` row with no `guildId` (global/system jobs aren't guild-scoped). */
  guildId: string | null;
  guildName: string | null;
  message: string;
  occurredAt: string;
  context: Record<string, unknown>;
}

/** One day of `GET /owner/metrics/growth` — zero-filled for days with no joins/leaves. */
export interface OwnerMetricsGrowthPointDto {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  joined: number;
  left: number;
  /** Running cumulative `joined - left` from the start of the requested window (not an absolute guild-count total — there's no daily guild-count snapshot to anchor to). */
  netTotal: number;
}

export interface OwnerMetricsGrowthDto {
  points: OwnerMetricsGrowthPointDto[];
}

/**
 * One day of `GET /owner/metrics/usage` — fleet-wide feature usage, summed across every guild.
 * Zero-filled for days with no recorded activity.
 *
 * These are aggregate counts only. Nothing here identifies a user or carries message content —
 * it is the same privacy-safe daily rollup the per-guild analytics already keep (SPEC.md's
 * data-collection rules), just totalled across the whole fleet rather than one server.
 */
export interface OwnerMetricsUsagePointDto {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  messages: number;
  moderationActions: number;
  automodTriggers: number;
  ticketsOpened: number;
  joins: number;
  leaves: number;
}

/** Window totals for `GET /owner/metrics/usage`, so the client doesn't have to re-sum the points. */
export interface OwnerMetricsUsageTotalsDto {
  messages: number;
  moderationActions: number;
  automodTriggers: number;
  ticketsOpened: number;
  joins: number;
  leaves: number;
  /** How many distinct guilds reported any activity in the window. */
  activeGuilds: number;
}

export interface OwnerMetricsUsageDto {
  points: OwnerMetricsUsagePointDto[];
  totals: OwnerMetricsUsageTotalsDto;
}

/** Lower-cased Prisma `ConnectionStatus`, tallied — every key is always present (zero when no row has that status). */
export interface OwnerMetricsStatusCountsDto {
  connected: number;
  disconnected: number;
  error: number;
  pending: number;
}

/** One day of `GET /owner/metrics/twitch` — zero-filled for days nobody linked a channel. */
export interface OwnerMetricsTwitchPointDto {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  /** Twitch channels first linked on this day (`TwitchChatChannel.createdAt`) that still exist. */
  linked: number;
  /** Running total of `linked` from the start of the requested window (not an absolute channel count — a deleted channel leaves no row to count). */
  runningTotal: number;
}

/**
 * `GET /owner/metrics/twitch?days=` — the Twitch side of the fleet: Pavisie's own chat-bot account, every linked
 * channel, what streamers have configured, the channel economy, and the per-guild "stream is live" alert
 * connections. Aggregate counts only: no viewer ids, no chat content, no token material.
 */
export interface OwnerMetricsTwitchDto {
  /** The singleton `TwitchBotIdentity`. `configured: false` (with the other fields null) until the owner authorizes it. */
  bot: {
    configured: boolean;
    login: string | null;
    status: keyof OwnerMetricsStatusCountsDto | null;
    lastError: string | null;
  };
  channels: {
    total: number;
    /** `TwitchChatChannel.enabled` — the streamer's own on/off switch, independent of connection `status`. */
    enabled: number;
    status: OwnerMetricsStatusCountsDto;
    /** Linked to a Discord server (`guildId` set). */
    guildLinked: number;
    /** Set up from the creator dashboard with no Discord server. */
    standalone: number;
    linked7d: number;
    linked30d: number;
    rewardsEnabled: number;
    /** At least one direction of the Discord <-> Twitch chat bridge is on. */
    bridgeEnabled: number;
  };
  /** Enabled items only — a disabled command/timer/reward is configured but not in use. */
  features: {
    commands: number;
    timers: number;
    rewards: number;
    rewardsByAction: { sound: number; tts: number; chat: number; discord: number };
  };
  economy: {
    /** `ChannelEconomy` rows (a channel that saved economy settings at least once). */
    economies: number;
    enabled: number;
    /** Viewer wallets across every channel. */
    wallets: number;
    /** Wallets whose balance changed in the window (`updatedAt`) — the closest signal to "active viewers". */
    activeWallets7d: number;
    activeWallets30d: number;
    transactions7d: number;
    transactions30d: number;
    /** Last 30 days of ledger rows by `type` (daily, give, twitch_chat_earn, admin_add, admin_remove), busiest first. */
    transactionsByType30d: { type: string; count: number }[];
  };
  /** Per-guild Twitch "stream is live" alert connections (`IntegrationConnection`, provider TWITCH, not soft-deleted). */
  alerts: {
    total: number;
    status: OwnerMetricsStatusCountsDto;
  };
  points: OwnerMetricsTwitchPointDto[];
}

/** One row of `GET /owner/metrics/twitch/channels` — cursor-paginated, newest-linked first. */
export interface OwnerMetricsTwitchChannelDto {
  id: string;
  broadcasterLogin: string;
  enabled: boolean;
  status: keyof OwnerMetricsStatusCountsDto;
  /** `null` for a creator-dashboard-only channel with no Discord server linked. */
  guildId: string | null;
  guildName: string | null;
  commands: number;
  timers: number;
  rewards: number;
  rewardsEnabled: boolean;
  bridgeEnabled: boolean;
  lastConnectedAt: string | null;
  lastError: string | null;
  linkedAt: string;
}

/** One provider's row in `GET /owner/metrics/integrations`. */
export interface OwnerMetricsIntegrationProviderDto {
  /** Prisma `IntegrationProvider` value, e.g. `TWITCH`, `YOUTUBE`. */
  provider: string;
  total: number;
  status: OwnerMetricsStatusCountsDto;
}

/** `GET /owner/metrics/integrations` — every non-deleted guild integration connection, tallied by provider and status. */
export interface OwnerMetricsIntegrationsDto {
  /** Busiest provider first. Providers with no connections are omitted. */
  providers: OwnerMetricsIntegrationProviderDto[];
  totals: { total: number; status: OwnerMetricsStatusCountsDto };
}
