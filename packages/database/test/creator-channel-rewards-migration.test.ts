import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Pure text checks (no database needed) that migration 0016 and prisma/schema.prisma agree about the creator
// dashboard's channel-point rewards (ARCHITECTURE.md §19b/§19e), and that the hand-written token move has the shape
// that keeps it safe: it moves ONLY a Twitch chat channel's broadcaster token, verbatim, and never decrypts anything.
//
// The move itself was executed against a real Postgres engine (PGlite: migrations 0001-0016 applied, a seeded
// scenario migrated) when the migration was written: a channel-linked token carrying `channel:read:redemptions`
// (with and without a refresh token/expiry) moved over byte-for-byte and left "OAuthToken"; a `channel:bot`-only
// token and a non-Twitch-chat integration's token were left alone; a guildless channel had nothing to move; deleting
// a channel cascaded to its token. This file guards the SQL text against drifting afterwards.

const prismaDir = fileURLToPath(new URL('../prisma/', import.meta.url));
const schema = readFileSync(`${prismaDir}schema.prisma`, 'utf8');
const migrationName = '0016_creator_channel_rewards';
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
const firstDml = all.findIndex((s) => s.startsWith('INSERT'));
const schemaStatements = all.slice(0, firstDml);
const dataStatements = all.slice(firstDml);

