// Automod-specific DTOs not already covered by `AutomodRuleDto`/`AutomodEventDto` in `./api.ts` (those are the
// wiring stage's barrel-exported shapes; this file is a new subpath — import via `@pavisie/types/automod` —
// per this task's ownership: "do NOT edit packages/types/src/index.ts"). Deliberately hand-written (not derived
// from `@pavisie/plugins`'s zod schemas) so `@pavisie/types` keeps its "no runtime deps" contract and its
// place as the most primitive package in the dependency graph.

/** Mirrors `packages/plugins/src/automod/schemas.ts`'s `automodActionTypeSchema` (single source of truth there). */
export type AutomodActionType = 'warn' | 'delete' | 'timeout' | 'quarantine' | 'alert_staff' | 'ignore';

export interface AutomodActionInput {
  type: AutomodActionType;
  /** Only meaningful for `type: 'timeout'`. */
  timeoutMs?: number;
}

/** Mirrors `packages/plugins/src/automod/schemas.ts`'s `AUTOMOD_RULE_TYPES`. */
export type AutomodRuleTypeValue =
  | 'MESSAGE_FREQUENCY'
  | 'DUPLICATE_MESSAGES'
  | 'MENTION_SPAM'
  | 'INVITE_LINKS'
  | 'SCAM_LINKS'
  | 'REGEX_FILTER'
  | 'WORD_FILTER'
  | 'CAPS'
  | 'REPEATED_CHARS'
  | 'ATTACHMENTS'
  | 'NSFW_ENFORCEMENT'
  | 'ACCOUNT_AGE'
  | 'RAID_DETECTION';

/** Request body for `POST/PUT /guilds/:guildId/automod/rules[/:ruleId]` (ARCHITECTURE.md §10). */
export interface AutomodRuleInput {
  name?: string;
  enabled?: boolean;
  dryRun?: boolean;
  /** `{ type: AutomodRuleTypeValue, ...type-specific fields }` — validated server-side against the per-type schema. */
  config?: Record<string, unknown> & { type: AutomodRuleTypeValue };
  actions?: AutomodActionInput[];
  exemptRoleIds?: string[];
  exemptChannelIds?: string[];
  exemptUserIds?: string[];
  trustedDomains?: string[];
  cooldownSeconds?: number;
  priority?: number;
}

/** Response of `POST /guilds/:guildId/automod/rules/:ruleId/test` — runs the rule's evaluator against sample text, no action taken. */
export interface AutomodRuleTestResult {
  matched: boolean;
  reason?: string;
  evidence?: Record<string, string | number | boolean | null>;
}
