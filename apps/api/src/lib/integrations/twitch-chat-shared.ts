// Small pieces shared by the two route trees that manage Twitch chat commands/timers: the guild-scoped Discord
// dashboard routes (`routes/twitch-chat.ts`) and the creator dashboard routes (`routes/creator-twitch.ts`,
// ARCHITECTURE.md §19e). Kept here so the two can never drift apart on error codes or level mapping.
import { AppError } from '@pavisie/core';
import { Prisma, type TwitchChatLevel as PrismaTwitchChatLevel } from '@pavisie/database';
import type { TwitchChatLevelId } from '@pavisie/types/integrations';

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