describe('migration 0016 (creator channel-point rewards) — schema part', () => {
  it('is present and the numbering is contiguous (later migrations may follow it)', () => {
    const names = readdirSync(`${prismaDir}migrations`)
      .filter((n) => /^\d{4}_/.test(n))
      .sort();
    expect(names).toContain(migrationName);
    names.forEach((name, i) => expect(name.slice(0, 4)).toBe(String(i + 1).padStart(4, '0')));
  });

  it('contains exactly the statements Prisma generates for the schema change (before the data move)', () => {
    expect(schemaStatements).toEqual([
      'ALTER TABLE "TwitchChatChannel" ADD COLUMN "ttsOpenAiKeyEnc" TEXT',
      'ALTER TABLE "TwitchChatReward" ALTER COLUMN "guildId" DROP NOT NULL',
      `CREATE TABLE "TwitchBroadcasterToken" ( "id" TEXT NOT NULL, "channelId" TEXT NOT NULL, "accessTokenEnc" TEXT NOT NULL, "refreshTokenEnc" TEXT, "scopes" TEXT[], "expiresAt" TIMESTAMP(3), "rotatedAt" TIMESTAMP(3), "status" "ConnectionStatus" NOT NULL DEFAULT 'CONNECTED', "lastError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "TwitchBroadcasterToken_pkey" PRIMARY KEY ("id") )`,
      'CREATE UNIQUE INDEX "TwitchBroadcasterToken_channelId_key" ON "TwitchBroadcasterToken"("channelId")',
      'ALTER TABLE "TwitchBroadcasterToken" ADD CONSTRAINT "TwitchBroadcasterToken_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TwitchChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    ]);
  });

  it('matches the schema: per-CHANNEL token (cascade, unique), optional reward guild, channel TTS key', () => {
    const token = modelBody('TwitchBroadcasterToken');
    expect(token).toMatch(/^\s*channelId\s+String\s+@unique/m);
    expect(token).toMatch(/onDelete: Cascade/);
    // Keyed to the channel, NOT to a Discord guild or an IntegrationConnection.
    expect(token).not.toMatch(/guildId/);
    expect(token).not.toMatch(/IntegrationConnection|connectionId/);
    expect(token).toMatch(/^\s*accessTokenEnc\s+String\b/m);
    expect(token).toMatch(/^\s*refreshTokenEnc\s+String\?/m);
    expect(token).toMatch(/^\s*status\s+ConnectionStatus\s+@default\(CONNECTED\)/m);

    expect(modelBody('TwitchChatChannel')).toMatch(/^\s*broadcasterToken\s+TwitchBroadcasterToken\?/m);
    expect(modelBody('TwitchChatChannel')).toMatch(/^\s*ttsOpenAiKeyEnc\s+String\?/m);

    const reward = modelBody('TwitchChatReward');
    expect(reward).toMatch(/^\s*guildId\s+String\?/m);
    expect(reward).toMatch(/^\s*guild\s+Guild\?/m);
    expect(reward).toMatch(/@@index\(\[guildId\]\)/);
  });
});

describe('migration 0016 — carry-over token move', () => {
  it('is one INSERT ... SELECT followed by one DELETE, in that order', () => {
    expect(dataStatements).toHaveLength(2);
    expect(dataStatements[0]).toMatch(/^INSERT INTO "TwitchBroadcasterToken" \(/);
    expect(dataStatements[0]).toMatch(/\) SELECT /);
    expect(dataStatements[1]).toMatch(/^DELETE FROM "OAuthToken" o USING "TwitchChatChannel" c WHERE /);
  });

  it("only ever touches a Twitch chat channel's token (joined via connectionId) that carries channel:read:redemptions", () => {
    for (const stmt of dataStatements) {
      expect(stmt).toContain(`o."connectionId" = c."connectionId"`);
      expect(stmt).toContain(`c."connectionId" IS NOT NULL`);
      expect(stmt).toContain(`'channel:read:redemptions' = ANY (o."scopes")`);
    }
    // The INSERT and the DELETE select exactly the same rows — nothing is deleted that was not first copied.
    const condition = (stmt: string) => /(?:WHERE) (.*)$/.exec(stmt)![1]!.replace(/^c\."connectionId" IS NOT NULL AND /, '');
    const insertCondition = condition(dataStatements[0]!);
    const deleteCondition = condition(dataStatements[1]!);
    expect(insertCondition).toContain(`'channel:read:redemptions' = ANY (o."scopes")`);
    expect(deleteCondition).toContain(`'channel:read:redemptions' = ANY (o."scopes")`);
    expect(deleteCondition).toContain(`o."connectionId" = c."connectionId"`);
  });

  it('copies the ciphertext, scopes and timestamps verbatim (no decryption, no aggregation, no re-encoding)', () => {
    const insert = dataStatements[0]!;
    for (const column of [
      'o."accessTokenEnc"',
      'o."refreshTokenEnc"',
      'o."scopes"',
      'o."expiresAt"',
      'o."rotatedAt"',
      'o."createdAt"',
      'o."updatedAt"',
    ]) {
      expect(insert).toContain(column);
    }
    expect(insert).not.toMatch(/\b(decrypt|encrypt|convert_from|pgp_|SUM|COUNT|GROUP BY)\b/i);
    // The new row is keyed to the channel; its status takes the column default (CONNECTED).
    expect(insert).toContain(`'tbt_' || c."id", c."id"`);
    expect(insert).not.toContain('"status"');
  });

  it('touches nothing but "TwitchBroadcasterToken" (insert) and "OAuthToken" (delete)', () => {
    const dml = dataStatements.join(' ');
    expect(dml).not.toMatch(/\bUPDATE\b|\bTRUNCATE\b|\bDROP\b|\bALTER\b/i);
    expect(dataStatements[0]).toMatch(/^INSERT INTO "TwitchBroadcasterToken"/);
    expect(dataStatements[1]).toMatch(/^DELETE FROM "OAuthToken"/);
    // The channel/connection rows themselves are never modified or deleted.
    expect(dml).not.toMatch(/DELETE FROM "(TwitchChatChannel|IntegrationConnection)"/);
    // The schema part contains no deletes at all.
    expect(schemaStatements.join(' ')).not.toMatch(/DELETE FROM|UPDATE "|TRUNCATE|DROP TABLE|DROP COLUMN|DROP INDEX/i);
  });

  it('documents why it MOVES rather than copies, and the rollback consequence', () => {
    expect(sql).toMatch(/MOVED/);
    expect(sql).toMatch(/rotates the refresh token on every use/i);
    expect(sql).toMatch(/Rollback note/i);
  });
});
