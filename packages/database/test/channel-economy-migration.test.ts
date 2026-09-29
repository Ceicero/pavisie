import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Pure text checks (no database needed) that migration 0015 and prisma/schema.prisma agree about the channel-owned
// currency (ARCHITECTURE.md §18b/§19e), and that the hand-written carry-over data copy has the shape that keeps it
// safe: it only READS the old tables, copies balances/amounts verbatim, and never touches an old row.
//
// The copy logic itself was verified against a real Postgres engine (PGlite: all 15 migrations applied, a seeded
// scenario copied, every balance/transaction/setting asserted) when the migration was written; this file guards the
// SQL text against drifting afterwards.

const prismaDir = fileURLToPath(new URL('../prisma/', import.meta.url));
const schema = readFileSync(`${prismaDir}schema.prisma`, 'utf8');
const migrationName = '0015_channel_economy';
const sql = readFileSync(`${prismaDir}migrations/${migrationName}/migration.sql`, 'utf8');

function modelBody(name: string): string {
  const match = new RegExp(String.raw`model\s+${name}\s*\{([\s\S]*?)\n\}`).exec(schema);
  if (!match) throw new Error(`model ${name} not found`);
  return match[1];
}

/** SQL without `--` comment lines, collapsed to single-spaced statements. */
function statements(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const all = statements(sql);
const firstInsert = all.findIndex((s) => s.startsWith('INSERT'));
const schemaStatements = all.slice(0, firstInsert);
const copyStatements = all.slice(firstInsert);

describe('migration 0015 (channel-owned currency) — schema part', () => {
  it('is present and the numbering is contiguous (later migrations may follow it)', () => {
    const names = readdirSync(`${prismaDir}migrations`)
      .filter((n) => /^\d{4}_/.test(n))
      .sort();
    expect(names).toContain(migrationName);
    names.forEach((name, i) => expect(name.slice(0, 4)).toBe(String(i + 1).padStart(4, '0')));
  });

  it('contains exactly the statements Prisma generates for the schema change (before any data copy)', () => {
    expect(schemaStatements).toEqual([
      `CREATE TYPE "StreamPlatform" AS ENUM ('TWITCH')`,
      `CREATE TABLE "ChannelEconomy" ( "id" TEXT NOT NULL, "platform" "StreamPlatform" NOT NULL, "channelUserId" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false, "currencyName" TEXT NOT NULL DEFAULT 'Agis', "currencySymbol" TEXT NOT NULL DEFAULT '♦️', "dailyMinAmount" INTEGER NOT NULL DEFAULT 50, "dailyMaxAmount" INTEGER NOT NULL DEFAULT 150, "streakBonusPerDay" INTEGER NOT NULL DEFAULT 10, "streakBonusMax" INTEGER NOT NULL DEFAULT 200, "giveMinAmount" INTEGER NOT NULL DEFAULT 1, "giveMaxAmount" INTEGER NOT NULL DEFAULT 100000, "earnEnabled" BOOLEAN NOT NULL DEFAULT false, "earnPerMessage" INTEGER NOT NULL DEFAULT 5, "earnCooldownSeconds" INTEGER NOT NULL DEFAULT 60, "earnDailyCap" INTEGER NOT NULL DEFAULT 200, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ChannelEconomy_pkey" PRIMARY KEY ("id") )`,
      `CREATE TABLE "ChannelWallet" ( "id" TEXT NOT NULL, "economyId" TEXT NOT NULL, "viewerUserId" TEXT NOT NULL, "displayName" TEXT, "balance" BIGINT NOT NULL DEFAULT 0, "lastDailyAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ChannelWallet_pkey" PRIMARY KEY ("id") )`,
      `CREATE TABLE "ChannelTransaction" ( "id" TEXT NOT NULL, "economyId" TEXT NOT NULL, "walletId" TEXT, "fromUserId" TEXT, "toUserId" TEXT, "amount" BIGINT NOT NULL, "type" TEXT NOT NULL, "note" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ChannelTransaction_pkey" PRIMARY KEY ("id") )`,
      `CREATE UNIQUE INDEX "ChannelEconomy_platform_channelUserId_key" ON "ChannelEconomy"("platform", "channelUserId")`,
      `CREATE INDEX "ChannelWallet_economyId_balance_idx" ON "ChannelWallet"("economyId", "balance")`,
      `CREATE UNIQUE INDEX "ChannelWallet_economyId_viewerUserId_key" ON "ChannelWallet"("economyId", "viewerUserId")`,
      `CREATE INDEX "ChannelTransaction_economyId_createdAt_idx" ON "ChannelTransaction"("economyId", "createdAt")`,
      `CREATE INDEX "ChannelTransaction_economyId_type_idx" ON "ChannelTransaction"("economyId", "type")`,
      `CREATE INDEX "ChannelTransaction_walletId_idx" ON "ChannelTransaction"("walletId")`,
      `ALTER TABLE "ChannelWallet" ADD CONSTRAINT "ChannelWallet_economyId_fkey" FOREIGN KEY ("economyId") REFERENCES "ChannelEconomy"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      `ALTER TABLE "ChannelTransaction" ADD CONSTRAINT "ChannelTransaction_economyId_fkey" FOREIGN KEY ("economyId") REFERENCES "ChannelEconomy"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      `ALTER TABLE "ChannelTransaction" ADD CONSTRAINT "ChannelTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "ChannelWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
    ]);
  });

  it('matches the schema: StreamPlatform enum, channel-keyed models with no FK to TwitchChatChannel or Guild', () => {
    expect(schema).toMatch(/enum StreamPlatform \{\s*TWITCH\s*\}/);

    const economy = modelBody('ChannelEconomy');
    expect(economy).toMatch(/^\s*platform\s+StreamPlatform\b/m);
    expect(economy).toMatch(/^\s*channelUserId\s+String\b/m);
    expect(economy).toMatch(/@@unique\(\[platform, channelUserId\]\)/);
    // Keyed by broadcaster id, NOT a foreign key: disconnecting the chat bot must never delete a balance.
    expect(economy).not.toMatch(/TwitchChatChannel/);
    expect(economy).not.toMatch(/\bGuild\b/);
    expect(economy).toMatch(/^\s*enabled\s+Boolean\s+@default\(false\)/m);
    expect(economy).toMatch(/^\s*earnEnabled\s+Boolean\s+@default\(false\)/m);

    expect(modelBody('ChannelWallet')).toMatch(/@@unique\(\[economyId, viewerUserId\]\)/);
    expect(modelBody('ChannelWallet')).toMatch(/^\s*balance\s+BigInt\s+@default\(0\)/m);
    expect(modelBody('ChannelTransaction')).toMatch(/^\s*amount\s+BigInt\b/m);
    // No model in the channel economy can be pointed at a guild.
    for (const name of ['ChannelEconomy', 'ChannelWallet', 'ChannelTransaction']) {
      expect(modelBody(name), name).not.toMatch(/guildId/);
    }
  });

  it("the column defaults equal the guild economy plugin's defaults (Agis, 50-150, streak 10/200, give 1-100000, earn 5/60s/200)", () => {
    const economy = modelBody('ChannelEconomy');
    const defaultOf = (field: string) => new RegExp(String.raw`^\s*${field}\s+\S+\s+@default\(([^)]*)\)`, 'm').exec(economy)?.[1];
    expect(defaultOf('currencyName')).toBe('"Agis"');
    expect(defaultOf('currencySymbol')).toBe('"♦️"');
    expect(defaultOf('dailyMinAmount')).toBe('50');
    expect(defaultOf('dailyMaxAmount')).toBe('150');
    expect(defaultOf('streakBonusPerDay')).toBe('10');
    expect(defaultOf('streakBonusMax')).toBe('200');
    expect(defaultOf('giveMinAmount')).toBe('1');
    expect(defaultOf('giveMaxAmount')).toBe('100000');
    expect(defaultOf('earnPerMessage')).toBe('5');
    expect(defaultOf('earnCooldownSeconds')).toBe('60');
    expect(defaultOf('earnDailyCap')).toBe('200');
  });
});

describe('migration 0015 — carry-over data copy', () => {
  it('is exactly three INSERT ... SELECT statements, in dependency order', () => {
    expect(copyStatements).toHaveLength(3);
    expect(copyStatements[0]).toMatch(/^INSERT INTO "ChannelEconomy" \(/);
    expect(copyStatements[1]).toMatch(/^INSERT INTO "ChannelWallet" \(/);
    expect(copyStatements[2]).toMatch(/^INSERT INTO "ChannelTransaction" \(/);
    for (const stmt of copyStatements) expect(stmt).toMatch(/\) SELECT /);
  });

  it('never modifies or deletes an old row: no UPDATE/DELETE/TRUNCATE/DROP/ALTER, and every INSERT targets a new table', () => {
    const withoutComments = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(withoutComments).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(withoutComments).not.toMatch(/^\s*UPDATE\s+"/im);
    expect(withoutComments).not.toMatch(/\bTRUNCATE\b/i);
    expect(withoutComments).not.toMatch(/\bDROP\b/i);
    // The only ALTERs are the new tables' own foreign keys.
    for (const stmt of all.filter((s) => s.startsWith('ALTER'))) {
      expect(stmt).toMatch(/^ALTER TABLE "Channel(Wallet|Transaction)" ADD CONSTRAINT /);
    }
    for (const stmt of all.filter((s) => s.startsWith('INSERT'))) {
      expect(stmt).toMatch(/^INSERT INTO "Channel(Economy|Wallet|Transaction)"/);
    }
  });

  it('documents that the old rows are kept until a later phase', () => {
    expect(sql).toMatch(/deliberately NOT modified or deleted/i);
    expect(sql).toMatch(/dropped in a later phase/i);
  });

  it('only guild-linked channels are copied (guildless ones never had a wallet)', () => {
    for (const stmt of copyStatements) expect(stmt).toContain('c."guildId" IS NOT NULL');
  });

  it('copies wallets from TWITCH accounts of the channel\'s guild, balances/timestamps verbatim (no aggregation)', () => {
    const wallet = copyStatements[1];
    expect(wallet).toContain(`a."guildId" = c."guildId" AND a."platform" = 'TWITCH'`);
    for (const column of ['a."userId"', 'a."displayName"', 'a."balance"', 'a."lastDailyAt"', 'a."createdAt"', 'a."updatedAt"']) {
      expect(wallet).toContain(column);
    }
    expect(wallet).not.toMatch(/\b(SUM|COUNT|AVG|MAX|MIN|GROUP BY)\b/i);
  });

  it('copies transactions of TWITCH platform for the channel\'s guild verbatim, remapping the account to the copied wallet', () => {
    const tx = copyStatements[2];
    expect(tx).toContain(`t."guildId" = c."guildId" AND t."platform" = 'TWITCH'`);
    for (const column of ['t."fromUserId"', 't."toUserId"', 't."amount"', 't."type"', 't."note"', 't."createdAt"']) {
      expect(tx).toContain(column);
    }
    // Remapped only when the source account is one of the copied Twitch accounts of the same guild; otherwise NULL.
    expect(tx).toContain(`a."id" = t."accountId" AND a."guildId" = t."guildId" AND a."platform" = 'TWITCH'`);
    expect(tx).toContain(`CASE WHEN a."id" IS NULL THEN NULL ELSE 'cw_' || c."id" || '_' || a."id" END`);
    expect(tx).not.toMatch(/\b(SUM|COUNT|AVG|MAX|MIN|GROUP BY)\b/i);
  });

  it("wallet ids the transactions point at are built exactly like the wallet insert builds them", () => {
    expect(copyStatements[1]).toContain(`'cw_' || c."id" || '_' || a."id"`);
    expect(copyStatements[2]).toContain(`'cw_' || c."id" || '_' || a."id"`);
    expect(copyStatements[0]).toContain(`'ce_' || c."id"`);
    expect(copyStatements[1]).toContain(`'ce_' || c."id"`);
    expect(copyStatements[2]).toContain(`'ce_' || c."id"`);
  });

  it('the economy is enabled only if the guild had twitchEnabled AND the economy plugin enabled', () => {
    const economy = copyStatements[0];
    expect(economy).toContain(`pc."config" -> 'twitchEnabled' = 'true'::jsonb`);
    expect(economy).toContain('COALESCE(ps."enabled", false)');
    expect(economy).toContain(`pc."pluginId" = 'economy'`);
    expect(economy).toContain(`ps."pluginId" = 'economy'`);
  });

  it('reads every setting from the guild economy config with a type check and a default fallback', () => {
    const economy = copyStatements[0];
    const keys = [
      'currencyName',
      'currencySymbol',
      'dailyMinAmount',
      'dailyMaxAmount',
      'streakBonusPerDay',
      'streakBonusMax',
      'giveMinAmount',
      'giveMaxAmount',
      'twitchEarnEnabled',
      'twitchEarnPerMessage',
      'twitchEarnCooldownSeconds',
      'twitchEarnDailyCap',
    ];
    for (const key of keys) expect(economy, key).toContain(`'${key}'`);

    // Fallbacks (the ELSE branches) in column order: the plugin's defaults.
    const fallbacks = [...economy.matchAll(/ELSE ('[^']*'|\d+) END/g)].map((m) => m[1]);
    expect(fallbacks).toEqual([`'Agis'`, `'♦️'`, '50', '150', '10', '200', '1', '100000', '5', '60', '200']);

    // Numbers are clamped to the same bounds the plugin's zod schema enforces (in column order).
    const clamps = [...economy.matchAll(/LEAST\(GREATEST\(round\(\([^)]*\)::numeric\), (\d+)\), (\d+)\)::int/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(clamps).toEqual([
      [0, 1_000_000],
      [0, 1_000_000],
      [0, 10_000],
      [0, 1_000_000],
      [1, 1_000_000_000],
      [1, 1_000_000_000],
      [1, 1000],
      [10, 3600],
      [0, 1_000_000],
    ]);
  });
});
