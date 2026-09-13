import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import type { StaffLevel } from '@pavisie/types';
import { createTestContext } from '../../sdk/testing';
import type { CommandContext } from '../../sdk';
import { command as birthdayCommand } from '../commands/birthday';
import { configSchema, type CommunityConfig } from '../manifest';
import en from '../locales/en.json';

/** Looks a dotted key up in the plugin's real `en.json` with `{var}` interpolation (same stand-in used by
 * gamestats/__tests__/dbd-command.test.ts and integrations/__tests__/twitch-command.test.ts). */
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
const CALLER_ID = '111111111111111111';
const OTHER_ID = '222222222222222222';

const ENABLED_DEFAULT = configSchema.parse({ birthdays: { enabled: true } });
const ENABLED_NO_SELF_SERVICE = configSchema.parse({
  birthdays: { enabled: true, allowSelfService: false },
});
const DISABLED = configSchema.parse({ birthdays: { enabled: false } });

interface ReplyPayload {
  embeds?: EmbedBuilder[];
  ephemeral?: boolean;
}

interface FakeOptions {
  sub: string;
  integers?: Record<string, number | null>;
  users?: Record<string, { id: string } | null>;
}

function fakeInteraction(opts: FakeOptions, callerId: string) {
  const replies: ReplyPayload[] = [];
  const interaction = {
    user: { id: callerId },
    guild: { id: GUILD_ID },
    options: {
      getSubcommand: () => opts.sub,
      getInteger: (name: string, required?: boolean) => {
        const value = (opts.integers ?? {})[name] ?? null;
        if (required && value === null) throw new Error(`missing required integer option: ${name}`);
        return value;
      },
      getUser: (name: string) => (opts.users ?? {})[name] ?? null,
    },
    reply: vi.fn(async (payload: ReplyPayload) => {
      replies.push(payload);
    }),
  };
  return { interaction, replies };
}

function buildContext(
  opts: FakeOptions,
  config: CommunityConfig,
  options: {
    staffLevel?: StaffLevel;
    callerId?: string;
    testCtxOverrides?: Parameters<typeof createTestContext>[0];
  } = {},
): { c: CommandContext; replies: ReplyPayload[] } {
  const callerId = options.callerId ?? CALLER_ID;
  const { interaction, replies } = fakeInteraction(opts, callerId);
  const { ctx } = createTestContext(options.testCtxOverrides ?? {});

  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: GUILD_ID,
    staffLevel: options.staffLevel ?? 'member',
    locale: 'en-US' as never,
    t: realT,
    config: async <T>() => config as T,
  };

  return { c, replies };
}

function descriptionOf(payloads: ReplyPayload[], index = 0): string {
  return payloads[index]?.embeds?.[0]?.data.description ?? '';
}

