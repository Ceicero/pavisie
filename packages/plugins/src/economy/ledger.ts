// Platform-aware economy ledger functions. Every transaction explicitly sets platform;
// wallets on different platforms never merge or transfer.
// Uses the same $transaction + conditional-guard patterns as commands/economy.ts for concurrency safety.

import type { PrismaClient } from '@pavisie/database';
import {
  DAILY_COOLDOWN_MS,
  type RollDailyConfig,
  type GiveConfig,
  encodeStreakNote,
  parseStreakFromNote,
  rollDaily,
  validateGive,
} from './service';

// Transaction types that count as "earned" (used by leaderboard to rank by lifetime earned).
// Transfers (give) and admin adjustments are NOT earned.
export const EARNED_TRANSACTION_TYPES = ['daily', 'twitch_chat_earn', 'twitch_watch_earn'] as const;

export type EconomyPlatform = 'DISCORD' | 'TWITCH';

export interface WalletKey {
  guildId: string;
  platform: EconomyPlatform;
  userId: string;
}

// Sentinels thrown from inside $transaction callbacks to unwind without committing.
class DailyAlreadyClaimedError extends Error {}
class InsufficientBalanceError extends Error {}
class BalanceWouldGoNegativeError extends Error {}

/**
 * Upsert or update a wallet by the compound key (guildId, platform, userId).
 * For TWITCH, accepts and updates displayName (the viewer's Twitch display name, for leaderboard).
 */
export async function getOrCreateWallet(
  prisma: PrismaClient,
  key: WalletKey,
  displayName?: string,
) {
  return prisma.economyAccount.upsert({
    where: { guildId_platform_userId: { guildId: key.guildId, platform: key.platform, userId: key.userId } },
    create: { guildId: key.guildId, platform: key.platform, userId: key.userId, displayName },
    update: displayName !== undefined ? { displayName } : {},
  });
}

export type ClaimDailyResult =
  | { ok: false; retryAfterMs: number }
  | { ok: true; amount: bigint; streak: number };

/**
 * Claim a daily reward. Returns same result as rollDaily (ok/retryAfterMs).
 * Uses conditional guards to prevent concurrent claims on the same wallet.
 */
export async function claimDaily(
  prisma: PrismaClient,
  key: WalletKey,
  config: RollDailyConfig,
  now: Date,
  rng: () => number,
): Promise<ClaimDailyResult> {
  const account = await getOrCreateWallet(prisma, key);
  const lastDailyTx = await prisma.economyTransaction.findFirst({
    where: { guildId: key.guildId, platform: key.platform, toUserId: key.userId, type: 'daily' },
    orderBy: { createdAt: 'desc' },
  });
  const priorStreak = parseStreakFromNote(lastDailyTx?.note);

  const result = rollDaily({
    now,
    lastDailyAt: account.lastDailyAt,
    priorStreak,
    config,
    rng,
  });
  if (!result.ok) return result;

  const amount = BigInt(result.amount);
  const cutoff = new Date(now.getTime() - DAILY_COOLDOWN_MS);

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.economyAccount.updateMany({
        where: {
          id: account.id,
          OR: [{ lastDailyAt: null }, { lastDailyAt: { lte: cutoff } }],
        },
        data: { balance: { increment: amount }, lastDailyAt: now },
      });
      if (claimed.count === 0) throw new DailyAlreadyClaimedError();

      await tx.economyTransaction.create({
        data: {
          guildId: key.guildId,
          platform: key.platform,
          accountId: account.id,
          toUserId: key.userId,
          amount,
          type: 'daily',
          note: encodeStreakNote(result.streak),
        },
      });
    });
  } catch (err) {
    if (err instanceof DailyAlreadyClaimedError) {
      // Reread fresh to compute the correct retry-after time.
      const fresh = await prisma.economyAccount.findUniqueOrThrow({ where: { id: account.id } });
      const elapsed = fresh.lastDailyAt ? Date.now() - fresh.lastDailyAt.getTime() : 0;
      const retryAfterMs = Math.max(0, DAILY_COOLDOWN_MS - elapsed);
      return { ok: false, retryAfterMs };
    }
    throw err;
  }

  return { ok: true, amount, streak: result.streak };
}

export type GiveResult =
  | { ok: true }
  | { ok: false; reason: 'self' | 'bot' | 'below_min' | 'above_max' | 'insufficient_balance' | 'cross_platform' };

/**
 * Transfer balance between two wallets on the SAME platform.
 * Rejects cross-platform transfers explicitly.
 */
