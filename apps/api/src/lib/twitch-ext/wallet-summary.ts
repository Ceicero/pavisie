// Read-only wallet summary for the extension panel. Deliberately separate from `channel-economy/ledger.ts`'s
// `getOrCreateChannelWallet` — that function UPSERTS (creates a wallet on first read), which is wrong here:
// ARCHITECTURE.md §19d says viewing the panel must never create a wallet, only claiming daily/earning/receiving a
// `!give` should. So this reads `ChannelWallet`/`ChannelTransaction` directly and treats "no row" as a zero balance,
// exactly the shape `claimChannelDaily` would already show if the viewer claims next.

import { DAILY_COOLDOWN_MS, STREAK_CONTINUES_WITHIN_MS, parseStreakFromNote } from '@pavisie/plugins/economy/service';
import type { ZodFastifyInstance } from '../http';

export interface TwitchWalletSummary {
  balance: bigint;
  dailyAvailableAt: Date | null;
  streak: number;
}

/** Pure: given the raw account/last-daily-transaction rows (or nulls, for "no wallet yet"), computes the
 * summary shape the panel shows. Split out from the prisma reads below so the date-math/streak logic has a
 * fast, DB-free test path. */
export function computeWalletSummary(
  account: { balance: bigint; lastDailyAt: Date | null } | null,
  lastDailyNote: string | null | undefined,
  now: Date,
): TwitchWalletSummary {
  if (!account) {
    return { balance: 0n, dailyAvailableAt: null, streak: 0 };
  }

  let dailyAvailableAt: Date | null = null;
  if (account.lastDailyAt) {
    const availableAt = new Date(account.lastDailyAt.getTime() + DAILY_COOLDOWN_MS);
    if (availableAt.getTime() > now.getTime()) {
      dailyAvailableAt = availableAt;
    }
  }

  // Mirrors `rollDaily`'s own "does the streak survive" check (service.ts) without rolling anything — a
  // streak that's gone past the 48h grace window reads as 0 here, same as it would reset to 1 on the next claim.
  const streakAlive =
    account.lastDailyAt !== null && now.getTime() - account.lastDailyAt.getTime() <= STREAK_CONTINUES_WITHIN_MS;
  const streak = streakAlive ? parseStreakFromNote(lastDailyNote) : 0;

  return { balance: account.balance, dailyAvailableAt, streak };
}

/** Reads the raw rows and delegates to {@link computeWalletSummary}. Never creates a wallet. */
export async function readChannelWalletSummary(
  app: ZodFastifyInstance,
  economyId: string,
  viewerUserId: string,
  now: Date = new Date(),
): Promise<TwitchWalletSummary> {
  const account = await app.prisma.channelWallet.findUnique({
    where: { economyId_viewerUserId: { economyId, viewerUserId } },
  });

  let lastDailyNote: string | null | undefined;
  if (account?.lastDailyAt) {
    const lastDailyTx = await app.prisma.channelTransaction.findFirst({
      where: { economyId, toUserId: viewerUserId, type: 'daily' },
      orderBy: { createdAt: 'desc' },
    });
    lastDailyNote = lastDailyTx?.note;
  }

  return computeWalletSummary(account, lastDailyNote, now);
}
