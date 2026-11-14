// Risk scoring for a join. Pure, cheap, and built only from what Discord already gives the bot about the member at
// join time. Nothing here is stored except, for medium/high scores during a raid, the member id, the score, and the
// reason codes below.
//
// "Alt" signals are heuristics about one account. Raid mode never links accounts to each other.

export type RiskReason =
  | 'discord_spammer_flag'
  | 'account_age_lt_1h'
  | 'account_age_lt_1d'
  | 'account_age_lt_7d'
  | 'default_avatar'
  | 'numbered_username';

export type RiskLevel = 'low' | 'medium' | 'high';

const WEIGHTS: Record<RiskReason, number> = {
  discord_spammer_flag: 60,
  account_age_lt_1h: 45,
  account_age_lt_1d: 30,
  account_age_lt_7d: 15,
  default_avatar: 15,
  numbered_username: 10,
};

export const MEDIUM_RISK_SCORE = 30;
export const HIGH_RISK_SCORE = 60;

/** The only facts about a member the scorer reads. */
export interface JoinFacts {
  accountCreatedAt: Date;
  joinedAt: Date;
  hasCustomAvatar: boolean;
  username: string;
  /** Discord's own "likely spammer" user flag. */
  flaggedSpammer: boolean;
}

export interface RiskScore {
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
}

const HOUR = 3_600_000;

export function scoreJoin(facts: JoinFacts): RiskScore {
  const reasons: RiskReason[] = [];
  if (facts.flaggedSpammer) reasons.push('discord_spammer_flag');

  const ageMs = facts.joinedAt.getTime() - facts.accountCreatedAt.getTime();
  if (ageMs < HOUR) reasons.push('account_age_lt_1h');
  else if (ageMs < 24 * HOUR) reasons.push('account_age_lt_1d');
  else if (ageMs < 7 * 24 * HOUR) reasons.push('account_age_lt_7d');

  if (!facts.hasCustomAvatar) reasons.push('default_avatar');
  // Bulk-made accounts often share a base name with a run of digits ("user48213"). Only the shape is checked;
  // the name itself is never stored.
  if (/\d{4,}$/.test(facts.username)) reasons.push('numbered_username');

  const score = Math.min(
    100,
    reasons.reduce((sum, reason) => sum + WEIGHTS[reason], 0),
  );
  const level: RiskLevel = score >= HIGH_RISK_SCORE ? 'high' : score >= MEDIUM_RISK_SCORE ? 'medium' : 'low';
  return { score, level, reasons };
}
