// Shared zod input schemas for the Twitch chat bot (routes/twitch-chat.ts). Kept in this small module
// rather than inline in the route file — unlike the rest of `routes/integrations.ts` (which declares its
// zod schemas inline per-route) — because the Discord `/twitch` command (packages/plugins/src/integrations/
// commands/twitch.ts) must validate identically to the API and can't import from `apps/api`; keeping these
// isolated here at least gives the routes a single place to import from, and documents the exact rules the
// command implementation has to mirror by hand.
import { z } from 'zod';
import {
  TWITCH_CHAT_LEVELS,
  TWITCH_CHAT_RESERVED_COMMAND_NAMES,
  TWITCH_REWARD_ACTION_KINDS,
  type TwitchRewardActionKindId,
} from '@pavisie/types/integrations';
import { snowflakeSchema } from '../schemas';

/** `/^[a-z0-9_]{1,32}$/`, stored lowercase — shared by command and timer names. */
export const twitchChatNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{1,32}$/, 'Must be 1-32 characters: lowercase letters, numbers, or underscore.');

/** Rejects the built-in command names (`!commands`, `!uptime`, `!title`) every channel already answers. */
export const twitchChatCommandNameSchema = twitchChatNameSchema.refine(
  (name) => !(TWITCH_CHAT_RESERVED_COMMAND_NAMES as readonly string[]).includes(name),
  (name) => ({ message: `"${name}" is a built-in command name and can't be overridden.` }),
);

export const twitchChatResponseSchema = z.string().trim().min(1).max(400);

export const twitchChatCooldownSecondsSchema = z.number().int().min(0).max(3600);

export const twitchChatLevelSchema = z.enum(TWITCH_CHAT_LEVELS);

export const twitchChatIntervalMinutesSchema = z.number().int().min(5).max(1440);

/** Exactly one printable, non-space, non-`/` character (so command matching stays unambiguous). */
export const twitchChatPrefixSchema = z
  .string()
  .length(1, 'Must be exactly one character.')
  .regex(/^[^\s/]$/, 'Must be a single printable character, not a space or "/".');

export const updateTwitchChatChannelSchema = z.object({
  enabled: z.boolean().optional(),
  commandPrefix: twitchChatPrefixSchema.optional(),
});

export const createTwitchChatCommandSchema = z.object({
  name: twitchChatCommandNameSchema,
  response: twitchChatResponseSchema,
  cooldownSeconds: twitchChatCooldownSecondsSchema.optional(),
  minLevel: twitchChatLevelSchema.optional(),
});

export const updateTwitchChatCommandSchema = z.object({
  name: twitchChatCommandNameSchema.optional(),
  response: twitchChatResponseSchema.optional(),
  cooldownSeconds: twitchChatCooldownSecondsSchema.optional(),
  minLevel: twitchChatLevelSchema.optional(),
  enabled: z.boolean().optional(),
});

export const createTwitchChatTimerSchema = z.object({
  name: twitchChatNameSchema,
  message: twitchChatResponseSchema,
  intervalMinutes: twitchChatIntervalMinutesSchema,
});

export const updateTwitchChatTimerSchema = z.object({
  name: twitchChatNameSchema.optional(),
  message: twitchChatResponseSchema.optional(),
  intervalMinutes: twitchChatIntervalMinutesSchema.optional(),
  enabled: z.boolean().optional(),
});

/** Per-channel limits enforced by the routes alongside these schemas (ARCHITECTURE.md §19/§J). */
export const TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL = 50;
export const TWITCH_CHAT_MAX_TIMERS_PER_CHANNEL = 10;

// ---------------------------------------------------------------------------
// Channel-point rewards (channel-points spec v1) — extends the schemas above. Only the payload fields
// matching the chosen `action` are meaningful; `validateRewardActionFields` below enforces both directions:
// the action's required fields must be present, and every other action's fields must be absent.
// ---------------------------------------------------------------------------

export const twitchRewardActionSchema = z.enum(TWITCH_REWARD_ACTION_KINDS);

export const twitchChatRewardTitleSchema = z.string().trim().min(1).max(100);

/** Twitch's own custom reward id, when picked from the "list rewards from Twitch" dropdown rather than typed. */
export const twitchChatRewardIdSchema = z.string().trim().min(1).max(64);

export const twitchChatRewardVolumeSchema = z.number().int().min(0).max(100);

/** Shared by ttsTemplate/chatTemplate/discordTemplate — `{user}`/`{input}`/`{reward}` placeholders are
 * substituted at redemption time (rewards.ts), not validated here. */
export const twitchChatRewardTemplateSchema = z.string().trim().min(1).max(300);

