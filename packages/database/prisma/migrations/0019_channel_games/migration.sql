-- Table games for a channel's own currency (phase 1: blackjack).
-- Additive only: three new columns with defaults (blackjack is OFF for every existing channel), one enum, one table.

-- CreateEnum
CREATE TYPE "ChannelGameType" AS ENUM ('BLACKJACK', 'POKER', 'IDLE');

-- AlterTable
ALTER TABLE "ChannelEconomy"
  ADD COLUMN "blackjackEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "blackjackMinBet" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "blackjackMaxBet" INTEGER NOT NULL DEFAULT 1000;

-- CreateTable
CREATE TABLE "ChannelGameHand" (
    "id" TEXT NOT NULL,
    "economyId" TEXT NOT NULL,
    "game" "ChannelGameType" NOT NULL,
    "seed" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelGameHand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelGameHand_economyId_createdAt_idx" ON "ChannelGameHand"("economyId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChannelGameHand" ADD CONSTRAINT "ChannelGameHand_economyId_fkey" FOREIGN KEY ("economyId") REFERENCES "ChannelEconomy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
