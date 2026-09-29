// Channel-owned economy ledger (ChannelEconomy / ChannelWallet / ChannelTransaction, ARCHITECTURE.md §18b/§19e).
//
// This is the ONLY module allowed to write a ChannelWallet balance, exactly as `economy/ledger.ts` is for guild
// wallets, and it mirrors that module's semantics deliberately:
//   - every balance change is an append-only ChannelTransaction written in the same `$transaction`;
//   - balances never go negative (conditional `updateMany` guards, so under concurrency exactly one of two
//     competing spends wins and the loser leaves no ledger row);
//   - daily cooldown (20h) and streak (48h window) come from the same pure `rollDaily` the guild economy uses;
//   - `give` stays inside ONE channel's currency (self / bot / min / max / insufficient checks);
//   - the same transaction `type` vocabulary: daily, give, twitch_chat_earn, admin_add, admin_remove.
// Wallets are keyed by (economyId, viewerUserId) and are never merged with Discord wallets or with another
// channel's wallets. Virtual currency only — no purchase, no cash-out, no wagering (SPEC.md §G).
//
// Deliberate differences from `economy/ledger.ts` (each is a tightening, none changes an outcome a caller could
// have relied on): amounts must be safe positive integers everywhere (`invalid_amount`, instead of a thrown
// RangeError from BigInt()); `give` only creates the RECIPIENT's wallet after every validation has passed (so a
// rejected `!give` never stores a bystander's display name); `claimDaily`'s retry-after is measured against the
// injected `now`, not the wall clock.

import type { PrismaClient } from '@pavisie/database';
import { EARNED_TRANSACTION_TYPES } from '../economy/ledger';
import {
  DAILY_COOLDOWN_MS,
  type GiveConfig,
  type RollDailyConfig,
  encodeStreakNote,
  parseStreakFromNote,
  rollDaily,
  validateGive,
} from '../economy/service';

export { EARNED_TRANSACTION_TYPES };

/** Which wallet: one viewer inside one channel's economy. */
export interface ChannelWalletKey {
  economyId: string;
  viewerUserId: string;
}

// Sentinels thrown from inside $transaction callbacks to unwind without committing.
class DailyAlreadyClaimedError extends Error {}
class InsufficientBalanceError extends Error {}
class BalanceWouldGoNegativeError extends Error {}

function isPositiveSafeInteger(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount > 0;
}

/**
 * Upsert a wallet by (economyId, viewerUserId); `displayName` (the viewer's Twitch display name, for boards) is
 * stored/refreshed only when provided — omitting it never wipes an existing one.
 */
export async function getOrCreateChannelWallet(prisma: PrismaClient, key: ChannelWalletKey, displayName?: string) {
  return prisma.channelWallet.upsert({
    where: { economyId_viewerUserId: { economyId: key.economyId, viewerUserId: key.viewerUserId } },
    create: { economyId: key.economyId, viewerUserId: key.viewerUserId, displayName },
    update: displayName !== undefined ? { displayName } : {},
  });
}

/** Read-only wallet lookup — `null` when the viewer has no wallet. Never creates one (the extension panel and
 * `!balance`-style views must not leave a row behind just for looking). */
export async function findChannelWallet(prisma: PrismaClient, key: ChannelWalletKey) {
  return prisma.channelWallet.findUnique({
    where: { economyId_viewerUserId: { economyId: key.economyId, viewerUserId: key.viewerUserId } },
  });
}

export type ChannelClaimDailyResult =
  | { ok: false; retryAfterMs: number }
  | { ok: true; amount: bigint; streak: number };

/**
 * Claim a daily reward. Same result shape as `economy/ledger.ts`'s `claimDaily`. The conditional `updateMany`
 * guard means two concurrent claims on one wallet can never both pay out.
 */
