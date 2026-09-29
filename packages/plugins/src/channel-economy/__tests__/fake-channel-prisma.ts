// A small hand-built fake for `ChannelWallet`/`ChannelTransaction`, including a directly-callable
// `$transaction(async (tx) => ...)` (the SDK's generic `createPrismaStub` cannot represent that — same reason
// `economy/__tests__/fake-economy-prisma.ts` exists). Every mutator runs its check-and-write as ONE synchronous
// block (no `await` in the middle), so concurrent calls interleave only at `await` boundaries — the same atomicity a
// real conditional `UPDATE ... WHERE` statement gives a single row.
import type { PrismaClient } from '@pavisie/database';

export interface FakeWallet {
  id: string;
  economyId: string;
  viewerUserId: string;
  displayName: string | null;
  balance: bigint;
  lastDailyAt: Date | null;
}

export interface FakeTx {
  id: string;
  economyId: string;
  walletId: string | null;
  fromUserId: string | null;
  toUserId: string | null;
  amount: bigint;
  type: string;
  note: string | null;
  createdAt: Date;
}

type BalanceOp = { increment?: bigint; decrement?: bigint };

interface UpdateManyWhere {
  id: string;
  balance?: { gte: bigint };
  OR?: Array<{ lastDailyAt: null } | { lastDailyAt: { lte: Date } }>;
}

export function walletId(economyId: string, viewerUserId: string): string {
  return `w-${economyId}-${viewerUserId}`;
}