export async function give(
  prisma: PrismaClient,
  fromKey: WalletKey,
  toKey: WalletKey,
  amount: number,
  config: GiveConfig,
): Promise<GiveResult> {
  // Cross-platform transfer rejected.
  if (fromKey.platform !== toKey.platform) {
    return { ok: false, reason: 'cross_platform' };
  }

  const senderAccount = await getOrCreateWallet(prisma, fromKey);
  const validation = validateGive({
    amount,
    senderBalance: senderAccount.balance,
    config,
    targetIsSelf: fromKey.userId === toKey.userId,
    targetIsBot: false, // Discord-only; Twitch wallets can't be bots.
  });

  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  const targetAccount = await getOrCreateWallet(prisma, toKey);
  const bigAmount = BigInt(amount);

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.economyAccount.updateMany({
        where: { id: senderAccount.id, balance: { gte: bigAmount } },
        data: { balance: { decrement: bigAmount } },
      });
      if (claimed.count === 0) throw new InsufficientBalanceError();

      await tx.economyAccount.update({
        where: { id: targetAccount.id },
        data: { balance: { increment: bigAmount } },
      });

      await tx.economyTransaction.create({
        data: {
          guildId: fromKey.guildId,
          platform: fromKey.platform,
          accountId: senderAccount.id,
          fromUserId: fromKey.userId,
          toUserId: toKey.userId,
          amount: bigAmount,
          type: 'give',
        },
      });
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return { ok: false, reason: 'insufficient_balance' };
    }
    throw err;
  }

  return { ok: true };
}

export type CreditResult = { ok: true; newBalance: bigint } | { ok: false; reason: 'invalid_amount' };

/**
 * Credit a positive amount to a wallet (for earning).
 * type should be a member of EARNED_TRANSACTION_TYPES.
 */
export async function credit(
  prisma: PrismaClient,
  key: WalletKey,
  amount: number,
  type: string,
  note?: string,
): Promise<CreditResult> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }

  const account = await getOrCreateWallet(prisma, key);
  const bigAmount = BigInt(amount);

  const result = await prisma.$transaction(async (tx) => {
    await tx.economyAccount.update({
      where: { id: account.id },
      data: { balance: { increment: bigAmount } },
    });

    await tx.economyTransaction.create({
      data: {
        guildId: key.guildId,
        platform: key.platform,
        accountId: account.id,
        toUserId: key.userId,
        amount: bigAmount,
        type,
        note,
      },
    });

    const updated = await tx.economyAccount.findUniqueOrThrow({ where: { id: account.id } });
    return updated.balance;
  });

  return { ok: true, newBalance: result };
}

export interface LeaderboardEntry {
  userId: string;
  platform: EconomyPlatform;
  displayName: string | null;
  earned: bigint;
}

/**
 * Top wallets on `platform` ranked by lifetime earned (sum of `EARNED_TRANSACTION_TYPES` transactions) —
 * shared by `/economy leaderboard platform:<x>` (commands/economy.ts) and the Twitch chat `!top` command
 * (integrations/twitch-chat/economy-commands.ts) so this ranking query lives in exactly one place.
 */
export async function getPlatformLeaderboard(
  prisma: PrismaClient,
  guildId: string,
  platform: EconomyPlatform,
  limit: number,
): Promise<LeaderboardEntry[]> {
  const rows = await prisma.economyTransaction.groupBy({
    by: ['accountId'],
    where: {
      guildId,
      platform,
      accountId: { not: null },
      type: { in: [...EARNED_TRANSACTION_TYPES] },
    },
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take: limit,
  });

  const accountIds = rows.map((r) => r.accountId).filter((id): id is string => Boolean(id));
  const accounts = await prisma.economyAccount.findMany({ where: { id: { in: accountIds } } });
  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  return rows
    .map((row): LeaderboardEntry | null => {
      const account = accountMap.get(row.accountId!);
      if (!account) return null;
      return {
        userId: account.userId,
        platform: account.platform as EconomyPlatform,
        displayName: account.displayName ?? null,
        earned: row._sum.amount ?? 0n,
      };
    })
    .filter((row): row is LeaderboardEntry => row !== null);
}

export type AdminAdjustResult = { ok: true; newBalance: bigint } | { ok: false; reason: 'would_go_negative' };

/**
 * Admin add/remove balance. direction: 1 for add, -1 for remove.
 * For remove, checks at write time that balance never goes negative.
 */
export async function adminAdjust(
  prisma: PrismaClient,
  key: WalletKey,
  direction: 1 | -1,
  amount: number,
  reason?: string,
): Promise<AdminAdjustResult> {
  const account = await getOrCreateWallet(prisma, key);
  const bigAmount = BigInt(amount);

  let afterBalance: bigint;
  try {
    afterBalance = await prisma.$transaction(async (tx) => {
      if (direction === -1) {
        const claimed = await tx.economyAccount.updateMany({
          where: { id: account.id, balance: { gte: bigAmount } },
          data: { balance: { decrement: bigAmount } },
        });
        if (claimed.count === 0) throw new BalanceWouldGoNegativeError();
      } else {
        await tx.economyAccount.update({
          where: { id: account.id },
          data: { balance: { increment: bigAmount } },
        });
      }

      await tx.economyTransaction.create({
        data: {
          guildId: key.guildId,
          platform: key.platform,
          accountId: account.id,
          toUserId: direction === 1 ? key.userId : undefined,
          fromUserId: direction === -1 ? key.userId : undefined,
          amount: bigAmount,
          type: direction === 1 ? 'admin_add' : 'admin_remove',
          note: reason,
        },
      });

      const updated = await tx.economyAccount.findUniqueOrThrow({ where: { id: account.id } });
      return updated.balance;
    });
  } catch (err) {
    if (err instanceof BalanceWouldGoNegativeError) {
      return { ok: false, reason: 'would_go_negative' };
    }
    throw err;
  }

  return { ok: true, newBalance: afterBalance };
}