describe('/birthday set', () => {
  it('self set works when allowSelfService is true (default)', async () => {
    const upsert = vi.fn(async (_args: unknown) => ({}));
    const audit = vi.fn(async () => undefined);
    const { c, replies } = buildContext({ sub: 'set', integers: { month: 3, day: 4 } }, ENABLED_DEFAULT, {
      testCtxOverrides: { prismaOverrides: { birthday: { upsert } }, overrides: { audit } },
    });

    await birthdayCommand.execute(c);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0]).toMatchObject({
      where: { guildId_userId: { guildId: GUILD_ID, userId: CALLER_ID } },
      update: { month: 3, day: 4, lastAnnouncedYear: null },
    });
    // Self-service sets are never audited.
    expect(audit).not.toHaveBeenCalled();
    expect(replies[0]?.ephemeral).toBe(true);
    expect(descriptionOf(replies)).toContain(realT('birthday.set', { date: '4 March' }));
  });

  it('self set is refused with the new message when allowSelfService is false', async () => {
    const upsert = vi.fn(async () => ({}));
    const { c, replies } = buildContext(
      { sub: 'set', integers: { month: 3, day: 4 } },
      ENABLED_NO_SELF_SERVICE,
      { staffLevel: 'member', testCtxOverrides: { prismaOverrides: { birthday: { upsert } } } },
    );

    await birthdayCommand.execute(c);

    expect(upsert).not.toHaveBeenCalled();
    expect(replies[0]?.ephemeral).toBe(true);
    expect(descriptionOf(replies)).toContain(realT('birthday.selfServiceDisabled'));
  });

  it('an admin can still self-set when allowSelfService is false', async () => {
    const upsert = vi.fn(async () => ({}));
    const audit = vi.fn(async () => undefined);
    const { c, replies } = buildContext(
      { sub: 'set', integers: { month: 6, day: 15 } },
      ENABLED_NO_SELF_SERVICE,
      {
        staffLevel: 'admin',
        testCtxOverrides: { prismaOverrides: { birthday: { upsert } }, overrides: { audit } },
      },
    );

    await birthdayCommand.execute(c);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(descriptionOf(replies)).toContain(realT('birthday.set', { date: '15 June' }));
    // Still a self set — never audited, even for an admin.
    expect(audit).not.toHaveBeenCalled();
  });

  it('an admin setting a birthday for another member writes the row, audits, and never puts the date in the audit payload', async () => {
    const upsertCalls: Record<string, unknown>[] = [];
    const upsert = vi.fn(async (args: unknown) => {
      upsertCalls.push(args as Record<string, unknown>);
      return {};
    });
    const audits: Record<string, unknown>[] = [];
    const audit = vi.fn(async (entry: Record<string, unknown>) => {
      audits.push(entry);
    });
    const { c, replies } = buildContext(
      { sub: 'set', integers: { month: 7, day: 20 }, users: { user: { id: OTHER_ID } } },
      ENABLED_DEFAULT,
      {
        staffLevel: 'admin',
        testCtxOverrides: { prismaOverrides: { birthday: { upsert } }, overrides: { audit } },
      },
    );

    await birthdayCommand.execute(c);

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.where).toEqual({ guildId_userId: { guildId: GUILD_ID, userId: OTHER_ID } });
    expect(upsertCalls[0]!.update).toEqual({ month: 7, day: 20, lastAnnouncedYear: null });

    expect(audits).toHaveLength(1);
    // Exact shape — proves the payload carries the target id and nothing else (no month/day anywhere in it).
    expect(audits[0]).toEqual({
      guildId: GUILD_ID,
      actorId: CALLER_ID,
      actorType: 'user',
      action: 'community.birthday.set',
      targetType: 'birthday',
      targetId: OTHER_ID,
      source: 'bot',
    });

    expect(replies[0]?.ephemeral).toBe(true);
    expect(descriptionOf(replies)).toContain(
      realT('birthday.setOther', { user: `<@${OTHER_ID}>`, date: '20 July' }),
    );
  });

  it('a non-admin trying to set a birthday for another member is refused', async () => {
    const upsert = vi.fn(async () => ({}));
    const { c } = buildContext(
      { sub: 'set', integers: { month: 1, day: 1 }, users: { user: { id: OTHER_ID } } },
      ENABLED_DEFAULT,
      { staffLevel: 'member', testCtxOverrides: { prismaOverrides: { birthday: { upsert } } } },
    );

    await expect(birthdayCommand.execute(c)).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('enabled:false blocks every set path, including an admin setting it for another member', async () => {
    const selfUpsert = vi.fn(async () => ({}));
    const { c: selfCtx, replies: selfReplies } = buildContext(
      { sub: 'set', integers: { month: 3, day: 4 } },
      DISABLED,
      { staffLevel: 'member', testCtxOverrides: { prismaOverrides: { birthday: { upsert: selfUpsert } } } },
    );
    await birthdayCommand.execute(selfCtx);
    expect(descriptionOf(selfReplies)).toContain(realT('birthday.disabled'));
    expect(selfUpsert).not.toHaveBeenCalled();

    const otherUpsert = vi.fn(async () => ({}));
    const audit = vi.fn(async () => undefined);
    const { c: adminCtx, replies: adminReplies } = buildContext(
      { sub: 'set', integers: { month: 3, day: 4 }, users: { user: { id: OTHER_ID } } },
      DISABLED,
      {
        staffLevel: 'admin',
        testCtxOverrides: { prismaOverrides: { birthday: { upsert: otherUpsert } }, overrides: { audit } },
      },
    );
    await birthdayCommand.execute(adminCtx);
    expect(descriptionOf(adminReplies)).toContain(realT('birthday.disabled'));
    expect(otherUpsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('/birthday remove', () => {
  it('remove-for-another is admin-gated and audited (self remains unaudited)', async () => {
    const nonAdminDelete = vi.fn(async () => ({ count: 1 }));
    const { c: nonAdminCtx } = buildContext(
      { sub: 'remove', users: { user: { id: OTHER_ID } } },
      ENABLED_DEFAULT,
      { staffLevel: 'member', testCtxOverrides: { prismaOverrides: { birthday: { deleteMany: nonAdminDelete } } } },
    );
    await expect(birthdayCommand.execute(nonAdminCtx)).rejects.toThrow();
    expect(nonAdminDelete).not.toHaveBeenCalled();

    const adminDelete = vi.fn(async () => ({ count: 1 }));
    const audit = vi.fn(async (_entry: unknown) => undefined);
    const { c: adminCtx, replies: adminReplies } = buildContext(
      { sub: 'remove', users: { user: { id: OTHER_ID } } },
      ENABLED_DEFAULT,
      {
        staffLevel: 'admin',
        testCtxOverrides: {
          prismaOverrides: { birthday: { deleteMany: adminDelete } },
          overrides: { audit },
        },
      },
    );
    await birthdayCommand.execute(adminCtx);
    expect(adminDelete).toHaveBeenCalledWith({ where: { guildId: GUILD_ID, userId: OTHER_ID } });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      action: 'community.birthday.remove',
      targetType: 'birthday',
      targetId: OTHER_ID,
      source: 'bot',
    });
    expect(descriptionOf(adminReplies)).toContain(
      realT('birthday.removedOther', { user: `<@${OTHER_ID}>` }),
    );
  });

  it('self remove is still unaudited and unaffected by allowSelfService when the caller is an admin', async () => {
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const audit = vi.fn(async () => undefined);
    const { c, replies } = buildContext({ sub: 'remove' }, ENABLED_NO_SELF_SERVICE, {
      staffLevel: 'admin',
      testCtxOverrides: { prismaOverrides: { birthday: { deleteMany } }, overrides: { audit } },
    });

    await birthdayCommand.execute(c);

    expect(deleteMany).toHaveBeenCalledWith({ where: { guildId: GUILD_ID, userId: CALLER_ID } });
    expect(audit).not.toHaveBeenCalled();
    expect(descriptionOf(replies)).toContain(realT('birthday.removed'));
  });

  it('self remove is refused for an ordinary member when allowSelfService is false', async () => {
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const { c, replies } = buildContext({ sub: 'remove' }, ENABLED_NO_SELF_SERVICE, {
      staffLevel: 'member',
      testCtxOverrides: { prismaOverrides: { birthday: { deleteMany } } },
    });

    await birthdayCommand.execute(c);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(descriptionOf(replies)).toContain(realT('birthday.selfServiceDisabled'));
  });
});
