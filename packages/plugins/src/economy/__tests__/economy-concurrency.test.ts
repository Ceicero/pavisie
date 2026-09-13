import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import type { StaffLevel } from '@pavisie/types';
import { createTestContext } from '../../sdk/testing';
import type { CommandContext } from '../../sdk';
import { command as economyCommand } from '../commands/economy';
import { DAILY_COOLDOWN_MS } from '../service';
import en from '../locales/en.json';

/** Looks a dotted key up in the plugin's real `en.json` with `{var}` interpolation (same stand-in used by
 * community/__tests__/birthday-command.test.ts and other command-level tests). */
function realT(key: string, vars?: Record<string, string | number>): string {
  const parts = key.split('.');
  let node: unknown = en;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  if (typeof node !== 'string') return key;
  let out = node;
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

const GUILD_ID = 'guild-1';

interface FakeAccount {
  id: string;
  guildId: string;
  userId: string;
  balance: bigint;
  lastDailyAt: Date | null;
}

interface FakeTransaction {
  id: string;
  guildId: string;
  accountId: string | null;
  fromUserId?: string;
  toUserId?: string;
  amount: bigint;
  type: string;
  note?: string;
  createdAt: Date;
}

interface UpdateManyWhere {
  id: string;
  balance?: { gte: bigint };
  OR?: Array<{ lastDailyAt: null } | { lastDailyAt: { lte: Date } }>;
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
function buildFakeEconomyPrisma(seedAccounts: FakeAccount[]) {
  const accounts = new Map(seedAccounts.map((a) => [a.id, { ...a }]));
  const transactions: FakeTransaction[] = [];
  let txSeq = 0;

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
    }: {
      where: { guildId_userId: { guildId: string; userId: string } };
      create: { guildId: string; userId: string };
      update: unknown;
    }) => {
      const existing = [...accounts.values()].find(
        (a) => a.guildId === where.guildId_userId.guildId && a.userId === where.guildId_userId.userId,
      );
      if (existing) return { ...existing };
      const created: FakeAccount = {
        id: `acct-${create.guildId}-${create.userId}`,
        guildId: create.guildId,
        userId: create.userId,
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
      where: { guildId: string; toUserId: string; type: string };
      orderBy: { createdAt: 'desc' };
    }) => {
      const matches = transactions.filter(
        (t) => t.guildId === where.guildId && t.toUserId === where.toUserId && t.type === where.type,
      );
      return matches.length > 0 ? { ...matches[matches.length - 1] } : null;
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
  };
}

interface ReplyPayload {
  embeds?: EmbedBuilder[];
  ephemeral?: boolean;
}

/** `errorEmbed` renders its text as `❌ <text>`, so expected error copy has to carry the same prefix. */
function errorText(key: string, vars?: Record<string, string | number>): string {
  return `❌ ${realT(key, vars)}`;
}

function descriptionOf(payload: ReplyPayload | undefined): string {
  return payload?.embeds?.[0]?.data.description ?? '';
}

interface FakeOptions {
  group?: string;
  sub: string;
  integers?: Record<string, number | null>;
  strings?: Record<string, string | null>;
  users?: Record<string, { id: string; bot?: boolean; username?: string } | null>;
}

function buildCommandContext(
  opts: FakeOptions,
  callerId: string,
  prisma: CommandContext['ctx']['prisma'],
  config: Record<string, unknown>,
  options: { staffLevel?: StaffLevel; audit?: ReturnType<typeof vi.fn> } = {},
): { c: CommandContext; reply: () => ReplyPayload | undefined } {
  let reply: ReplyPayload | undefined;
  const interaction = {
    user: { id: callerId, username: `user-${callerId}` },
    guild: { id: GUILD_ID },
    options: {
      getSubcommandGroup: () => opts.group ?? null,
      getSubcommand: () => opts.sub,
      getInteger: (name: string, required?: boolean) => {
        const value = (opts.integers ?? {})[name] ?? null;
        if (required && value === null) throw new Error(`missing required integer option: ${name}`);
        return value;
      },
      getString: (name: string, required?: boolean) => {
        const value = (opts.strings ?? {})[name] ?? null;
        if (required && value === null) throw new Error(`missing required string option: ${name}`);
        return value;
      },
      getUser: (name: string, required?: boolean) => {
        const value = (opts.users ?? {})[name] ?? null;
        if (required && value === null) throw new Error(`missing required user option: ${name}`);
        return value;
      },
    },
    reply: vi.fn(async (payload: ReplyPayload) => {
      reply = payload;
    }),
  };

  const { ctx } = createTestContext({
    overrides: { prisma, audit: options.audit ?? (async () => undefined) },
  });

  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: GUILD_ID,
    staffLevel: options.staffLevel ?? 'member',
    locale: 'en-US' as never,
    t: realT,
    config: async <T>() => config as T,
  };

  return { c, reply: () => reply };
}

