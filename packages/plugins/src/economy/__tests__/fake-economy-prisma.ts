import type { CommandContext } from '../../sdk';

export interface FakeAccount {
  id: string;
  guildId: string;
  platform: 'DISCORD' | 'TWITCH';
  userId: string;
  displayName?: string;
  balance: bigint;
  lastDailyAt: Date | null;
}

export interface FakeTransaction {
  id: string;
  guildId: string;
  platform: 'DISCORD' | 'TWITCH';
  accountId: string | null;
  fromUserId?: string;
  toUserId?: string;
  amount: bigint;
  type: string;
  note?: string;
  createdAt: Date;
}

export interface UpdateManyWhere {
  id: string;
  balance?: { gte: bigint };
  OR?: Array<{ lastDailyAt: null } | { lastDailyAt: { lte: Date } }>;
}

export interface FindManyAccountsArgs {
  where?: { guildId?: string; id?: { in: string[] } };
  orderBy?: { balance: 'desc' };
  take?: number;
}

export interface GroupByTransactionsArgs {
  by: ['accountId'];
  where: {
    guildId: string;
    platform: 'DISCORD' | 'TWITCH';
    type: { in: readonly string[] };
    accountId?: { not: null };
  };
  _sum: { amount: true };
  orderBy: { _sum: { amount: 'desc' } };
  take?: number;
}

/**
 * A small hand-built fake for `EconomyAccount`/`EconomyTransaction`, including a directly-callable
 * `$transaction(async (tx) => ...)` — the SDK's generic `createPrismaStub` (sdk/testing.ts) can't represent
 * that (every property access returns a nested method proxy, never a callable function; see the same
 * workaround in moderation/__tests__/case-number.test.ts and enforcer/__tests__/record-number.test.ts). Every
 * mutator below runs its check-and-write as a single synchronous block (no `await` in the middle), so
 * concurrent calls interleave only at `await` boundaries — the same atomicity a real conditional `UPDATE ...
 * WHERE` statement gives a single row.
 */
