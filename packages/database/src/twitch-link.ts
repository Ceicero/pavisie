import type { PrismaClient } from '@prisma/client';

/**
 * Looks up the Discord user id that owns a verified Twitch account, via `TwitchAccountLink`
 * (ARCHITECTURE.md §19d). Returns `null` when that Twitch account has no link on file.
 *
 * Read-only helper for future bot-side use (letting a Twitch chat viewer use/earn their Pavisie
 * economy balance from chat) — nothing calls this yet; it's added ahead of that work so the lookup
 * shape is settled alongside the table itself.
 */
export async function findDiscordUserIdForTwitch(
  prisma: PrismaClient,
  twitchUserId: string,
): Promise<string | null> {
  const link = await prisma.twitchAccountLink.findUnique({
    where: { twitchUserId },
    select: { discordUserId: true },
  });
  return link?.discordUserId ?? null;
}
