-- Creator dashboard, phase 2b (ARCHITECTURE.md §19b / §19e): channel-point rewards, the OBS overlay and
-- bring-your-own-key TTS work for a Twitch channel with NO Discord server. Two things had a Discord guild baked in:
--   1. the broadcaster's own token (scope `channel:read:redemptions`) lived in `OAuthToken`, which hangs off a
--      guild-scoped `IntegrationConnection` — it now lives in "TwitchBroadcasterToken", keyed by the Twitch chat
--      channel;
--   2. `TwitchChatReward.guildId` was required.
-- The channel's own OpenAI key for TTS ("ttsOpenAiKeyEnc") is a new column on the channel row.
--
-- Part 1 (schema) is byte-for-byte what `prisma migrate diff` emits for the schema change; only comments are added.
-- Part 2 (carry-over data move) is hand-written and clearly marked below.

-- =====================================================================================================================
-- PART 1 — SCHEMA (matches `prisma migrate diff`)
-- =====================================================================================================================

-- AlterTable
ALTER TABLE "TwitchChatChannel" ADD COLUMN     "ttsOpenAiKeyEnc" TEXT;

-- AlterTable
ALTER TABLE "TwitchChatReward" ALTER COLUMN "guildId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "TwitchBroadcasterToken" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "status" "ConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwitchBroadcasterToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwitchBroadcasterToken_channelId_key" ON "TwitchBroadcasterToken"("channelId");

-- AddForeignKey
ALTER TABLE "TwitchBroadcasterToken" ADD CONSTRAINT "TwitchBroadcasterToken_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TwitchChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================================================
-- PART 2 — CARRY-OVER DATA MOVE (hand-written; not produced by `prisma migrate diff`)
-- =====================================================================================================================
-- Existing guild-linked channels already have a working broadcaster token (channel-point rewards shipped before the
-- creator dashboard), stored in the channel's `OAuthToken` row (via TwitchChatChannel."connectionId"). Those streamers
-- must NOT have to re-authorize, so each such token is MOVED — copied verbatim (still encrypted; this migration never
-- decrypts anything), then deleted from "OAuthToken".
--
-- Why MOVE and not COPY: Twitch rotates the refresh token on every use. If the old row stayed behind, a bot process
-- still running the previous build during a rolling deploy could refresh it, rotate the refresh token at Twitch, and
-- leave the copy in "TwitchBroadcasterToken" holding a dead refresh token — the streamer would then have to
-- re-authorize. With the old row gone, only the new code can ever spend the refresh token. During the few seconds
-- between this migration and the new bot starting, the old bot simply finds no token and reports "re-link needed"
-- for that channel; the new bot's first reconcile tick restores the rewards subscription and clears the message.
--
-- Only tokens that actually carry `channel:read:redemptions` are moved (a `channel:bot`-only token is useless for
-- rewards, so it is left where it is). Only tokens of a Twitch chat channel are touched (the join on
-- "TwitchChatChannel"."connectionId"); every other integration's OAuthToken is left alone.
-- Rollback note: redeploying the previous build after this migration means channels must re-link once, because the
-- old code reads "OAuthToken", which no longer holds these rows.

INSERT INTO "TwitchBroadcasterToken" (
    "id", "channelId", "accessTokenEnc", "refreshTokenEnc", "scopes", "expiresAt", "rotatedAt", "createdAt", "updatedAt"
) SELECT
    'tbt_' || c."id",
    c."id",
    o."accessTokenEnc",
    o."refreshTokenEnc",
    o."scopes",
    o."expiresAt",
    o."rotatedAt",
    o."createdAt",
    o."updatedAt"
FROM "TwitchChatChannel" c
JOIN "OAuthToken" o ON o."connectionId" = c."connectionId"
WHERE c."connectionId" IS NOT NULL
  AND 'channel:read:redemptions' = ANY (o."scopes");

DELETE FROM "OAuthToken" o
USING "TwitchChatChannel" c
WHERE o."connectionId" = c."connectionId"
  AND c."connectionId" IS NOT NULL
  AND 'channel:read:redemptions' = ANY (o."scopes");
