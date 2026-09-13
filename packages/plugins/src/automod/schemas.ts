import { z } from 'zod';
import { validateUserRegex } from '@pavisie/core';

/** Per-rule action taken when a rule matches (SPEC.md §C: "warn, delete, timeout, quarantine, alert staff, or ignore"). */
export const automodActionTypeSchema = z.enum([
  'warn',
  'delete',
  'timeout',
  'quarantine',
  'alert_staff',
  'ignore',
]);
export type AutomodActionType = z.infer<typeof automodActionTypeSchema>;

export const automodActionSchema = z.object({
  type: automodActionTypeSchema,
  /** Only meaningful for `type: 'timeout'`. Falls back to the guild's `defaultTimeoutMs` when omitted. */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(28 * 24 * 60 * 60 * 1000)
    .optional(),
});
export type AutomodAction = z.infer<typeof automodActionSchema>;

/** `AutomodRule.actions` — an ordered list of actions to take on match, applied in order. */
export const automodActionsSchema = z.array(automodActionSchema).min(1).max(6);

// ---------------------------------------------------------------------------
// One config schema per AutomodRuleType (prisma schema.prisma `AutomodRuleType`).
// This is the single source of truth (ARCHITECTURE.md §7's plugin SDK contract, TASK: "export them from the
// plugin's index.ts as 'automodRuleSchemas'"); apps/api/src/lib/automod-schemas.ts re-exports from here.
// ---------------------------------------------------------------------------

export const messageFrequencyConfigSchema = z.object({
  type: z.literal('MESSAGE_FREQUENCY'),
  maxMessages: z.number().int().min(1).max(50).default(5),
  windowSeconds: z.number().int().min(1).max(300).default(10),
});

export const duplicateMessagesConfigSchema = z.object({
  type: z.literal('DUPLICATE_MESSAGES'),
  maxDuplicates: z.number().int().min(2).max(20).default(3),
  windowSeconds: z.number().int().min(1).max(600).default(60),
});

export const mentionSpamConfigSchema = z.object({
  type: z.literal('MENTION_SPAM'),
  maxMentions: z.number().int().min(1).max(50).default(5),
  includeRoleMentions: z.boolean().default(true),
});

export const inviteLinksConfigSchema = z.object({
  type: z.literal('INVITE_LINKS'),
  allowOwnServerInvites: z.boolean().default(true),
  allowedInviteCodes: z.array(z.string().min(1).max(32)).max(100).default([]),
});

export const scamLinksConfigSchema = z.object({
  type: z.literal('SCAM_LINKS'),
  useBuiltInList: z.boolean().default(true),
  blockedDomains: z.array(z.string().min(1).max(253)).max(500).default([]),
});

export const regexFilterConfigSchema = z.object({
  type: z.literal('REGEX_FILTER'),
  pattern: z.string().min(1).max(256),
  flags: z.string().max(5).default('i'),
});

export const wordFilterConfigSchema = z.object({
  type: z.literal('WORD_FILTER'),
  words: z.array(z.string().min(1).max(64)).min(1).max(500),
  wholeWord: z.boolean().default(true),
  caseSensitive: z.boolean().default(false),
});

export const capsConfigSchema = z.object({
  type: z.literal('CAPS'),
  minLength: z.number().int().min(1).max(2000).default(10),
  maxCapsPercent: z.number().min(1).max(100).default(70),
});

export const repeatedCharsConfigSchema = z.object({
  type: z.literal('REPEATED_CHARS'),
  maxRepeats: z.number().int().min(2).max(50).default(6),
});

export const attachmentsConfigSchema = z.object({
  type: z.literal('ATTACHMENTS'),
  blockedExtensions: z
    .array(z.string().min(1).max(10))
    .max(100)
    .default(['exe', 'bat', 'scr', 'msi', 'jar', 'cmd']),
  maxAttachments: z.number().int().min(0).max(20).optional(),
});

export const nsfwEnforcementConfigSchema = z.object({
  type: z.literal('NSFW_ENFORCEMENT'),
  requireNsfwChannelForKeywords: z.array(z.string().min(1).max(64)).max(200).default([]),
});

export const accountAgeConfigSchema = z.object({
  type: z.literal('ACCOUNT_AGE'),
  minAccountAgeHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 365)
    .default(24),
});

