// Single source of truth: packages/plugins/src/automod/schemas.ts (TASK: "export them from the plugin's
// index.ts as 'automodRuleSchemas' ... then make apps/api/src/lib/automod-schemas.ts re-export from
// '@pavisie/plugins' so there is one source of truth"). This file exists only so existing imports of
// '../lib/automod-schemas' inside apps/api keep working without touching every call site.
export {
  automodActionTypeSchema,
  automodActionSchema,
  automodActionsSchema,
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
  automodRuleConfigSchema,
  automodRuleConfigSchemaByType,
  AUTOMOD_RULE_TYPES,
  CONTENT_DEPENDENT_RULE_TYPES,
  MEMBER_DEPENDENT_RULE_TYPES,
  type AutomodActionType,
  type AutomodAction,
  type AutomodRuleConfig,
  type AutomodRuleTypeValue,
} from '@pavisie/plugins/automod/schemas';
