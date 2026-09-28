-- AlterTable
ALTER TABLE "TwitchChatChannel" ADD COLUMN     "bridgeDiscordChannelId" TEXT,
ADD COLUMN     "bridgeDiscordToTwitch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bridgeTwitchToDiscord" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bridgeWebhookId" TEXT,
ADD COLUMN     "bridgeWebhookTokenEnc" TEXT,
ADD COLUMN     "bridgeLastError" TEXT;

-- CreateIndex
CREATE INDEX "TwitchChatChannel_guildId_bridgeDiscordChannelId_idx" ON "TwitchChatChannel"("guildId", "bridgeDiscordChannelId");
