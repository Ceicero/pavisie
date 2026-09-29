// Small pieces shared by the creator dashboard's Twitch chat routes (`routes/creator-twitch*.ts`, ARCHITECTURE.md
// §19e) that manage commands, timers and rewards: error codes, level mapping and the reward validation rules (SSRF guard,
// per-action field spec). (Before phase 4 the guild-scoped Discord dashboard routes shared them too.)
import { AppError, SsrfError, ValidationError, assertPublicHttpUrl } from '@pavisie/core';
import {
  Prisma,
  type TwitchChatLevel as PrismaTwitchChatLevel,
  type TwitchRewardActionKind as PrismaTwitchRewardActionKind,
} from '@pavisie/database';
import type { TwitchChatLevelId, TwitchRewardActionKindId } from '@pavisie/types/integrations';

/** Reverse of `TWITCH_CHAT_LEVEL_MAP` (lib/integrations/dto.ts) — input level id -> Prisma enum, for writes. */
export const TWITCH_CHAT_LEVEL_ENUM_MAP: Record<TwitchChatLevelId, PrismaTwitchChatLevel> = {
  everyone: 'EVERYONE',
  subscriber: 'SUBSCRIBER',
  vip: 'VIP',
  moderator: 'MODERATOR',
  broadcaster: 'BROADCASTER',
};

/** True for Prisma's unique-constraint-violation error (P2002) — same check as `community.ts`'s `isUniqueViolation`. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function commandExistsError(name: string): AppError {
  return new AppError(
    'twitch_chat_command_exists',
    `A command named "${name}" already exists for this channel.`,
    { status: 409, expose: true },
  );
}

export function timerExistsError(name: string): AppError {
  return new AppError(
    'twitch_chat_timer_exists',
    `A timer named "${name}" already exists for this channel.`,
    { status: 409, expose: true },
  );
}

/** Reverse of `TWITCH_REWARD_ACTION_MAP` (lib/integrations/dto.ts) — input action id -> Prisma enum, for writes. */
export const TWITCH_REWARD_ACTION_ENUM_MAP: Record<TwitchRewardActionKindId, PrismaTwitchRewardActionKind> = {
  sound: 'SOUND',
  tts: 'TTS',
  chat: 'CHAT',
  discord: 'DISCORD',
};

/** Mirrors `twitch-chat-schemas.ts`'s private `TWITCH_REWARD_ACTION_FIELD_SPEC` (not exported — that file's
 * `superRefine` only ever sees one request body in isolation). On PATCH we additionally need to validate the
 * reward's *resulting* state (existing row merged with the patch), which only the route layer can do, so the
 * same small spec is duplicated here rather than exported purely for the route callers. */
export const REWARD_ACTION_FIELDS = [
  'soundUrl',
  'volume',
  'ttsTemplate',
  'chatTemplate',
  'discordChannelId',
  'discordTemplate',
] as const;
export type RewardActionField = (typeof REWARD_ACTION_FIELDS)[number];
export const REWARD_ACTION_FIELD_SPEC: Record<
  TwitchRewardActionKindId,
  { required: readonly RewardActionField[]; allowed: readonly RewardActionField[] }
> = {
  sound: { required: ['soundUrl'], allowed: ['soundUrl', 'volume'] },
  tts: { required: ['ttsTemplate'], allowed: ['ttsTemplate'] },
  chat: { required: ['chatTemplate'], allowed: ['chatTemplate'] },
  discord: { required: ['discordChannelId', 'discordTemplate'], allowed: ['discordChannelId', 'discordTemplate'] },
};

export function rewardExistsError(title: string): AppError {
  return new AppError(
    'twitch_chat_reward_exists',
    `A reward for "${title}" with that action already exists for this channel.`,
    { status: 409, expose: true },
  );
}

/** Converts an `SsrfError` from `assertPublicHttpUrl` into the same 400 shape as `routes/ai.ts`'s baseUrl check.
 * The zod schema only checks URL shape (https, well-formed) — a live DNS lookup to catch private/internal/metadata
 * targets can only happen here at the route layer. */
export async function assertSafeSoundUrl(url: string): Promise<void> {
  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    throw new ValidationError(err instanceof SsrfError ? err.message : 'That sound URL is not allowed.');
  }
}
