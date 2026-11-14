-- Raid mode (packages/plugins/src/raidmode): incidents (counts only), the exact permission changes a lockdown made
-- (deleted once restored), and medium/high risk scores for joins during a raid (member id, score, reason codes;
-- purged 30 days after the incident ends). Additive only.


-- CreateEnum
CREATE TYPE "RaidModeIncidentStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "RaidModeLockdownState" AS ENUM ('NONE', 'LOCKED', 'PARTIALLY_RESTORED', 'RESTORED');

-- CreateEnum
CREATE TYPE "RaidModeLockdownChangeKind" AS ENUM ('CHANNEL_OVERWRITE', 'VERIFICATION_LEVEL', 'INVITES_PAUSED');

-- CreateTable
CREATE TABLE "RaidModeIncident" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "status" "RaidModeIncidentStatus" NOT NULL DEFAULT 'ACTIVE',
    "dryRun" BOOLEAN NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastJoinAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "joinsTotal" INTEGER NOT NULL DEFAULT 0,
    "joinsFlagged" INTEGER NOT NULL DEFAULT 0,
    "riskLow" INTEGER NOT NULL DEFAULT 0,
    "riskMedium" INTEGER NOT NULL DEFAULT 0,
    "riskHigh" INTEGER NOT NULL DEFAULT 0,
    "thresholds" JSONB NOT NULL,
    "lockdownState" "RaidModeLockdownState" NOT NULL DEFAULT 'NONE',
    "lockdownActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lockdownAppliedAt" TIMESTAMP(3),
    "lockdownAppliedBy" TEXT,
    "lockdownRestoredAt" TIMESTAMP(3),
    "lockdownRestoredBy" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "alertChannelId" TEXT,
    "alertMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RaidModeIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RaidModeLockdownChange" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "kind" "RaidModeLockdownChangeKind" NOT NULL,
    "channelId" TEXT,
    "targetId" TEXT,
    "previousFlags" JSONB,
    "previousOverwriteExisted" BOOLEAN,
    "previousVerificationLevel" INTEGER,
    "appliedVerificationLevel" INTEGER,
    "restoreSkippedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RaidModeLockdownChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RaidModeRiskScore" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" TEXT[],
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RaidModeRiskScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RaidModeIncident_guildId_status_idx" ON "RaidModeIncident"("guildId", "status");

-- CreateIndex
CREATE INDEX "RaidModeIncident_guildId_startedAt_idx" ON "RaidModeIncident"("guildId", "startedAt");

-- CreateIndex
CREATE INDEX "RaidModeLockdownChange_incidentId_idx" ON "RaidModeLockdownChange"("incidentId");

-- CreateIndex
CREATE INDEX "RaidModeRiskScore_incidentId_score_idx" ON "RaidModeRiskScore"("incidentId", "score");

-- CreateIndex
CREATE INDEX "RaidModeRiskScore_guildId_createdAt_idx" ON "RaidModeRiskScore"("guildId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RaidModeRiskScore_incidentId_userId_key" ON "RaidModeRiskScore"("incidentId", "userId");

-- AddForeignKey
ALTER TABLE "RaidModeIncident" ADD CONSTRAINT "RaidModeIncident_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidModeLockdownChange" ADD CONSTRAINT "RaidModeLockdownChange_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "RaidModeIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidModeRiskScore" ADD CONSTRAINT "RaidModeRiskScore_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "RaidModeIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "RaidModeLockdownChange_guildId_idx" ON "RaidModeLockdownChange"("guildId");
