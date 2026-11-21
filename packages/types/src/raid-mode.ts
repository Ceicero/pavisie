/**
 * Raid mode's per-member drill-down (`GET /guilds/:guildId/raid-mode/incidents/:incidentId/members`).
 *
 * The incident list itself is served as `ThreatIncidentDto` (threats.ts). This route is separate on purpose so
 * the panel only shows counts, and per-member data stays behind its own reviewed endpoint.
 *
 * Only medium- and high-risk joins during a raid are stored, with nothing beyond what is below, and they are
 * deleted 30 days after the incident ends.
 */
export type RaidModeRiskLevel = 'medium' | 'high';

/** Why a join scored as it did. Short codes only; no names, avatars or message content. */
export type RaidModeRiskReason =
  | 'discord_spammer_flag'
  | 'account_age_lt_1h'
  | 'account_age_lt_1d'
  | 'account_age_lt_7d'
  | 'default_avatar'
  | 'numbered_username';

export interface RaidModeRiskMemberDto {
  /** Discord user snowflake. */
  userId: string;
  /** 0–100. 30–59 is medium, 60 and up is high. */
  score: number;
  level: RaidModeRiskLevel;
  reasons: RaidModeRiskReason[];
  /** ISO-8601. */
  joinedAt: string;
}
