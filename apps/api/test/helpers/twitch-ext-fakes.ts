// A stateful Prisma fake for `/twitch-ext` route tests, covering exactly the models those routes (and the
// `economy` ledger/config machinery underneath them) touch: `EconomyAccount`/`EconomyTransaction` (including a
// real, directly-callable `$transaction`), `TwitchChatChannel`, `PluginConfig`, `PluginState`. The generic
// `createPrismaStub` (`@pavisie/plugins/sdk/testing`) that `buildTestApp` normally uses can't represent
// `prisma.$transaction(async (tx) => ...)` as a callable function (every property access returns a nested
// proxy, never something you can invoke) — same reason `packages/plugins/src/economy/__tests__/fake-economy-prisma.ts`
// exists for the plugin's own ledger tests. This is that same shape, rebuilt here (not imported — that file
// lives under the plugins package's `__tests__` folder, not a real export) plus the extra models the API-layer
// routes need to resolve channel -> guild -> plugin config.

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

export interface FakeTwitchChatChannel {
  id: string;
  /** `null` = a guildless channel (set up from the creator dashboard). */
  guildId: string | null;
  broadcasterUserId: string;
  enabled: boolean;
}

export interface TwitchExtFakePrismaOptions {
  channels?: FakeTwitchChatChannel[];
  /** `true`/`false` per `(guildId, pluginId)`. Absent = manifest default (economy defaults to disabled). */
  pluginStates?: Record<string, boolean>;
  /** Raw stored config patch per `(guildId, pluginId)`, merged over the plugin's manifest defaults by
   * `GuildConfigStore.getConfig` — same as a real `PluginConfig` row. */
  pluginConfigs?: Record<string, Record<string, unknown>>;
  seedAccounts?: FakeAccount[];
  seedTransactions?: FakeTransaction[];
}

function stateKey(guildId: string, pluginId: string): string {
  return `${guildId}:${pluginId}`;
}

export function buildTwitchExtFakePrisma(options: TwitchExtFakePrismaOptions = {}) {
  const accounts = new Map((options.seedAccounts ?? []).map((a) => [a.id, { ...a }]));
  const transactions: FakeTransaction[] = (options.seedTransactions ?? []).map((t) => ({ ...t }));
  let txSeq = transactions.length;
  const channels = options.channels ?? [];
  const pluginStates = options.pluginStates ?? {};
  const pluginConfigs = options.pluginConfigs ?? {};

  function findAccount(guildId: string, platform: 'DISCORD' | 'TWITCH', userId: string): FakeAccount | undefined {
    return [...accounts.values()].find((a) => a.guildId === guildId && a.platform === platform && a.userId === userId);
  }

  const economyAccount = {
    findUnique: async ({
      where,
    }: {
      where: { guildId_platform_userId: { guildId: string; platform: 'DISCORD' | 'TWITCH'; userId: string } };
    }) => {
      const { guildId, platform, userId } = where.guildId_platform_userId;
      const found = findAccount(guildId, platform, userId);
      return found ? { ...found } : null;
    },
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
      const existing = findAccount(guildId, platform, userId);
      if (existing) {
        if (update && 'displayName' in update && update.displayName) existing.displayName = update.displayName;
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
      where: { id: string; OR?: Array<{ lastDailyAt: null } | { lastDailyAt: { lte: Date } }> };
      data: { balance?: { increment?: bigint }; lastDailyAt?: Date | null };
    }) => {
      const acc = accounts.get(where.id);
      if (!acc) return { count: 0 };
      if (where.OR) {
        const ok = where.OR.some((cond) =>
          'lastDailyAt' in cond && cond.lastDailyAt === null
            ? acc.lastDailyAt === null
            : acc.lastDailyAt !== null &&
              acc.lastDailyAt.getTime() <= (cond as { lastDailyAt: { lte: Date } }).lastDailyAt.lte.getTime(),
        );
        if (!ok) return { count: 0 };
      }
      if (data.balance?.increment !== undefined) acc.balance += data.balance.increment;
      if ('lastDailyAt' in data) acc.lastDailyAt = data.lastDailyAt ?? null;
      return { count: 1 };
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const acc = accounts.get(where.id);
      if (!acc) throw new Error(`no account ${where.id}`);
      return { ...acc };
    },
    findMany: async ({ where }: { where?: { id?: { in: string[] } } }) => {
      let rows = [...accounts.values()];
      if (where?.id !== undefined) rows = rows.filter((a) => where.id!.in.includes(a.id));
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
    }) => {
      const matches = transactions.filter(
        (t) => t.guildId === where.guildId && t.platform === where.platform && t.toUserId === where.toUserId && t.type === where.type,
      );
      return matches.length > 0 ? { ...matches[matches.length - 1] } : null;
    },
    groupBy: async ({
      where,
      take,
    }: {
      where: { guildId: string; platform: 'DISCORD' | 'TWITCH'; type: { in: readonly string[] }; accountId?: { not: null } };
      take?: number;
    }) => {
      const matches = transactions.filter(
        (t) => t.guildId === where.guildId && t.platform === where.platform && where.type.in.includes(t.type) && t.accountId !== null,
      );
      const sums = new Map<string, bigint>();
      for (const t of matches) sums.set(t.accountId as string, (sums.get(t.accountId as string) ?? 0n) + t.amount);
      let rows = [...sums.entries()].map(([accountId, amount]) => ({ accountId, _sum: { amount } }));
      rows = rows.sort((a, b) => (a._sum.amount < b._sum.amount ? 1 : a._sum.amount > b._sum.amount ? -1 : 0));
      if (take !== undefined) rows = rows.slice(0, take);
      return rows;
    },
  };

  const twitchChatChannel = {
    findFirst: async ({
      where,
    }: {
      where: { broadcasterUserId: string; enabled?: boolean };
    }) => {
      const found = channels.find(
        (c) => c.broadcasterUserId === where.broadcasterUserId && (where.enabled === undefined || c.enabled === where.enabled),
      );
      return found ? { ...found } : null;
    },
  };

  const pluginState = {
    findUnique: async ({
      where,
    }: {
      where: { guildId_pluginId: { guildId: string; pluginId: string } };
    }) => {
      const key = stateKey(where.guildId_pluginId.guildId, where.guildId_pluginId.pluginId);
      return key in pluginStates ? { enabled: pluginStates[key] } : null;
    },
  };

  const pluginConfig = {
    findUnique: async ({
      where,
    }: {
      where: { guildId_pluginId: { guildId: string; pluginId: string } };
    }) => {
      const key = stateKey(where.guildId_pluginId.guildId, where.guildId_pluginId.pluginId);
      return key in pluginConfigs ? { config: pluginConfigs[key] } : null;
    },
  };

  const prisma = {
    economyAccount,
    economyTransaction,
    twitchChatChannel,
    pluginState,
    pluginConfig,
    $transaction: async <T>(
      fn: (tx: { economyAccount: typeof economyAccount; economyTransaction: typeof economyTransaction }) => Promise<T>,
    ) => fn({ economyAccount, economyTransaction }),
  };

  return {
    // Cast: a deliberately partial fake — only the models/methods `/twitch-ext` routes actually touch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: prisma as any,
    getAccount: (id: string) => accounts.get(id),
    getTransactions: () => transactions,
  };
}