export function buildFakeChannelPrisma(seedWallets: Array<Partial<FakeWallet> & Pick<FakeWallet, 'economyId' | 'viewerUserId'>> = []) {
  const wallets = new Map<string, FakeWallet>();
  const transactions: FakeTx[] = [];
  let txSeq = 0;
  let clock = Date.parse('2026-01-01T00:00:00Z');

  for (const w of seedWallets) {
    const id = w.id ?? walletId(w.economyId, w.viewerUserId);
    wallets.set(id, { id, displayName: null, balance: 0n, lastDailyAt: null, ...w });
  }

  function applyBalance(w: FakeWallet, op: BalanceOp | undefined): void {
    if (op?.increment !== undefined) w.balance += op.increment;
    if (op?.decrement !== undefined) w.balance -= op.decrement;
  }

  function matchesGuard(w: FakeWallet, where: UpdateManyWhere): boolean {
    if (w.id !== where.id) return false;
    if (where.balance && !(w.balance >= where.balance.gte)) return false;
    if (where.OR) {
      const ok = where.OR.some((cond) =>
        'lastDailyAt' in cond && cond.lastDailyAt === null
          ? w.lastDailyAt === null
          : w.lastDailyAt !== null && w.lastDailyAt.getTime() <= (cond as { lastDailyAt: { lte: Date } }).lastDailyAt.lte.getTime(),
      );
      if (!ok) return false;
    }
    return true;
  }

  const channelWallet = {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { economyId_viewerUserId: { economyId: string; viewerUserId: string } };
      create: { economyId: string; viewerUserId: string; displayName?: string };
      update?: { displayName?: string };
    }) => {
      const { economyId, viewerUserId } = where.economyId_viewerUserId;
      const existing = [...wallets.values()].find((w) => w.economyId === economyId && w.viewerUserId === viewerUserId);
      if (existing) {
        if (update?.displayName !== undefined) existing.displayName = update.displayName;
        return { ...existing };
      }
      const created: FakeWallet = {
        id: walletId(create.economyId, create.viewerUserId),
        economyId: create.economyId,
        viewerUserId: create.viewerUserId,
        displayName: create.displayName ?? null,
        balance: 0n,
        lastDailyAt: null,
      };
      wallets.set(created.id, created);
      return { ...created };
    },
    findUnique: async ({ where }: { where: { economyId_viewerUserId: { economyId: string; viewerUserId: string } } }) => {
      const { economyId, viewerUserId } = where.economyId_viewerUserId;
      const found = [...wallets.values()].find((w) => w.economyId === economyId && w.viewerUserId === viewerUserId);
      return found ? { ...found } : null;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: UpdateManyWhere;
      data: { balance?: BalanceOp; lastDailyAt?: Date | null };
    }) => {
      const w = wallets.get(where.id);
      if (!w || !matchesGuard(w, where)) return { count: 0 };
      applyBalance(w, data.balance);
      if ('lastDailyAt' in data) w.lastDailyAt = data.lastDailyAt ?? null;
      return { count: 1 };
    },
    update: async ({ where, data }: { where: { id: string }; data: { balance?: BalanceOp } }) => {
      const w = wallets.get(where.id);
      if (!w) throw new Error(`no wallet ${where.id}`);
      applyBalance(w, data.balance);
      return { ...w };
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const w = wallets.get(where.id);
      if (!w) throw new Error(`no wallet ${where.id}`);
      return { ...w };
    },
    findMany: async ({
      where,
      orderBy,
      take,
    }: {
      where?: { economyId?: string; id?: { in: string[] }; balance?: { gt: bigint } };
      orderBy?: { balance: 'desc' };
      take?: number;
    }) => {
      let rows = [...wallets.values()];
      if (where?.economyId !== undefined) rows = rows.filter((w) => w.economyId === where.economyId);
      if (where?.id !== undefined) rows = rows.filter((w) => where.id!.in.includes(w.id));
      if (where?.balance !== undefined) rows = rows.filter((w) => w.balance > where.balance!.gt);
      if (orderBy?.balance === 'desc') rows = [...rows].sort((a, b) => (a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0));
      if (take !== undefined) rows = rows.slice(0, take);
      return rows.map((r) => ({ ...r }));
    },
  };

  const channelTransaction = {
    create: async ({ data }: { data: Partial<FakeTx> & Pick<FakeTx, 'economyId' | 'amount' | 'type'> }) => {
      clock += 1000;
      const row: FakeTx = {
        id: `tx-${++txSeq}`,
        walletId: null,
        fromUserId: null,
        toUserId: null,
        note: null,
        createdAt: new Date(clock),
        ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
      } as FakeTx;
      transactions.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: { where: { economyId: string; toUserId: string; type: string }; orderBy: { createdAt: 'desc' } }) => {
      const matches = transactions.filter(
        (t) => t.economyId === where.economyId && t.toUserId === where.toUserId && t.type === where.type,
      );
      return matches.length > 0 ? { ...matches[matches.length - 1]! } : null;
    },
    groupBy: async ({
      where,
      take,
    }: {
      where: { economyId: string; walletId: { not: null }; type: { in: readonly string[] } };
      take?: number;
    }) => {
      const matches = transactions.filter(
        (t) => t.economyId === where.economyId && where.type.in.includes(t.type) && t.walletId !== null,
      );
      const sums = new Map<string, bigint>();
      for (const t of matches) sums.set(t.walletId as string, (sums.get(t.walletId as string) ?? 0n) + t.amount);
      let rows = [...sums.entries()].map(([id, amount]) => ({ walletId: id, _sum: { amount } }));
      rows = rows.sort((a, b) => (a._sum.amount < b._sum.amount ? 1 : a._sum.amount > b._sum.amount ? -1 : 0));
      if (take !== undefined) rows = rows.slice(0, take);
      return rows;
    },
  };

  const prisma = {
    channelWallet,
    channelTransaction,
    $transaction: async <T>(fn: (tx: { channelWallet: typeof channelWallet; channelTransaction: typeof channelTransaction }) => Promise<T>) =>
      fn({ channelWallet, channelTransaction }),
  };

  return {
    prisma: prisma as unknown as PrismaClient,
    getWallet: (economyId: string, viewerUserId: string) => wallets.get(walletId(economyId, viewerUserId)),
    getTransactions: () => transactions,
    allWallets: () => [...wallets.values()],
    seedTransaction: (t: Partial<FakeTx> & Pick<FakeTx, 'economyId' | 'amount' | 'type'>) => {
      clock += 1000;
      const row: FakeTx = {
        id: `tx-${++txSeq}`,
        walletId: null,
        fromUserId: null,
        toUserId: null,
        note: null,
        createdAt: new Date(clock),
        ...t,
      };
      transactions.push(row);
      return row;
    },
  };
}