export async function claimChannelDaily(
  prisma: PrismaClient,
  key: ChannelWalletKey,
  config: RollDailyConfig,
  now: Date,
  rng: () => number,
  displayName?: string,
): Promise<ChannelClaimDailyResult> {
  const wallet = await getOrCreateChannelWallet(prisma, key, displayName);
  const lastDailyTx = await prisma.channelTransaction.findFirst({
    where: { economyId: key.economyId, toUserId: key.viewerUserId, type: 'daily' },
    orderBy: { createdAt: 'desc' },
  });
  const priorStreak = parseStreakFromNote(lastDailyTx?.note);

  const result = rollDaily({ now, lastDailyAt: wallet.lastDailyAt, priorStreak, config, rng });
  if (!result.ok) return result;

  const amount = BigInt(result.amount);
  const cutoff = new Date(now.getTime() - DAILY_COOLDOWN_MS);

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.channelWallet.updateMany({
        where: {
          id: wallet.id,
          OR: [{ lastDailyAt: null }, { lastDailyAt: { lte: cutoff } }],
        },
        data: { balance: { increment: amount }, lastDailyAt: now },
      });
      if (claimed.count === 0) throw new DailyAlreadyClaimedError();

      await tx.channelTransaction.create({
        data: {
          economyId: key.economyId,
          walletId: wallet.id,
          toUserId: key.viewerUserId,
          amount,
          type: 'daily',
          note: encodeStreakNote(result.streak),
        },
      });
    });
  } catch (err) {
    if (err instanceof DailyAlreadyClaimedError) {
      // Reread fresh to compute the correct retry-after time.
      const fresh = await prisma.channelWallet.findUniqueOrThrow({ where: { id: wallet.id } });
      const elapsed = fresh.lastDailyAt ? now.getTime() - fresh.lastDailyAt.getTime() : 0;
      return { ok: false, retryAfterMs: Math.max(0, DAILY_COOLDOWN_MS - elapsed) };
    }
    throw err;
  }

  return { ok: true, amount, streak: result.streak };
}

export type ChannelGiveResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'self' | 'bot' | 'below_min' | 'above_max' | 'insufficient_balance' | 'invalid_amount';
    };

export interface ChannelGiveOptions {
  /** The bot account's own Twitch user id, if known — sending to it is rejected (`bot`). */
  botUserId?: string | null;
  /** Display names to store on the wallets (only written once the give has passed validation, for the recipient). */
  fromDisplayName?: string;
  toDisplayName?: string;
}

/**
 * Transfer balance between two viewers of the SAME channel economy. There is no cross-channel or cross-platform
 * variant: both wallets are addressed by one `economyId`.
 */
export async function giveChannel(
  prisma: PrismaClient,
  economyId: string,
  fromUserId: string,
  toUserId: string,
  amount: number,
  config: GiveConfig,
  options: ChannelGiveOptions = {},
): Promise<ChannelGiveResult> {
  if (!isPositiveSafeInteger(amount)) return { ok: false, reason: 'invalid_amount' };

  const senderWallet = await getOrCreateChannelWallet(prisma, { economyId, viewerUserId: fromUserId }, options.fromDisplayName);
  const validation = validateGive({
    amount,
    senderBalance: senderWallet.balance,
    config,
    targetIsSelf: fromUserId === toUserId,
    targetIsBot: Boolean(options.botUserId) && toUserId === options.botUserId,
  });
  if (!validation.ok) return { ok: false, reason: validation.reason };

  const targetWallet = await getOrCreateChannelWallet(prisma, { economyId, viewerUserId: toUserId }, options.toDisplayName);
  const bigAmount = BigInt(amount);

  try {
    await prisma.$transaction(async (tx) => {
      const debited = await tx.channelWallet.updateMany({
        where: { id: senderWallet.id, balance: { gte: bigAmount } },
        data: { balance: { decrement: bigAmount } },
      });
      if (debited.count === 0) throw new InsufficientBalanceError();

      await tx.channelWallet.update({
        where: { id: targetWallet.id },
        data: { balance: { increment: bigAmount } },
      });

      await tx.channelTransaction.create({
        data: {
          economyId,
          walletId: senderWallet.id,
          fromUserId,
          toUserId,
          amount: bigAmount,
          type: 'give',
        },
      });
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) return { ok: false, reason: 'insufficient_balance' };
    throw err;
  }

  return { ok: true };
}

export type ChannelCreditResult = { ok: true; newBalance: bigint } | { ok: false; reason: 'invalid_amount' };

/**
 * Credit a positive amount to a wallet (earning). `type` should be a member of `EARNED_TRANSACTION_TYPES` for it
 * to count towards the lifetime-earned board.
 */
export async function creditChannel(
  prisma: PrismaClient,
  key: ChannelWalletKey,
  amount: number,
  type: string,
  options: { note?: string; displayName?: string } = {},
): Promise<ChannelCreditResult> {
  if (!isPositiveSafeInteger(amount)) return { ok: false, reason: 'invalid_amount' };

  const wallet = await getOrCreateChannelWallet(prisma, key, options.displayName);
  const bigAmount = BigInt(amount);

  const newBalance = await prisma.$transaction(async (tx) => {
    await tx.channelWallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: bigAmount } },
    });

    await tx.channelTransaction.create({
      data: {
        economyId: key.economyId,
        walletId: wallet.id,
        toUserId: key.viewerUserId,
        amount: bigAmount,
        type,
        note: options.note,
      },
    });

    const updated = await tx.channelWallet.findUniqueOrThrow({ where: { id: wallet.id } });
    return updated.balance;
  });

  return { ok: true, newBalance };
}