export const raidDetectionConfigSchema = z.object({
  type: z.literal('RAID_DETECTION'),
  joinBurstCount: z.number().int().min(2).max(200).default(10),
  joinBurstWindowSeconds: z.number().int().min(1).max(3600).default(30),
});

/** Discriminated union over `AutomodRuleType`, validating a rule's `config` Json against its declared `type`. */
export const automodRuleConfigSchema = z
  .discriminatedUnion('type', [
    messageFrequencyConfigSchema,
    duplicateMessagesConfigSchema,
    mentionSpamConfigSchema,
    inviteLinksConfigSchema,
    scamLinksConfigSchema,
    regexFilterConfigSchema,
    wordFilterConfigSchema,
    capsConfigSchema,
    repeatedCharsConfigSchema,
    attachmentsConfigSchema,
    nsfwEnforcementConfigSchema,
    accountAgeConfigSchema,
    raidDetectionConfigSchema,
  ])
  // Applied after the union (rather than wrapping regexFilterConfigSchema in its own .superRefine) because
  // z.discriminatedUnion requires every member to be a plain ZodObject exposing `.shape`, which a
  // ZodEffects-wrapped member is not.
  .superRefine((value, ctx) => {
    if (value.type !== 'REGEX_FILTER') return;
    const result = validateUserRegex(value.pattern, value.flags);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pattern'],
        message: result.error ?? 'Unsafe pattern.',
      });
    }
  });

export type AutomodRuleConfig = z.infer<typeof automodRuleConfigSchema>;

/** Every `AutomodRuleType` value, in the order they're offered in `/automod rule create`'s type choice. */
export const AUTOMOD_RULE_TYPES = [
  'MESSAGE_FREQUENCY',
  'DUPLICATE_MESSAGES',
  'MENTION_SPAM',
  'INVITE_LINKS',
  'SCAM_LINKS',
  'REGEX_FILTER',
  'WORD_FILTER',
  'CAPS',
  'REPEATED_CHARS',
  'ATTACHMENTS',
  'NSFW_ENFORCEMENT',
  'ACCOUNT_AGE',
  'RAID_DETECTION',
] as const;

export type AutomodRuleTypeValue = (typeof AUTOMOD_RULE_TYPES)[number];

/** Rule types whose evaluator needs the Message Content privileged intent (TASK spec; ARCHITECTURE.md §7.1's `intentsEnabled`). */
export const CONTENT_DEPENDENT_RULE_TYPES: ReadonlySet<AutomodRuleTypeValue> = new Set([
  'DUPLICATE_MESSAGES',
  'INVITE_LINKS',
  'SCAM_LINKS',
  'REGEX_FILTER',
  'WORD_FILTER',
  'CAPS',
  'REPEATED_CHARS',
  'ATTACHMENTS',
]);

/** Rule types whose evaluator needs the Guild Members privileged intent (for join events / account age). */
export const MEMBER_DEPENDENT_RULE_TYPES: ReadonlySet<AutomodRuleTypeValue> = new Set([
  'ACCOUNT_AGE',
  'RAID_DETECTION',
]);

/** Per-rule-type config schema map, keyed by `AutomodRuleType` — used to build/parse the create/edit modals. */
export const automodRuleConfigSchemaByType = {
  MESSAGE_FREQUENCY: messageFrequencyConfigSchema,
  DUPLICATE_MESSAGES: duplicateMessagesConfigSchema,
  MENTION_SPAM: mentionSpamConfigSchema,
  INVITE_LINKS: inviteLinksConfigSchema,
  SCAM_LINKS: scamLinksConfigSchema,
  REGEX_FILTER: regexFilterConfigSchema,
  WORD_FILTER: wordFilterConfigSchema,
  CAPS: capsConfigSchema,
  REPEATED_CHARS: repeatedCharsConfigSchema,
  ATTACHMENTS: attachmentsConfigSchema,
  NSFW_ENFORCEMENT: nsfwEnforcementConfigSchema,
  ACCOUNT_AGE: accountAgeConfigSchema,
  RAID_DETECTION: raidDetectionConfigSchema,
} as const satisfies Record<AutomodRuleTypeValue, z.ZodTypeAny>;
