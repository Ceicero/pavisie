-- CreateTable
CREATE TABLE "TwitchAccountLink" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "twitchUserId" TEXT NOT NULL,
    "twitchLogin" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwitchAccountLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwitchAccountLink_discordUserId_key" ON "TwitchAccountLink"("discordUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TwitchAccountLink_twitchUserId_key" ON "TwitchAccountLink"("twitchUserId");
