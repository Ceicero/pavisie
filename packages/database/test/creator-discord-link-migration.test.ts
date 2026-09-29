import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Pure text checks (no database needed) that migration 0017 and prisma/schema.prisma agree about the creator
// dashboard's "connect a Discord server" audit columns (ARCHITECTURE.md §19e, phase 3). The SQL is what
// `prisma migrate diff` emits for the schema change (verified when the migration was written).

const prismaDir = fileURLToPath(new URL('../prisma/', import.meta.url));
const schema = readFileSync(`${prismaDir}schema.prisma`, 'utf8');
const migrationName = '0017_creator_discord_link';
const sql = readFileSync(`${prismaDir}migrations/${migrationName}/migration.sql`, 'utf8');

function modelBody(name: string): string {
  const match = new RegExp(String.raw`model\s+${name}\s*\{([\s\S]*?)\n\}`).exec(schema);
  if (!match) throw new Error(`model ${name} not found`);
  return match[1];
}

function statements(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

describe('migration 0017 (creator Discord link audit columns)', () => {
  it('exists and the numbering is contiguous', () => {
    const names = readdirSync(`${prismaDir}migrations`)
      .filter((n) => /^\d{4}_/.test(n))
      .sort();
    expect(names).toContain(migrationName);
    names.forEach((name, i) => expect(name.slice(0, 4)).toBe(String(i + 1).padStart(4, '0')));
  });

  it('adds exactly two nullable columns and touches no existing data', () => {
    expect(statements(sql)).toEqual([
      'ALTER TABLE "TwitchChatChannel" ADD COLUMN "discordLinkedAt" TIMESTAMP(3), ADD COLUMN "discordLinkedBy" TEXT',
    ]);
    expect(sql).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|DROP|NOT NULL)\b/i);
  });

  it('matches the schema', () => {
    const channel = modelBody('TwitchChatChannel');
    expect(channel).toMatch(/^\s*discordLinkedBy\s+String\?/m);
    expect(channel).toMatch(/^\s*discordLinkedAt\s+DateTime\?/m);
  });
});
