// Pure tag validation + trigger matching (spec CG-02). Deliberately free of discord.js so the API can import
// it via `@pavisie/plugins/community/tag-schemas` (same pattern as `apps/api/src/lib/automod-schemas.ts`
// re-exporting `automod/schemas`) — one source of truth for the body schema on both bot and dashboard sides.
import { z } from 'zod';
import { EMBED_LIMITS, redisKey } from '@pavisie/core';

/** Redis key holding a guild's cached trigger-tag list (bot reads; bot + API DEL on every tag write). */
export function tagTriggersCacheKey(guildId: string): string {
  return redisKey('community', 'tag-triggers', guildId);
}

/** Redis key for the per-(guild, tag) auto-responder cooldown (`SET NX EX`). */
export function tagTriggerCooldownKey(guildId: string, tagId: string): string {
  return redisKey('community', 'tag-cd', guildId, tagId);
}

/** Tag names: 1..32 chars, lowercase `[a-z0-9]` first, then `[a-z0-9_-]`. */
export const TAG_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const TAG_NAME_MAX = 32;
export const TAG_CONTENT_MAX = 2000;
export const TAG_TRIGGER_MIN = 2;
export const TAG_TRIGGER_MAX = 100;
/** Incoming messages are truncated to this many chars before trigger matching (bounded regex work). */
export const TAG_MATCH_INPUT_MAX = 2000;

export const TAG_TRIGGER_MODES = ['NONE', 'EXACT', 'CONTAINS', 'STARTS_WITH'] as const;
export type TagTriggerModeValue = (typeof TAG_TRIGGER_MODES)[number];
export const tagTriggerModeSchema = z.enum(TAG_TRIGGER_MODES);

/** Trim + lowercase a raw name as typed by a user (validation happens separately against `TAG_NAME_RE`). */
export function normalizeTagName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True when `name` (already normalized) is a valid tag name. */
export function isValidTagName(name: string): boolean {
  return TAG_NAME_RE.test(name);
}

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : undefined));

/** Flat embed payload — the same shape `/embed builder` uses (`utility/embed-payload.ts` `EmbedBuilderPayload`). */
export const tagEmbedSchema = z
  .object({
    title: optionalTrimmed(EMBED_LIMITS.title),
    description: optionalTrimmed(EMBED_LIMITS.description),
    colorHex: z
      .string()
      .trim()
      .regex(/^#?[0-9a-fA-F]{6}$/, 'Color must be a hex code like #5865F2.')
      .optional()
      .nullable()
      .transform((v) => (v ? v : undefined)),
    imageUrl: z
      .string()
      .trim()
      .url()
      .max(2048)
      .refine((u) => /^https?:\/\//i.test(u), 'Image URL must be http(s).')
      .optional()
      .nullable()
      .transform((v) => (v ? v : undefined)),
    footer: optionalTrimmed(EMBED_LIMITS.footer),
  })
  .strict();

export type TagEmbedInput = z.infer<typeof tagEmbedSchema>;

/** True when the embed has nothing renderable (title/description/image/footer all empty). */
export function isTagEmbedEmpty(embed: TagEmbedInput | null | undefined): boolean {
  if (!embed) return true;
  return !embed.title && !embed.description && !embed.imageUrl && !embed.footer;
}

/**
 * Body schema shared by `/tag create|edit` (bot) and `POST/PUT /guilds/:guildId/community/tags` (API).
 * Refinements: name matches `TAG_NAME_RE`; at least one of content/embed is non-empty; `trigger` is required
 * iff `triggerMode !== 'NONE'`.
 */
export const tagBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(TAG_NAME_MAX)
      .transform(normalizeTagName)
      .refine(isValidTagName, {
        message: `Tag names are 1-${TAG_NAME_MAX} lowercase letters, numbers, "-" or "_".`,
      }),
    content: z
      .string()
      .max(TAG_CONTENT_MAX)
      .optional()
      .nullable()
      .transform((v) => (v && v.trim().length > 0 ? v : undefined)),
    embed: tagEmbedSchema
      .optional()
      .nullable()
      .transform((v) => (v ? v : undefined)),
    triggerMode: tagTriggerModeSchema.default('NONE'),
    trigger: z
      .string()
      .trim()
      .max(TAG_TRIGGER_MAX)
      .optional()
      .nullable()
      .transform((v) => (v ? v : undefined)),
    triggerChannelIds: z
      .array(z.string().regex(/^\d{5,25}$/))
      .max(50)
      .default([]),
    staffOnly: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (!value.content && isTagEmbedEmpty(value.embed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'A tag needs some content or a non-empty embed.',
      });
    }
    if (value.triggerMode !== 'NONE') {
      if (!value.trigger) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['trigger'],
          message: 'A trigger phrase is required when a trigger mode is set.',
        });
      } else if (value.trigger.length < TAG_TRIGGER_MIN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['trigger'],
          message: `Trigger phrases must be at least ${TAG_TRIGGER_MIN} characters.`,
        });
      }
      // Staff-only tags must never auto-respond publicly (bot messageCreate handler + tag-cache loader both
      // also refuse to trigger them; this is the single validation choke point for every writer: the API,
      // the dashboard form, and `/tag trigger` all reach this schema or replicate this exact rule).
      if (value.staffOnly) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['triggerMode'],
          message: 'Staff-only tags cannot be auto-responders.',
        });
      }
    }
  });

export type TagBodyInput = z.input<typeof tagBodySchema>;
export type TagBody = z.output<typeof tagBodySchema>;

export interface TagTriggerLike {
  triggerMode: TagTriggerModeValue;
  trigger: string | null | undefined;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure trigger matcher used by the `messageCreate` auto-responder:
 * - `EXACT`: whole message equals the trigger (case-insensitive, trimmed).
 * - `CONTAINS`: message contains the trigger as a whole word/phrase (case-insensitive; regex specials escaped).
 * - `STARTS_WITH`: lowercased message starts with the trigger and the next char is the end or a non-word char.
 * Input is truncated to `TAG_MATCH_INPUT_MAX` chars first so matching work is bounded regardless of message size.
 */
export function matchesTrigger(content: string, tag: TagTriggerLike): boolean {
  if (tag.triggerMode === 'NONE' || !tag.trigger) return false;
  const trigger = tag.trigger.trim().toLowerCase();
  if (trigger.length === 0) return false;
  const text = content.slice(0, TAG_MATCH_INPUT_MAX).trim().toLowerCase();
  if (text.length === 0) return false;

  if (tag.triggerMode === 'EXACT') {
    return text === trigger;
  }
  if (tag.triggerMode === 'STARTS_WITH') {
    if (!text.startsWith(trigger)) return false;
    const next = text.charAt(trigger.length);
    return next === '' || !/\w/.test(next);
  }
  // CONTAINS — whole-word/phrase boundary on both sides. `\b` alone misbehaves when the trigger starts or ends
  // with a non-word char (e.g. "c++"), so use explicit "start-or-non-word" / "end-or-non-word" lookarounds.
  const pattern = new RegExp(`(?:^|\\W)${escapeRegex(trigger)}(?=$|\\W)`, 'i');
  return pattern.test(text);
}
