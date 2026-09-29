-- Creator dashboard, phase 1 (ARCHITECTURE.md §19e): a Twitch chat channel no longer requires a linked Discord
-- server, and a Twitch channel can only ever have ONE Pavisie chat-bot config. Matches `prisma migrate diff` output
-- for this schema change (statements are identical; only these comments are added).
--
-- Deploy note: the new UNIQUE index on "broadcasterUserId" fails if two guilds ever linked the SAME broadcaster.
-- The guild link flow (routes/oauth-integrations.ts, `twitch_chat`) has always refused a second guild for a
-- broadcaster, so no such rows are expected — check `SELECT "broadcasterUserId" FROM "TwitchChatChannel" GROUP BY 1
-- HAVING count(*) > 1` before deploying if in doubt.

-- DropIndex (superseded by the global unique on broadcasterUserId below)
DROP INDEX "TwitchChatChannel_guildId_broadcasterUserId_key";

-- AlterTable (existing rows keep their guildId — it now means "the linked Discord server")
ALTER TABLE "TwitchChatChannel" ALTER COLUMN "guildId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "TwitchChatCommand" ALTER COLUMN "guildId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "TwitchChatTimer" ALTER COLUMN "guildId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "TwitchChatChannel_broadcasterUserId_key" ON "TwitchChatChannel"("broadcasterUserId");
