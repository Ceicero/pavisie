import type { AutomodRuleTypeValue } from '@pavisie/types/automod';

/** Human-friendly labels for `AutomodRuleType` — mirrors `packages/plugins/src/automod/commands/rule-labels.ts` (kept in sync by hand; the dashboard doesn't depend on `@pavisie/plugins`). */
export const RULE_TYPE_LABELS: Record<AutomodRuleTypeValue, string> = {
  MESSAGE_FREQUENCY: 'Message frequency (spam)',
  DUPLICATE_MESSAGES: 'Duplicate messages',
  MENTION_SPAM: 'Mention spam',
  INVITE_LINKS: 'Invite links',
  SCAM_LINKS: 'Scam / phishing links',
  REGEX_FILTER: 'Regex filter',
  WORD_FILTER: 'Word filter',
  CAPS: 'Excessive caps',
  REPEATED_CHARS: 'Repeated characters',
  ATTACHMENTS: 'Attachments',
  NSFW_ENFORCEMENT: 'NSFW channel enforcement',
  ACCOUNT_AGE: 'New account age',
  RAID_DETECTION: 'Raid detection',
};
