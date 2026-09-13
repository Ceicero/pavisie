// Single source of truth: packages/plugins/src/community/tag-schemas.ts — a discord.js-free module (only zod +
// @pavisie/core), so the API can import it directly the same way `../automod-schemas.ts` re-exports
// `@pavisie/plugins/automod/schemas`. Keeps `/tag create|edit` (bot) and the dashboard tags API validating
// identically without duplicating the schema.
export {
  TAG_NAME_RE,
  TAG_NAME_MAX,
  TAG_CONTENT_MAX,
  TAG_TRIGGER_MIN,
  TAG_TRIGGER_MAX,
  TAG_TRIGGER_MODES,
  tagBodySchema,
  tagEmbedSchema,
  tagTriggerModeSchema,
  tagTriggersCacheKey,
  isTagEmbedEmpty,
  normalizeTagName,
  type TagBody,
  type TagBodyInput,
  type TagEmbedInput,
  type TagTriggerModeValue,
} from '@pavisie/plugins/community/tag-schemas';
