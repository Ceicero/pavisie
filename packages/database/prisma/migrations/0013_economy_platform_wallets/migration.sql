-- Per-platform economy wallets (Discord + Twitch). Matches `prisma migrate diff` output for this schema change.
-- Every existing EconomyAccount / EconomyTransaction row is backfilled as DISCORD via the column default, which is
-- historically accurate: Twitch wallets did not exist before this migration.
-- Note: no CREATE INDEX CONCURRENTLY — Postgres rejects it inside a transaction block, and Prisma runs each
-- migration file as one. The economy tables are small, so the brief lock is acceptable.

-- CreateEnum
CREATE TYPE "EconomyPlatform" AS ENUM ('DISCORD', 'TWITCH');

-- DropIndex (0001_init created this as a unique INDEX, not a table constraint)
DROP INDEX "EconomyAccount_guildId_userId_key";

-- AlterTable
ALTER TABLE "EconomyAccount" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "platform" "EconomyPlatform" NOT NULL DEFAULT 'DISCORD';

-- AlterTable
ALTER TABLE "EconomyTransaction" ADD COLUMN     "platform" "EconomyPlatform" NOT NULL DEFAULT 'DISCORD';

-- CreateIndex
CREATE INDEX "EconomyAccount_guildId_balance_idx" ON "EconomyAccount"("guildId", "balance");

-- CreateIndex (a Discord snowflake and a Twitch user id can be the same digits, so platform is part of the key)
CREATE UNIQUE INDEX "EconomyAccount_guildId_platform_userId_key" ON "EconomyAccount"("guildId", "platform", "userId");

-- CreateIndex
CREATE INDEX "EconomyTransaction_guildId_platform_type_idx" ON "EconomyTransaction"("guildId", "platform", "type");
