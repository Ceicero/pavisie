import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Pure text checks (no database needed) that migration 0014 and prisma/schema.prisma agree about the creator
// dashboard's guildless Twitch chat channels (ARCHITECTURE.md §19e). The SQL itself is byte-for-byte what
// `prisma migrate diff` emits for the schema change (verified when the migration was written); this guards
// against the two drifting apart afterwards.

const prismaDir = fileURLToPath(new URL('../prisma/', import.meta.url));
const schema = readFileSync(`${prismaDir}schema.prisma`, 'utf8');
const migrationName = '0014_creator_guildless_twitch_channels';
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

describe('migration 0014 (guildless Twitch chat channels)', () => {
  it('exists and the numbering is contiguous (later migrations may follow it)', () => {
    const names = readdirSync(`${prismaDir}migrations`)
      .filter((n) => /^\d{4}_/.test(n))
      .sort();
    expect(names).toContain(migrationName);
    names.forEach((name, i) => expect(name.slice(0, 4)).toBe(String(i + 1).padStart(4, '0')));
  });

  it('contains exactly the statements Prisma generates for the schema change', () => {
    expect(statements(sql)).toEqual([
      'DROP INDEX "TwitchChatChannel_guildId_broadcasterUserId_key"',
      'ALTER TABLE "TwitchChatChannel" ALTER COLUMN "guildId" DROP NOT NULL',
      'ALTER TABLE "TwitchChatCommand" ALTER COLUMN "guildId" DROP NOT NULL',
      'ALTER TABLE "TwitchChatTimer" ALTER COLUMN "guildId" DROP NOT NULL',
      'CREATE UNIQUE INDEX "TwitchChatChannel_broadcasterUserId_key" ON "TwitchChatChannel"("broadcasterUserId")',
    ]);
  });

  it('never deletes or rewrites existing rows (existing channels keep their guildId)', () => {
    expect(sql).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|DROP TABLE|DROP COLUMN)\b/i);
  });

  it('matches the schema: nullable guildId on channel/command/timer, global unique broadcasterUserId', () => {
    const channel = modelBody('TwitchChatChannel');
    expect(channel).toMatch(/^\s*guildId\s+String\?/m);
    expect(channel).toMatch(/^\s*guild\s+Guild\?/m);
    expect(channel).toMatch(/^\s*broadcasterUserId\s+String\s+@unique/m);
    expect(channel).not.toMatch(/@@unique\(\[guildId, broadcasterUserId\]\)/);
    // The guild-scoped indexes the Discord side relies on are still there.
    expect(channel).toMatch(/@@index\(\[guildId\]\)/);

    for (const name of ['TwitchChatCommand', 'TwitchChatTimer']) {
      const body = modelBody(name);
      expect(body, name).toMatch(/^\s*guildId\s+String\?/m);
      expect(body, name).toMatch(/^\s*guild\s+Guild\?/m);
      expect(body, name).toMatch(/@@index\(\[guildId\]\)/);
    }
  });
});
