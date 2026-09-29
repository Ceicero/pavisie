-- Creator dashboard, phase 2a (ARCHITECTURE.md §18b / §19e): a streamer's Twitch currency is OWNED BY THE TWITCH
-- CHANNEL (ChannelEconomy / ChannelWallet / ChannelTransaction), configured on the creator dashboard, and works with
-- no Discord server. Wallets stay per-platform and are never merged with Discord wallets.
--
-- Part 1 (schema) is byte-for-byte what `prisma migrate diff` emits for the schema change; only comments are added.
-- Part 2 (carry-over data copy) is hand-written and clearly marked below.
--
-- Rollback / cleanup note: the OLD rows (EconomyAccount / EconomyTransaction with platform = 'TWITCH', and the
-- guild economy plugin's twitch* config keys) are deliberately NOT modified or deleted. They become unused once the
-- new code runs and are dropped in a later phase (creator dashboard phase 4), so this migration can be rolled back
-- by simply redeploying the previous build.

-- =====================================================================================================================
-- PART 1 — SCHEMA (matches `prisma migrate diff`)
-- =====================================================================================================================

-- CreateEnum
CREATE TYPE "StreamPlatform" AS ENUM ('TWITCH');

-- CreateTable
CREATE TABLE "ChannelEconomy" (
    "id" TEXT NOT NULL,
    "platform" "StreamPlatform" NOT NULL,
    "channelUserId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "currencyName" TEXT NOT NULL DEFAULT 'Agis',
    "currencySymbol" TEXT NOT NULL DEFAULT '♦️',
    "dailyMinAmount" INTEGER NOT NULL DEFAULT 50,
    "dailyMaxAmount" INTEGER NOT NULL DEFAULT 150,
    "streakBonusPerDay" INTEGER NOT NULL DEFAULT 10,
    "streakBonusMax" INTEGER NOT NULL DEFAULT 200,
    "giveMinAmount" INTEGER NOT NULL DEFAULT 1,
    "giveMaxAmount" INTEGER NOT NULL DEFAULT 100000,
    "earnEnabled" BOOLEAN NOT NULL DEFAULT false,
    "earnPerMessage" INTEGER NOT NULL DEFAULT 5,
    "earnCooldownSeconds" INTEGER NOT NULL DEFAULT 60,
    "earnDailyCap" INTEGER NOT NULL DEFAULT 200,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelEconomy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelWallet" (
    "id" TEXT NOT NULL,
    "economyId" TEXT NOT NULL,
    "viewerUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "lastDailyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelTransaction" (
    "id" TEXT NOT NULL,
    "economyId" TEXT NOT NULL,
    "walletId" TEXT,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "amount" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelEconomy_platform_channelUserId_key" ON "ChannelEconomy"("platform", "channelUserId");

-- CreateIndex
CREATE INDEX "ChannelWallet_economyId_balance_idx" ON "ChannelWallet"("economyId", "balance");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelWallet_economyId_viewerUserId_key" ON "ChannelWallet"("economyId", "viewerUserId");

-- CreateIndex
CREATE INDEX "ChannelTransaction_economyId_createdAt_idx" ON "ChannelTransaction"("economyId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelTransaction_economyId_type_idx" ON "ChannelTransaction"("economyId", "type");

-- CreateIndex
CREATE INDEX "ChannelTransaction_walletId_idx" ON "ChannelTransaction"("walletId");

-- AddForeignKey
ALTER TABLE "ChannelWallet" ADD CONSTRAINT "ChannelWallet_economyId_fkey" FOREIGN KEY ("economyId") REFERENCES "ChannelEconomy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelTransaction" ADD CONSTRAINT "ChannelTransaction_economyId_fkey" FOREIGN KEY ("economyId") REFERENCES "ChannelEconomy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelTransaction" ADD CONSTRAINT "ChannelTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "ChannelWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =====================================================================================================================
-- PART 2 — CARRY-OVER DATA COPY (hand-written; not produced by `prisma migrate diff`).
--
-- For every TwitchChatChannel that is linked to a Discord server (guildId IS NOT NULL) — guildless channels never had
-- a wallet — copy that guild's Twitch currency into the channel's own economy:
--   1. ChannelEconomy  <- the guild's stored `economy` plugin config (PluginConfig.config, jsonb): currencyName,
--                         currencySymbol, dailyMin/MaxAmount, streakBonusPerDay/Max, giveMin/MaxAmount and the
--                         twitchEarn* settings. Any key that is absent (only what was ever written is stored;
--                         defaults are applied at read time) or has the wrong JSON type falls back to the plugin's
--                         default; numbers are clamped to the same bounds the plugin's zod schema enforces.
--                         enabled = the guild's `twitchEnabled` AND the economy plugin being enabled for the guild
--                         (PluginState.enabled; no row means the plugin's default, which is disabled).
--   2. ChannelWallet   <- every EconomyAccount(platform = 'TWITCH', guildId = that guild), balance / lastDailyAt /
--                         displayName / timestamps copied exactly.
--   3. ChannelTransaction <- every EconomyTransaction(platform = 'TWITCH', guildId = that guild), amount / type / note /
--                         from-to ids / createdAt copied exactly; accountId is remapped to the copied wallet.
--
-- Ids are deterministic ('ce_<channelRowId>', 'cw_<channelRowId>_<accountId>', 'ct_<channelRowId>_<txId>') so each
-- copied row is traceable to its source, and no extension (pgcrypto / gen_random_uuid) is needed.
--
-- If one guild ever linked SEVERAL broadcasters (the pre-0014 unique key allowed it), the guild's pooled Twitch
-- wallets are copied into EACH channel's economy: nobody loses currency; the cost is that the pooled balance now
-- exists once per channel (virtual currency, no real-money value). Single-channel guilds — the expected case — are
-- copied exactly once.
--
-- The old rows are left untouched (see the note at the top).
-- =====================================================================================================================

-- 2.1 ChannelEconomy: one per guild-linked channel, settings taken from the guild's economy plugin config.
INSERT INTO "ChannelEconomy" (
    "id", "platform", "channelUserId", "enabled",
    "currencyName", "currencySymbol",
    "dailyMinAmount", "dailyMaxAmount", "streakBonusPerDay", "streakBonusMax", "giveMinAmount", "giveMaxAmount",
    "earnEnabled", "earnPerMessage", "earnCooldownSeconds", "earnDailyCap",
    "createdAt", "updatedAt"
)
SELECT
    'ce_' || c."id",
    'TWITCH'::"StreamPlatform",
    c."broadcasterUserId",
    COALESCE(pc."config" -> 'twitchEnabled' = 'true'::jsonb, false) AND COALESCE(ps."enabled", false),
    CASE WHEN jsonb_typeof(pc."config" -> 'currencyName') = 'string' AND btrim(pc."config" ->> 'currencyName') <> ''
         THEN left(btrim(pc."config" ->> 'currencyName'), 32) ELSE 'Agis' END,
    CASE WHEN jsonb_typeof(pc."config" -> 'currencySymbol') = 'string' AND btrim(pc."config" ->> 'currencySymbol') <> ''
         THEN left(btrim(pc."config" ->> 'currencySymbol'), 8) ELSE '♦️' END,
    CASE WHEN jsonb_typeof(pc."config" -> 'dailyMinAmount') = 'number'
         THEN LEAST(GREATEST(round((pc."config" ->> 'dailyMinAmount')::numeric), 0), 1000000)::int ELSE 50 END,
    CASE WHEN jsonb_typeof(pc."config" -> 'dailyMaxAmount') = 'number'
         THEN LEAST(GREATEST(round((pc."config" ->> 'dailyMaxAmount')::numeric), 0), 1000000)::int ELSE 150 END,
    CASE WHEN jsonb_typeof(pc."config" -> 'streakBonusPerDay') = 'number'
         THEN LEAST(GREATEST(round((pc."config" ->> 'streakBonusPerDay')::numeric), 0), 10000)::int ELSE 10 END,
    CASE WHEN jsonb_typeof(pc."config" -> 'streakBonusMax') = 'number'
         THEN LEAST(GREATEST(round((pc."config" ->> 'streakBonusMax')::numeric), 0), 1000000)::int ELSE 200 END,
    CASE WHEN jsonb_typeof(pc."config" -> 'giveMinAmount') = 'number'
         THEN LEAST(GREATEST(round((pc."config" ->> 'giveMinAmount')::numeric), 1), 1000000000)::int ELSE 1 END,
    CASE WHEN jsonb_typeof(pc."config" -> 'giveMaxAmount') = 'number'
         THEN LEAST(GREATEST(round((pc."config" ->> 'giveMaxAmount')::numeric), 1), 1000000000)::int ELSE 100000 END,
    COALESCE(pc."config" -> 'twitchEarnEnabled' = 'true'::jsonb, false),
    CASE WHEN jsonb_typeof(pc."config" -> 'twitchEarnPerMessage') = 'number'
         THEN LEAST(GREATEST(round((pc."config" ->> 'twitchEarnPerMessage')::numeric), 1), 1000)::int ELSE 5 END,
    CASE WHEN jsonb_typeof(pc."config" -> 'twitchEarnCooldownSeconds') = 'number'
         THEN LEAST(GREATEST(round((pc."config" ->> 'twitchEarnCooldownSeconds')::numeric), 10), 3600)::int ELSE 60 END,
    CASE WHEN jsonb_typeof(pc."config" -> 'twitchEarnDailyCap') = 'number'
         THEN LEAST(GREATEST(round((pc."config" ->> 'twitchEarnDailyCap')::numeric), 0), 1000000)::int ELSE 200 END,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "TwitchChatChannel" c
LEFT JOIN "PluginConfig" pc ON pc."guildId" = c."guildId" AND pc."pluginId" = 'economy'
LEFT JOIN "PluginState" ps ON ps."guildId" = c."guildId" AND ps."pluginId" = 'economy'
WHERE c."guildId" IS NOT NULL;

-- 2.2 ChannelWallet: every Twitch wallet of the channel's guild, balances copied exactly.
INSERT INTO "ChannelWallet" ("id", "economyId", "viewerUserId", "displayName", "balance", "lastDailyAt", "createdAt", "updatedAt")
SELECT
    'cw_' || c."id" || '_' || a."id",
    'ce_' || c."id",
    a."userId",
    a."displayName",
    a."balance",
    a."lastDailyAt",
    a."createdAt",
    a."updatedAt"
FROM "TwitchChatChannel" c
JOIN "EconomyAccount" a ON a."guildId" = c."guildId" AND a."platform" = 'TWITCH'
WHERE c."guildId" IS NOT NULL;

-- 2.3 ChannelTransaction: the append-only history of those wallets, preserved exactly (amounts, types, notes,
-- timestamps); accountId is remapped to the copied wallet, or NULL when the source account no longer exists
-- (EconomyTransaction.accountId is ON DELETE SET NULL) or is not one of the copied Twitch accounts.
INSERT INTO "ChannelTransaction" ("id", "economyId", "walletId", "fromUserId", "toUserId", "amount", "type", "note", "createdAt")
SELECT
    'ct_' || c."id" || '_' || t."id",
    'ce_' || c."id",
    CASE WHEN a."id" IS NULL THEN NULL ELSE 'cw_' || c."id" || '_' || a."id" END,
    t."fromUserId",
    t."toUserId",
    t."amount",
    t."type",
    t."note",
    t."createdAt"
FROM "TwitchChatChannel" c
JOIN "EconomyTransaction" t ON t."guildId" = c."guildId" AND t."platform" = 'TWITCH'
LEFT JOIN "EconomyAccount" a
    ON a."id" = t."accountId" AND a."guildId" = t."guildId" AND a."platform" = 'TWITCH'
WHERE c."guildId" IS NOT NULL;