export type ChannelAdminAdjustResult =
  | { ok: true; newBalance: bigint }
  | { ok: false; reason: 'would_go_negative' | 'invalid_amount' };

/**
 * The streamer's manual add/remove. `direction`: 1 to add, -1 to remove. A remove is guarded at write time so a
 * balance can never go negative. The reason is recorded on the transaction's `note`.
 */
export async function adminAdjustChannel(
  prisma: PrismaClient,
  key: ChannelWalletKey,
  direction: 1 | -1,
  amount: number,
  reason?: string,
  displayName?: string,
): Promise<ChannelAdminAdjustResult> {
  if (!isPositiveSafeInteger(amount)) return { ok: false, reason: 'invalid_amount' };

  const wallet = await getOrCreateChannelWallet(prisma, key, displayName);
  const bigAmount = BigInt(amount);

  let afterBalance: bigint;
  try {
    afterBalance = await prisma.$transaction(async (tx) => {
      if (direction === -1) {
        const debited = await tx.channelWallet.updateMany({
          where: { id: wallet.id, balance: { gte: bigAmount } },
          data: { balance: { decrement: bigAmount } },
        });
        if (debited.count === 0) throw new BalanceWouldGoNegativeError();
      } else {
        await tx.channelWallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: bigAmount } },
        });
      }

      await tx.channelTransaction.create({
        data: {
          economyId: key.economyId,
          walletId: wallet.id,
          toUserId: direction === 1 ? key.viewerUserId : undefined,
          fromUserId: direction === -1 ? key.viewerUserId : undefined,
          amount: bigAmount,
          type: direction === 1 ? 'admin_add' : 'admin_remove',
          note: reason,
        },
      });

      const updated = await tx.channelWallet.findUniqueOrThrow({ where: { id: wallet.id } });
      return updated.balance;
    });
  } catch (err) {
    if (err instanceof BalanceWouldGoNegativeError) return { ok: false, reason: 'would_go_negative' };
    throw err;
  }

  return { ok: true, newBalance: afterBalance };
}

export interface ChannelEarnedEntry {
  viewerUserId: string;
  displayName: string | null;
  earned: bigint;
}

/**
 * Top viewers of one channel by lifetime earned (the sum of `EARNED_TRANSACTION_TYPES` transactions) — the one
 * place this ranking query lives, shared by the Twitch `!top` command, the extension panel, the creator dashboard
 * and the Discord `/economy leaderboard` boards. Transfers and manual adjustments are not "earned".
 */
export async function getChannelEarnedLeaderboard(
  prisma: PrismaClient,
  economyId: string,
  limit: number,
): Promise<ChannelEarnedEntry[]> {
  const rows = await prisma.channelTransaction.groupBy({
    by: ['walletId'],
    where: {
      economyId,
      walletId: { not: null },
      type: { in: [...EARNED_TRANSACTION_TYPES] },
    },
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take: limit,
  });

  const walletIds = rows.map((r) => r.walletId).filter((id): id is string => Boolean(id));
  const wallets = await prisma.channelWallet.findMany({ where: { id: { in: walletIds } } });
  const walletMap = new Map(wallets.map((w) => [w.id, w]));

  return rows
    .map((row): ChannelEarnedEntry | null => {
      const wallet = walletMap.get(row.walletId!);
      if (!wallet) return null;
      return {
        viewerUserId: wallet.viewerUserId,
        displayName: wallet.displayName ?? null,
        earned: row._sum.amount ?? 0n,
      };
    })
    .filter((row): row is ChannelEarnedEntry => row !== null);
}

export interface ChannelBalanceEntry {
  viewerUserId: string;
  displayName: string | null;
  balance: bigint;
}

/** Top viewers of one channel by CURRENT balance (wallets holding nothing are left out). */
export async function getChannelBalanceLeaderboard(
  prisma: PrismaClient,
  economyId: string,
  limit: number,
): Promise<ChannelBalanceEntry[]> {
  const wallets = await prisma.channelWallet.findMany({
    where: { economyId, balance: { gt: 0n } },
    orderBy: { balance: 'desc' },
    take: limit,
  });
  return wallets.map((w) => ({ viewerUserId: w.viewerUserId, displayName: w.displayName ?? null, balance: w.balance }));
}