const GIVE_CONFIG = { currencyName: 'Coins', currencySymbol: '🪙', giveMinAmount: 1, giveMaxAmount: 1_000_000 };
const DAILY_CONFIG = {
  currencyName: 'Coins',
  currencySymbol: '🪙',
  dailyMinAmount: 50,
  dailyMaxAmount: 50,
  streakBonusPerDay: 0,
  streakBonusMax: 0,
};

describe('/economy give — concurrent overdraw guard (BUG 1)', () => {
  it('two concurrent gives for the full balance: exactly one succeeds, no ledger row for the loser, balance never goes negative', async () => {
    const senderId = 'sender-1';
    const targetId = 'target-1';
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-${senderId}`, guildId: GUILD_ID, userId: senderId, balance: 100n, lastDailyAt: null },
      { id: `acct-${GUILD_ID}-${targetId}`, guildId: GUILD_ID, userId: targetId, balance: 0n, lastDailyAt: null },
    ]);

    const makeCtx = () =>
      buildCommandContext(
        { sub: 'give', integers: { amount: 100 }, users: { user: { id: targetId, username: 'target' } } },
        senderId,
        prisma,
        GIVE_CONFIG,
      );

    const first = makeCtx();
    const second = makeCtx();

    await Promise.all([economyCommand.execute(first.c), economyCommand.execute(second.c)]);

    const replies = [first.reply(), second.reply()];
    const succeeded = replies.filter((r) => descriptionOf(r).includes('You gave'));
    const rejected = replies.filter((r) => descriptionOf(r) === errorText('give.insufficient_balance'));
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Balance moved by exactly one give, never negative.
    expect(getAccount(`acct-${GUILD_ID}-${senderId}`)?.balance).toBe(0n);
    expect(getAccount(`acct-${GUILD_ID}-${targetId}`)?.balance).toBe(100n);

    // Exactly one ledger row — the rejected call wrote none.
    const giveRows = getTransactions().filter((t) => t.type === 'give');
    expect(giveRows).toHaveLength(1);
    expect(giveRows[0]).toMatchObject({ fromUserId: senderId, toUserId: targetId, amount: 100n });
  });

  it('a give that would overdraw against the true (post-race) balance is rejected and writes no ledger row', async () => {
    const senderId = 'sender-2';
    const targetId = 'target-2';
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-${senderId}`, guildId: GUILD_ID, userId: senderId, balance: 50n, lastDailyAt: null },
      { id: `acct-${GUILD_ID}-${targetId}`, guildId: GUILD_ID, userId: targetId, balance: 0n, lastDailyAt: null },
    ]);

    // Both calls pass `validateGive`'s pre-check (each give of 50 <= the balance of 50 read at the top of the
    // handler), but only one can actually be honored once the transaction re-checks the real balance.
    const makeCtx = () =>
      buildCommandContext(
        { sub: 'give', integers: { amount: 50 }, users: { user: { id: targetId, username: 'target' } } },
        senderId,
        prisma,
        GIVE_CONFIG,
      );
    const first = makeCtx();
    const second = makeCtx();

    await Promise.all([economyCommand.execute(first.c), economyCommand.execute(second.c)]);

    expect(getAccount(`acct-${GUILD_ID}-${senderId}`)?.balance).toBe(0n);
    expect(getTransactions().filter((t) => t.type === 'give')).toHaveLength(1);
    const rejectedCount = [first.reply(), second.reply()].filter(
      (r) => descriptionOf(r) === errorText('give.insufficient_balance'),
    ).length;
    expect(rejectedCount).toBe(1);
  });
});

