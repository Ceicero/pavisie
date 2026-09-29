-- Creator dashboard, phase 3 (ARCHITECTURE.md §19e): a streamer can connect an optional Discord server from the
-- creator dashboard by signing into Discord to prove they manage it. These two columns record who linked it and when
-- (audit trail, and the marker that the link was verified from the creator side). Matches `prisma migrate diff`
-- output for this schema change (statements are identical; only these comments are added). Additive and nullable:
-- existing rows (including guild-linked channels a Discord admin linked from the Discord dashboard) are untouched.

-- AlterTable
ALTER TABLE "TwitchChatChannel" ADD COLUMN     "discordLinkedAt" TIMESTAMP(3),
ADD COLUMN     "discordLinkedBy" TEXT;
