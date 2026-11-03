-- Removes the `gamestats` plugin and the Steam integration connector (2026-11-03).
--
-- DATA DELETION: this permanently deletes every member's linked SteamID64, cached Steam persona name and
-- curated stat snapshot, every Steam app-news alert watch, and the plugin's per-guild enable/config rows.
-- It cannot be undone except by restoring a database backup taken before it ran.

-- DropForeignKey
ALTER TABLE "GameAccountLink" DROP CONSTRAINT "GameAccountLink_guildId_fkey";

-- DropForeignKey
ALTER TABLE "GameStatSnapshot" DROP CONSTRAINT "GameStatSnapshot_guildId_fkey";

-- DropTable
DROP TABLE "GameAccountLink";

-- DropTable
DROP TABLE "GameStatSnapshot";

-- DropEnum
DROP TYPE "GameAccountProvider";

-- Steam alert watches. The STEAM value stays in "IntegrationProvider" (like GITHUB/NOTION/STRIPE) so the shared
-- enum isn't rebuilt. Steam watches never have an OAuthToken or TwitchChatChannel row; both would cascade anyway.
DELETE FROM "IntegrationConnection" WHERE "provider" = 'STEAM';

-- Leftover per-guild plugin rows for the removed plugin.
DELETE FROM "PluginState" WHERE "pluginId" = 'gamestats';
DELETE FROM "PluginConfig" WHERE "pluginId" = 'gamestats';
DELETE FROM "ScheduledJob" WHERE "pluginId" = 'gamestats';