export function buildFakeEconomyPrisma(seedAccounts: FakeAccount[], seedTransactions: FakeTransaction[] = []) {
  const accounts = new Map(seedAccounts.map((a) => [a.id, { ...a }]));
  const transactions: FakeTransaction[] = seedTransactions.map((t) => ({ ...t }));
  let txSeq = transactions.length;

  function matchesUpdateManyGuard(acc: FakeAccount, where: UpdateManyWhere): boolean {
    if (acc.id !== where.id) return false;
    if (where.balance && !(acc.balance >= where.balance.gte)) return false;
    if (where.OR) {
      const ok = where.OR.some((cond) =>
        'lastDailyAt' in cond && cond.lastDailyAt === null
          ? acc.lastDailyAt === null
          : acc.lastDailyAt !== null && acc.lastDailyAt.getTime() <= (cond as { lastDailyAt: { lte: Date } }).lastDailyAt.lte.getTime(),
      );
      if (!ok) return false;
    }
    return true;
  }

  const economyAccount = {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { guildId_platform_userId: { guildId: string; platform: 'DISCORD' | 'TWITCH'; userId: string } };
      create: { guildId: string; platform: 'DISCORD' | 'TWITCH'; userId: string; displayName?: string };
      update?: Partial<FakeAccount>;
    }) => {
      const { guildId, platform, userId } = where.guildId_platform_userId;
      const existing = [...accounts.values()].find(
        (a) => a.guildId === guildId && a.platform === platform && a.userId === userId,
      );
      if (existing) {
        if (update && 'displayName' in update && update.displayName) {
          existing.displayName = update.displayName;
        }
        return { ...existing };
      }
      const created: FakeAccount = {
        id: `acct-${create.guildId}-${create.platform}-${create.userId}`,
        guildId: create.guildId,
        platform: create.platform,
        userId: create.userId,
        displayName: create.displayName,
        balance: 0n,
        lastDailyAt: null,
      };
      accounts.set(created.id, created);
      return { ...created };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: UpdateManyWhere;
      data: { balance?: { increment?: bigint; decrement?: bigint }; lastDailyAt?: Date | null };
    }) => {
      const acc = accounts.get(where.id);
      if (!acc || !matchesUpdateManyGuard(acc, where)) return { count: 0 };
      if (data.balance?.increment !== undefined) acc.balance += data.balance.increment;
      if (data.balance?.decrement !== undefined) acc.balance -= data.balance.decrement;
      if ('lastDailyAt' in data) acc.lastDailyAt = data.lastDailyAt ?? null;
      return { count: 1 };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { balance?: { increment?: bigint; decrement?: bigint } };
    }) => {
      const acc = accounts.get(where.id);
      if (!acc) throw new Error(`no account ${where.id}`);
      if (data.balance?.increment !== undefined) acc.balance += data.balance.increment;
      if (data.balance?.decrement !== undefined) acc.balance -= data.balance.decrement;
      return { ...acc };
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const acc = accounts.get(where.id);
      if (!acc) throw new Error(`no account ${where.id}`);
      return { ...acc };
    },
    findMany: async ({ where, orderBy, take }: FindManyAccountsArgs) => {
      let rows = [...accounts.values()];
      if (where?.guildId !== undefined) rows = rows.filter((a) => a.guildId === where.guildId);
      if (where?.id !== undefined) rows = rows.filter((a) => where.id!.in.includes(a.id));
      if (orderBy?.balance === 'desc') rows = [...rows].sort((a, b) => (a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0));
      if (take !== undefined) rows = rows.slice(0, take);
      return rows.map((r) => ({ ...r }));
    },
  };

  const economyTransaction = {
    create: async ({ data }: { data: Omit<FakeTransaction, 'id' | 'createdAt'> }) => {
      const row: FakeTransaction = { ...data, id: `tx-${++txSeq}`, createdAt: new Date() };
      transactions.push(row);
      return { ...row };
    },
    findFirst: async ({
      where,
    }: {
      where: { guildId: string; platform: 'DISCORD' | 'TWITCH'; toUserId: string; type: string };
      orderBy: { createdAt: 'desc' };
    }) => {
      const matches = transactions.filter(
        (t) => t.guildId === where.guildId && t.platform === where.platform && t.toUserId === where.toUserId && t.type === where.type,
      );
      return matches.length > 0 ? { ...matches[matches.length - 1] } : null;
    },
    groupBy: async ({ where, take }: GroupByTransactionsArgs) => {
      const matches = transactions.filter(
        (t) =>
          t.guildId === where.guildId &&
          t.platform === where.platform &&
          where.type.in.includes(t.type) &&
          t.accountId !== null,
      );
      const sums = new Map<string, bigint>();
      for (const t of matches) {
        const key = t.accountId as string;
        sums.set(key, (sums.get(key) ?? 0n) + t.amount);
      }
      let rows = [...sums.entries()].map(([accountId, amount]) => ({ accountId, _sum: { amount } }));
      rows = rows.sort((a, b) => (a._sum.amount < b._sum.amount ? 1 : a._sum.amount > b._sum.amount ? -1 : 0));
      if (take !== undefined) rows = rows.slice(0, take);
      return rows;
    },
  };

  const prisma = {
    economyAccount,
    economyTransaction,
    $transaction: async <T>(fn: (tx: { economyAccount: typeof economyAccount; economyTransaction: typeof economyTransaction }) => Promise<T>) =>
      fn({ economyAccount, economyTransaction }),
  };

  return {
    prisma: prisma as unknown as CommandContext['ctx']['prisma'],
    getAccount: (id: string) => accounts.get(id),
    getTransactions: () => transactions,
    seedTransaction: (t: Omit<FakeTransaction, 'id' | 'createdAt'> & Partial<Pick<FakeTransaction, 'id' | 'createdAt'>>) => {
      const row: FakeTransaction = { id: t.id ?? `tx-${++txSeq}`, createdAt: t.createdAt ?? new Date(), ...t };
      transactions.push(row);
      return row;
    },
  };
}