/** https-only, well-formed-URL check. SSRF rejection (private/internal/metadata addresses) needs a live DNS
 * lookup this schema can't perform — that happens at the route layer via `assertPublicHttpUrl`. */
export const twitchChatRewardSoundUrlSchema = z
  .string()
  .trim()
  .url('Must be a valid URL.')
  .refine((url) => url.startsWith('https://'), 'Sound URL must use https.');

const TWITCH_REWARD_ACTION_FIELDS = [
  'soundUrl',
  'volume',
  'ttsTemplate',
  'chatTemplate',
  'discordChannelId',
  'discordTemplate',
] as const;
type TwitchRewardActionField = (typeof TWITCH_REWARD_ACTION_FIELDS)[number];

/** Which of `TWITCH_REWARD_ACTION_FIELDS` each action reads (`allowed`) and must have set (`required`) —
 * single source of truth for both "missing a required field" and "field doesn't belong to this action". */
const TWITCH_REWARD_ACTION_FIELD_SPEC: Record<
  TwitchRewardActionKindId,
  { required: readonly TwitchRewardActionField[]; allowed: readonly TwitchRewardActionField[] }
> = {
  sound: { required: ['soundUrl'], allowed: ['soundUrl', 'volume'] },
  tts: { required: ['ttsTemplate'], allowed: ['ttsTemplate'] },
  chat: { required: ['chatTemplate'], allowed: ['chatTemplate'] },
  discord: { required: ['discordChannelId', 'discordTemplate'], allowed: ['discordChannelId', 'discordTemplate'] },
};

interface RewardActionFieldsInput {
  action?: TwitchRewardActionKindId;
  soundUrl?: string | null;
  volume?: number;
  ttsTemplate?: string | null;
  chatTemplate?: string | null;
  discordChannelId?: string | null;
  discordTemplate?: string | null;
}

/** Cross-field validation shared by create (`action` always present — every required field must be set and
 * every other action's fields must be absent) and update (`action` optional — when the caller isn't changing
 * it, this can't know the reward's *current* action, so both checks are skipped entirely and left to the
 * route layer, which has the existing row to validate against). */
function validateRewardActionFields(data: RewardActionFieldsInput, ctx: z.RefinementCtx, opts: { partial: boolean }): void {
  const action = data.action;
  if (!action) return;
  const spec = TWITCH_REWARD_ACTION_FIELD_SPEC[action];

  for (const field of TWITCH_REWARD_ACTION_FIELDS) {
    if (spec.allowed.includes(field)) continue;
    const value = data[field];
    if (value !== undefined && value !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `"${field}" does not apply to the "${action}" action.`,
      });
    }
  }

  if (opts.partial) return;
  for (const field of spec.required) {
    const value = data[field];
    if (value === undefined || value === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `"${field}" is required for the "${action}" action.`,
      });
    }
  }
}

export const createTwitchChatRewardSchema = z
  .object({
    rewardId: twitchChatRewardIdSchema.nullable().optional(),
    rewardTitle: twitchChatRewardTitleSchema,
    action: twitchRewardActionSchema,
    soundUrl: twitchChatRewardSoundUrlSchema.optional(),
    volume: twitchChatRewardVolumeSchema.optional(),
    ttsTemplate: twitchChatRewardTemplateSchema.optional(),
    chatTemplate: twitchChatRewardTemplateSchema.optional(),
    discordChannelId: snowflakeSchema.optional(),
    discordTemplate: twitchChatRewardTemplateSchema.optional(),
    cooldownSeconds: twitchChatCooldownSecondsSchema.optional(),
  })
  .superRefine((data, ctx) => validateRewardActionFields(data, ctx, { partial: false }));

export const updateTwitchChatRewardSchema = z
  .object({
    rewardId: twitchChatRewardIdSchema.nullable().optional(),
    rewardTitle: twitchChatRewardTitleSchema.optional(),
    enabled: z.boolean().optional(),
    action: twitchRewardActionSchema.optional(),
    soundUrl: twitchChatRewardSoundUrlSchema.optional(),
    volume: twitchChatRewardVolumeSchema.optional(),
    ttsTemplate: twitchChatRewardTemplateSchema.optional(),
    chatTemplate: twitchChatRewardTemplateSchema.optional(),
    discordChannelId: snowflakeSchema.optional(),
    discordTemplate: twitchChatRewardTemplateSchema.optional(),
    cooldownSeconds: twitchChatCooldownSecondsSchema.optional(),
  })
  .superRefine((data, ctx) => validateRewardActionFields(data, ctx, { partial: true }));

/** Per-channel reward cap — mirrored in the dashboard table and `commands/twitch.ts` (channel-points spec v1). */
export const TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL = 25;