describe('/economy admin add/remove — increment-based writes (BUG 2)', () => {
  it('two sequential admin adds each move the balance by the full amount', async () => {
    const targetId = 'member-1';
    const acctId = `acct-${GUILD_ID}-${targetId}`;
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, userId: targetId, balance: 0n, lastDailyAt: null },
    ]);

    const audit = vi.fn(async (_entry: unknown) => undefined);
    const first = buildCommandContext(
      { group: 'admin', sub: 'add', integers: { amount: 100 }, users: { user: { id: targetId, username: 'member' } } },
      'admin-1',
      prisma,
      GIVE_CONFIG,
      { staffLevel: 'moderator', audit },
    );
    await economyCommand.execute(first.c);
    expect(getAccount(acctId)?.balance).toBe(100n);
    expect(audit.mock.calls[0]![0]).toMatchObject({ after: { balance: '100', amount: 100 } });

    const second = buildCommandContext(
      { group: 'admin', sub: 'add', integers: { amount: 100 }, users: { user: { id: targetId, username: 'member' } } },
      'admin-1',
      prisma,
      GIVE_CONFIG,
      { staffLevel: 'moderator', audit },
    );
    await economyCommand.execute(second.c);

    // Each add moved the balance by the full 100 — not halved, not dropped by an absolute-set race.
    expect(getAccount(acctId)?.balance).toBe(200n);
    expect(audit.mock.calls[1]![0]).toMatchObject({ after: { balance: '200', amount: 100 } });

    const addRows = getTransactions().filter((t) => t.type === 'admin_add');
    expect(addRows).toHaveLength(2);
    expect(addRows.map((r) => r.amount)).toEqual([100n, 100n]);
  });

  it('two concurrent admin removes where only one can be honored: the loser is rejected with no ledger row and the balance never goes negative', async () => {
    const targetId = 'member-2';
    const acctId = `acct-${GUILD_ID}-${targetId}`;
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, userId: targetId, balance: 100n, lastDailyAt: null },
    ]);

    const audit = vi.fn(async (_entry: unknown) => undefined);
    const makeCtx = () =>
      buildCommandContext(
        { group: 'admin', sub: 'remove', integers: { amount: 100 }, users: { user: { id: targetId, username: 'member' } } },
        'admin-2',
        prisma,
        GIVE_CONFIG,
        { staffLevel: 'moderator', audit },
      );
    const first = makeCtx();
    const second = makeCtx();

    await Promise.all([economyCommand.execute(first.c), economyCommand.execute(second.c)]);

    expect(getAccount(acctId)?.balance).toBe(0n);
    const removeRows = getTransactions().filter((t) => t.type === 'admin_remove');
    expect(removeRows).toHaveLength(1);

    const rejected = [first.reply(), second.reply()].filter(
      (r) => descriptionOf(r) === errorText('admin.wouldGoNegative'),
    );
    expect(rejected).toHaveLength(1);
    // The rejected call must not have audited a fictitious adjustment.
    expect(audit).toHaveBeenCalledTimes(1);
  });
});

describe('/economy daily — atomic cooldown claim (BUG 3)', () => {
  it('two concurrent daily claims from a fresh account: exactly one payout, one ledger row, the loser sees the cooldown message', async () => {
    const userId = 'daily-1';
    const acctId = `acct-${GUILD_ID}-${userId}`;
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, userId, balance: 0n, lastDailyAt: null },
    ]);

    const makeCtx = () => buildCommandContext({ sub: 'daily' }, userId, prisma, DAILY_CONFIG);
    const first = makeCtx();
    const second = makeCtx();

    await Promise.all([economyCommand.execute(first.c), economyCommand.execute(second.c)]);

    // Both calls read the same stale `lastDailyAt: null` before the transaction — only one may actually claim.
    expect(getAccount(acctId)?.balance).toBe(50n);
    expect(getAccount(acctId)?.lastDailyAt).not.toBeNull();
    expect(getTransactions().filter((t) => t.type === 'daily')).toHaveLength(1);

    const replies = [first.reply(), second.reply()];
    const succeeded = replies.filter((r) => descriptionOf(r).includes('You claimed'));
    const cooldown = replies.filter((r) => /already claimed today/.test(descriptionOf(r)));
    expect(succeeded).toHaveLength(1);
    expect(cooldown).toHaveLength(1);
  });

  it('a second daily claim inside the cooldown window is rejected with an accurate, freshly-computed cooldown', async () => {
    const userId = 'daily-2';
    const acctId = `acct-${GUILD_ID}-${userId}`;
    const justClaimed = new Date(Date.now() - 60_000); // 1 minute ago — well inside the 20h cooldown
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, userId, balance: 50n, lastDailyAt: justClaimed },
    ]);

    const { c, reply } = buildCommandContext({ sub: 'daily' }, userId, prisma, DAILY_CONFIG);
    await economyCommand.execute(c);

    expect(descriptionOf(reply())).toBe(
      errorText('dailyCooldown', { hours: Math.ceil(DAILY_COOLDOWN_MS / (60 * 60 * 1000)) }),
    );
    // Nothing was claimed a second time.
    expect(getAccount(acctId)?.balance).toBe(50n);
    expect(getTransactions().filter((t) => t.type === 'daily')).toHaveLength(0);
  });
});
