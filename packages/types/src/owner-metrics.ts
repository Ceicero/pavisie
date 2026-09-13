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
