import { describe, expect, it, vi } from 'vitest';
import type { Giveaway } from '@pavisie/database';
import { createTestContext, type PrismaStubOverrides } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { cancelGiveaway } from '../actions';
import en from '../locales/en.json';
import { buildGiveawayEmbed } from '../render';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Same bundle walk the command tests use, so these assertions follow the English locale file. */
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
  if (vars) {
    for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value));
  }
  return out;
}

const GUILD_ID = 'guild-20261119-giveaway-embed';
const GIVEAWAY_ID = 'gw-guild-20261119-giveaway-embed';
const WHEN = new Date('2026-11-19T18:55:00.000Z');

function giveaway(partial: Partial<Giveaway> = {}): Giveaway {
  return {
    id: GIVEAWAY_ID,
    guildId: GUILD_ID,
    channelId: 'ch-20261119-giveaway-embed',
    messageId: 'msg-20261119-giveaway-embed',
    prize: 'Nitro',
    winnerCount: 2,
    hostId: 'host-20261119',
    endsAt: WHEN,
    ended: false,
    requiredRoleIds: [],
    minAccountAgeDays: null,
    minLevel: null,
    winnerIds: [],
    createdAt: WHEN,
    updatedAt: WHEN,
    ...partial,
  };
}

function fields(embed: ReturnType<typeof buildGiveawayEmbed>) {
  return embed.data.fields ?? [];
}

function names(embed: ReturnType<typeof buildGiveawayEmbed>): string[] {
  return fields(embed).map((field) => field.name);
}

function ageValue(embed: ReturnType<typeof buildGiveawayEmbed>): string | undefined {
  return fields(embed).find((field) => field.name === 'Min. account age')?.value;
}

describe('buildGiveawayEmbed', () => {
  it('renders the English field names', () => {
    const embed = buildGiveawayEmbed(
      giveaway({
        requiredRoleIds: ['role-1'],
        minAccountAgeDays: 14,
        minLevel: 5,
        ended: true,
        winnerIds: ['user-1'],
      }),
      3,
      realT,
    );

    expect(names(embed)).toEqual([
      'Winners',
      'Entries',
      'Ended',
      'Required role',
      'Min. account age',
      'Min. level',
      'Winners',
    ]);
    expect(fields(embed)[0]).toMatchObject({ name: 'Winners', value: '2', inline: true });
    expect(fields(embed)[1]).toMatchObject({ name: 'Entries', value: '3', inline: true });
    expect(fields(embed)[3]).toMatchObject({ name: 'Required role', value: '<@&role-1>', inline: false });
    expect(fields(embed)[4]).toMatchObject({ name: 'Min. account age', value: '14 days', inline: true });
    expect(fields(embed)[5]).toMatchObject({ name: 'Min. level', value: '5', inline: true });
    expect(fields(embed)[6]).toMatchObject({ name: 'Winners', value: '<@user-1>', inline: false });
  });

  it('says 1 day when the minimum account age is one day', () => {
    const embed = buildGiveawayEmbed(giveaway({ minAccountAgeDays: 1 }), 0, realT);
    expect(ageValue(embed)).toBe('1 day');
  });

  it('says N days when the minimum account age is not one day', () => {
    const embed = buildGiveawayEmbed(giveaway({ minAccountAgeDays: 2 }), 0, realT);
    expect(ageValue(embed)).toBe('2 days');
  });

  it('omits optional fields that are not set', () => {
    const embed = buildGiveawayEmbed(giveaway(), 0, realT);
    expect(names(embed)).toEqual(['Winners', 'Entries', 'Ends']);
  });

  it('omits a minimum account age of zero', () => {
    const embed = buildGiveawayEmbed(giveaway({ minAccountAgeDays: 0 }), 0, realT);
    expect(names(embed)).not.toContain('Min. account age');
  });

  it('keeps the no-winner line when an ended giveaway drew nobody', () => {
    const embed = buildGiveawayEmbed(giveaway({ ended: true, winnerIds: [] }), 0, realT);
    const winners = fields(embed).filter((field) => field.name === 'Winners');
    expect(winners).toHaveLength(2);
    expect(winners[1]?.value).toBe('_No eligible entries — no winner drawn._');
  });

  it('reads field names from the translator', () => {
    const embed = buildGiveawayEmbed(
      giveaway({
        requiredRoleIds: ['role-1'],
        minAccountAgeDays: 4,
        minLevel: 2,
        ended: true,
        winnerIds: ['user-1'],
      }),
      4,
      (key) => `loc:${key}`,
    );
    expect(names(embed)).toEqual([
      'loc:giveaway.embedWinners',
      'loc:giveaway.embedEntries',
      'Ended',
      'loc:giveaway.embedRequiredRole',
      'loc:giveaway.embedMinAccountAge',
      'loc:giveaway.embedMinLevel',
      'loc:giveaway.embedDrawnWinners',
    ]);
  });

  it('reads the singular and plural account-age values from the translator', () => {
    const singular = buildGiveawayEmbed(giveaway({ minAccountAgeDays: 1 }), 0, (key) => `loc:${key}`);
    const plural = buildGiveawayEmbed(giveaway({ minAccountAgeDays: 3 }), 0, (key) => `loc:${key}`);
    expect(fields(singular).find((field) => field.name === 'loc:giveaway.embedMinAccountAge')?.value).toBe(
      'loc:giveaway.embedAccountAgeDay',
    );
    expect(fields(plural).find((field) => field.name === 'loc:giveaway.embedMinAccountAge')?.value).toBe(
      'loc:giveaway.embedAccountAgeDays',
    );
  });
});

describe('cancelGiveaway note', () => {
  it('edits the post with the translated cancel note', async () => {
    const keys: string[] = [];
    const t: Translate = (key, vars) => {
      keys.push(key);
      return realT(key, vars);
    };
    const row = giveaway({ ended: true, winnerIds: [] });
    const edit = vi.fn(async () => undefined);
    const channel = {
      id: row.channelId,
      type: 0,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      messages: { fetch: vi.fn(async () => ({ edit })) },
    };
    const guild = {
      id: GUILD_ID,
      members: { me: { id: 'bot-20261119' } },
      channels: { fetch: vi.fn(async () => channel) },
    };
    const { ctx } = createTestContext({
      prismaOverrides: {
        giveaway: { update: async () => row },
      } as PrismaStubOverrides,
      overrides: {
        t,
        client: { guilds: { fetch: async () => guild } } as unknown as PluginContext['client'],
        queue: (() => ({
          add: async () => undefined,
          remove: async () => undefined,
        })) as unknown as PluginContext['queue'],
      },
    });

    await cancelGiveaway(ctx, row.id);

    expect(realT('giveaway.cancelledNote')).toBe('This giveaway was cancelled.');
    expect(keys).toContain('giveaway.cancelledNote');
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'This giveaway was cancelled.',
        components: [],
      }),
    );
  });
});
