import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { findDiscordUserIdForTwitch } from '../src/twitch-link';

/** Minimal fake covering only the one delegate method this helper calls. */
function fakePrisma(rows: { discordUserId: string; twitchUserId: string }[]): PrismaClient {
  return {
    twitchAccountLink: {
      findUnique: async ({ where }: { where: { twitchUserId: string } }) => {
        const row = rows.find((r) => r.twitchUserId === where.twitchUserId);
        return row ? { discordUserId: row.discordUserId } : null;
      },
    },
  } as unknown as PrismaClient;
}

describe('findDiscordUserIdForTwitch', () => {
  it('returns the linked discordUserId for a known twitchUserId', async () => {
    const prisma = fakePrisma([{ discordUserId: '111111111111111111', twitchUserId: 'twitch-abc' }]);
    await expect(findDiscordUserIdForTwitch(prisma, 'twitch-abc')).resolves.toBe('111111111111111111');
  });

  it('returns null when the Twitch account has no link on file', async () => {
    const prisma = fakePrisma([]);
    await expect(findDiscordUserIdForTwitch(prisma, 'twitch-unknown')).resolves.toBeNull();
  });
});
