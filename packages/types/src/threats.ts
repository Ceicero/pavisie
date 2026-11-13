/**
 * Shared DTOs for the dashboard Threat overview page
 * (`/dashboard/[guildId]/threats`).
 *
 * `ThreatIncidentDto` is the contract Claude's raid-mode API will satisfy.
 * Until that API exists, `GET /guilds/:guildId/threats/incidents` is served
 * from a typed mock in `apps/api/src/lib/threat-incidents.ts`. Swapping to
 * the real source is a one-file change behind that adapter; this module's
 * shapes should not need to change when that happens, except to add fields
 * the real API introduces.
 *
 * The audit-trail half is live now: it is a filtered, read-only view of the
 * existing `AuditLog` table (every `moderation.*` action, including
 * `case.update`, `note.create`, `note.delete`, and `settings.update`).
 */
import type { AuditLogEntryDto } from './api';

// ---------------------------------------------------------------------------
// Live raid / threat incidents
// ---------------------------------------------------------------------------

/**
 * Kind of live or recently-ended threat incident shown on the overview.
 *
 * - `raid`: a join-burst caught by a `RAID_DETECTION` automod rule.
 * - `message_burst`: a message-rule burst after the per-channel individual
 *   staff-alert cap (the summary alert from automod's message-alert path).
 * - `lockdown`: a raid-lockdown action (raise verification, quarantine).
 */
export type ThreatIncidentKind = 'raid' | 'message_burst' | 'lockdown';

/**
 * Whether the incident is still in progress or has gone quiet / been lifted.
 *
 * For a raid, `ended` means no flagged join has arrived for the quiet
 * window. For a lockdown, `ended` means the lockdown was lifted.
 */
export type ThreatIncidentStatus = 'active' | 'ended';

/**
 * One live or recently-ended raid / threat incident for a guild.
 *
 * Kind-specific fields are optional and only meaningful for the matching
 * `kind`. Unknown fields from a future API should be ignored by clients;
 * known fields listed here are the stable contract.
 */
export interface ThreatIncidentDto {
  /**
   * Stable id for this incident. The stub uses `{kind}-{status}-{guildId}`
   * (plus a discriminator when a guild has more than one of the same kind).
   * The real API may use a different opaque id; clients must treat it as
   * an opaque string.
   */
  id: string;
  guildId: string;
  kind: ThreatIncidentKind;
  status: ThreatIncidentStatus;
  /** Automod rule that raised the incident, when known. */
  ruleId?: string;
  ruleName: string;
  /**
   * True when the rule was in dry-run: staff were alerted, but no member
   * action (quarantine, timeout, …) was taken.
   */
  dryRun: boolean;
  /** ISO-8601. When the first flagged event in this incident occurred. */
  startedAt: string;
  /** ISO-8601. Most recent flagged event (or close) in this incident. */
  lastActivityAt: string;
  /** ISO-8601. Set when `status` is `ended`. */
  endedAt?: string;

  /** `raid`: number of joins flagged during the burst. */
  joinsFlagged?: number;
  /**
   * `message_burst`: additional matches counted after the per-channel
   * individual-alert cap.
   */
  matches?: number;
  /** `message_burst`: distinct members in those matches. */
  members?: number;
  /** `message_burst`: Discord channel snowflake where the burst happened. */
  channelId?: string;
  /**
   * `lockdown`: the lockdown action applied (e.g. `raise-verification`,
   * `quarantine`).
   */
  lockdownAction?: string;
}

// ---------------------------------------------------------------------------
// Moderation audit trail
// ---------------------------------------------------------------------------

/**
 * One row in the Threat overview's moderation audit trail.
 *
 * Extends the platform `AuditLogEntryDto` with optional case fields parsed
 * from the `after` payload. `caseNumber` / `caseType` are present on
 * `moderation.case.create` (written in the same transaction as the case
 * since #34); other `moderation.*` actions leave them unset.
 */
export interface ModerationAuditEntryDto extends AuditLogEntryDto {
  /** Case number, when `after.caseNumber` is an integer. */
  caseNumber?: number;
  /** Case type (e.g. `BAN`, `WARN`), when `after.type` is a string. */
  caseType?: string;
}
