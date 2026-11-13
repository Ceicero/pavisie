import { ChannelType, Collection, type Guild } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { PluginContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { ModerationServiceImpl } from '../service';
import { BOT_ID, CHANNEL_ID, EVERYONE_ROLE_ID, FakeTextChannel, GUILD_ID } from './fakes';

// Audit-trail guarantee: every moderation action writes EXACTLY ONE audit row, and only when the action really
// happened — including when a Discord call or a later step fails part-way through.
//
// The database fake below has real transaction semantics (a failed transaction leaves no trace), so these tests
// can tell "written in the same transaction" apart from "written one after the other". Every Discord call and
// every step after the record (mod-log post, logging, DM, expiry job, dmSent update) can be made to fail.

const TARGET_ID = '444444444444444444';
const MODERATOR_ID = '555555555555555555';
const ROLE_ID = '666666666666666666';
const MODLOG_CHANNEL_ID = '777777777777777777';

type Row = Record<string, unknown>;

/** Names of the Discord calls (and other steps) a test can make fail. */
type FailurePoint =
  | 'timeout'
  | 'kick'
  | 'ban'
  | 'unban'
  | 'roles.add'
  | 'roles.remove'
  | 'setNickname'
  | 'overwrite.everyone'
  | 'overwrite.delete'
  | 'setRateLimit'
  | 'bulkDelete'
  | 'audit.write'
  | 'case.update'
  | 'case.updateMany'
  | 'modlog.send'
  | 'logging'
  | 'queue'
  | 'config.afterRecord'
  | 'dm';

class DiscordError extends Error {
  constructor(point: string) {
    super(`Discord API error during ${point}`);
  }
}

/**
 * In-memory tables with all-or-nothing transactions: `$transaction(cb)` runs `cb` against a copy and only keeps
 * it when `cb` resolves. That is how Postgres behaves, and it is what makes "case + audit row in one transaction"
 * observable in a unit test.
 */
class FakeDb {
  cases: Row[] = [];
  audits: Row[] = [];
  warnings: Row[] = [];
  appeals: Row[] = [];

  constructor(private readonly fail: Set<FailurePoint>) {}

  private delegates(tables: { cases: Row[]; audits: Row[]; warnings: Row[]; appeals: Row[] }) {
    const fail = this.fail;
    const matches = (row: Row, where: Row) =>
      Object.entries(where).every(([key, value]) => row[key] === value);
    return {
      moderationCase: {
        aggregate: async () => ({
          _max: {
            caseNumber: tables.cases.reduce((max, c) => Math.max(max, c.caseNumber as number), 0) || null,
          },
        }),
        create: async ({ data }: { data: Row }) => {
          const row = {
            id: `case-${data.caseNumber as number}`,
            expiredAt: null,
            dmSent: false,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          tables.cases.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          if (fail.has('case.update')) throw new Error('database unavailable');
          const row = tables.cases.find((c) => c.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          if (fail.has('case.updateMany')) throw new Error('database unavailable');
          const rows = tables.cases.filter((c) => matches(c, where));
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
        findUnique: async ({ where }: { where: { id?: string } }) =>
          tables.cases.find((c) => c.id === where.id) ?? null,
      },
      auditLog: {
        create: async ({ data }: { data: Row }) => {
          if (fail.has('audit.write')) throw new Error('audit insert failed');
          const row = { id: `audit-${tables.audits.length + 1}`, ...data };
          tables.audits.push(row);
          return row;
        },
      },
      moderationWarning: {
        create: async ({ data }: { data: Row }) => {
          const row = { id: `warning-${tables.warnings.length + 1}`, active: true, ...data };
          tables.warnings.push(row);
          return row;
        },
        count: async ({ where }: { where: Row }) => tables.warnings.filter((w) => matches(w, where)).length,
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const rows = tables.warnings.filter((w) => matches(w, where));
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
      },
      moderationAppeal: {
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          const row = tables.appeals.find((a) => a.id === where.id);
          if (!row) throw new Error('appeal not found');
          Object.assign(row, data);
          return { ...row };
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const rows = tables.appeals.filter((a) => matches(a, where));
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
        findUnique: async ({ where }: { where: { id: string } }) => {
          const row = tables.appeals.find((a) => a.id === where.id);
          return row ? { ...row } : null;
        },
      },
    };
  }

  get prisma(): PluginContext['prisma'] {
    const live = this.delegates(this);
    return {
      ...live,
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
        const copy = (rows: Row[]) => rows.map((row) => ({ ...row }));
        const staged = {
          cases: copy(this.cases),
          audits: copy(this.audits),
          warnings: copy(this.warnings),
          appeals: copy(this.appeals),
        };
        const result = await cb(this.delegates(staged)); // throws → nothing below runs → nothing is kept
        Object.assign(this, staged);
        return result;
      },
    } as unknown as PluginContext['prisma'];
  }
}

/** The text channel the channel actions run in, able to fail each Discord call it makes. */
class FailingChannel extends FakeTextChannel {
  readonly messages = {
    fetch: async () =>
      new Collection(
        ['m1', 'm2'].map((id) => [
          id,
          { id, author: { id: TARGET_ID, bot: false }, content: 'spam', createdTimestamp: Date.now() },
        ]),
      ),
  };

  constructor(private readonly fail: Set<FailurePoint>) {
    super();
  }

  override get permissionOverwrites() {
    const base = super.permissionOverwrites;
    const fail = this.fail;
    return {
      cache: base.cache,
      edit: async (target: string | { id: string }, options: Record<string, boolean | null>) => {
        const id = typeof target === 'string' ? target : target.id;
        if (id === EVERYONE_ROLE_ID && fail.has('overwrite.everyone')) throw new DiscordError('overwrite');
        return base.edit(target, options);
      },
      delete: async (target: string | { id: string }) => {
        if (fail.has('overwrite.delete')) throw new DiscordError('overwrite delete');
        return base.delete(target);
      },
    };
  }

  override async setRateLimitPerUser(seconds: number): Promise<void> {
    if (this.fail.has('setRateLimit')) throw new DiscordError('slowmode');
    return super.setRateLimitPerUser(seconds);
  }

  async bulkDelete(messages: unknown[]): Promise<Collection<string, unknown>> {
    if (this.fail.has('bulkDelete')) throw new DiscordError('bulkDelete');
    return new Collection(messages.map((m, i) => [String(i), m]));
  }
}

function harness(options: { fail?: FailurePoint[] } = {}) {
  const fail = new Set<FailurePoint>(options.fail ?? []);
  const db = new FakeDb(fail);
  const errors: string[] = [];

  const discordCall = async (point: FailurePoint) => {
    if (fail.has(point)) throw new DiscordError(point);
  };
  const user = {
    id: TARGET_ID,
    send: async () => {
      if (fail.has('dm')) throw new DiscordError('dm');
      return {};
    },
  };
  const member = {
    id: TARGET_ID,
    user,
    communicationDisabledUntilTimestamp: Date.now() + 60_000,
    timeout: () => discordCall('timeout'),
    kick: () => discordCall('kick'),
    setNickname: () => discordCall('setNickname'),
    roles: { add: () => discordCall('roles.add'), remove: () => discordCall('roles.remove') },
  };

  const channel = new FailingChannel(fail);
  const modLogChannel = {
    id: MODLOG_CHANNEL_ID,
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async () => {
      if (fail.has('modlog.send')) throw new DiscordError('mod-log post');
      return {};
    },
  };
  const guild = {
    id: GUILD_ID,
    name: 'Test Guild',
    members: {
      me: { id: BOT_ID },
      fetch: async (id: string) => (id === TARGET_ID ? member : { id: BOT_ID }),
    },
    roles: { everyone: { id: EVERYONE_ROLE_ID } },
    bans: { create: () => discordCall('ban'), remove: () => discordCall('unban') },
    channels: {
      fetch: async (id: string) =>
        id === CHANNEL_ID ? channel : id === MODLOG_CHANNEL_ID ? modLogChannel : null,
    },
  } as unknown as Guild;
  channel.guild = guild;

  const client = {
    guilds: { fetch: async () => guild, cache: new Map([[GUILD_ID, guild]]) },
    users: { fetch: async () => user },
    user: { id: BOT_ID },
  } as unknown as PluginContext['client'];

  const { ctx, services } = createTestContext({
    overrides: {
      prisma: db.prisma,
      client,
      // The host's `ctx.audit` writes to the same AuditLog table (bot host: `writeAudit(prisma, entry)`), outside
      // any transaction. Routed into the fake table so any audit path the service uses is counted.
      audit: async (entry: Row) => {
        await (
          db.prisma as unknown as { auditLog: { create: (a: { data: Row }) => Promise<unknown> } }
        ).auditLog.create({ data: entry });
      },
      // Config is read before the record (DM gating for kick/ban) and after it (DM gating inside createCase).
      // `config.afterRecord` makes only the read after the record fail.
      getConfig: (async () => {
        if (fail.has('config.afterRecord') && db.cases.length > 0) throw new Error('redis unavailable');
        return { modLogChannelId: MODLOG_CHANNEL_ID, dmOnAction: true, escalations: [] };
      }) as never,
      queue: () =>
        ({
          add: async () => {
            if (fail.has('queue')) throw new Error('queue unavailable');
            return {};
          },
        }) as never,
      logger: {
        error: (_obj: unknown, msg: string) => errors.push(msg),
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
      } as never,
    },
  });
  services.register('logging', {
    log: async () => {
      if (fail.has('logging')) throw new Error('logging unavailable');
    },
  } as never);

  return { service: new ModerationServiceImpl(ctx), db, channel, errors };
}

const base = {
  guildId: GUILD_ID,
  targetId: TARGET_ID,
  moderatorId: MODERATOR_ID,
  reason: 'audit trail test',
  source: 'BOT',
} as const;
const channelBase = {
  guildId: GUILD_ID,
  channelId: CHANNEL_ID,
  moderatorId: MODERATOR_ID,
  source: 'BOT',
} as const;

interface ActionCase {
  name: string;
  caseType: string;
  /** The Discord call that carries out the action; null when the action makes none. */
  discord: FailurePoint | null;
  run: (service: ModerationServiceImpl) => Promise<unknown>;
}

const ACTIONS: ActionCase[] = [
  { name: 'warn', caseType: 'WARN', discord: null, run: (s) => s.warn(base) },
  {
    name: 'timeout',
    caseType: 'TIMEOUT',
    discord: 'timeout',
    run: (s) => s.timeout({ ...base, durationMs: 60_000 }),
  },
  { name: 'untimeout', caseType: 'UNTIMEOUT', discord: 'timeout', run: (s) => s.untimeout(base) },
  { name: 'kick', caseType: 'KICK', discord: 'kick', run: (s) => s.kick(base) },
  { name: 'ban', caseType: 'BAN', discord: 'ban', run: (s) => s.ban({ ...base, durationMs: 3_600_000 }) },
  { name: 'softban', caseType: 'SOFTBAN', discord: 'ban', run: (s) => s.softban(base) },
  { name: 'unban', caseType: 'UNBAN', discord: 'unban', run: (s) => s.unban(base) },
  {
    name: 'nick',
    caseType: 'NICK',
    discord: 'setNickname',
    run: (s) => s.nick({ ...base, nickname: 'calm' }),
  },
  {
    name: 'role add',
    caseType: 'ROLE_ADD',
    discord: 'roles.add',
    run: (s) => s.roleAction({ ...base, roleId: ROLE_ID }),
  },
  {
    name: 'role remove',
    caseType: 'ROLE_REMOVE',
    discord: 'roles.remove',
    run: (s) => s.roleAction({ ...base, roleId: ROLE_ID, remove: true }),
  },
  { name: 'lock', caseType: 'LOCK', discord: 'overwrite.everyone', run: (s) => s.lock(channelBase) },
  { name: 'unlock', caseType: 'UNLOCK', discord: 'overwrite.everyone', run: (s) => s.unlock(channelBase) },
  {
    name: 'slowmode',
    caseType: 'SLOWMODE',
    discord: 'setRateLimit',
    run: (s) => s.slowmode({ ...channelBase, seconds: 30 }),
  },
  {
    name: 'purge',
    caseType: 'PURGE',
    discord: 'bulkDelete',
    run: (s) => s.purge({ ...channelBase, count: 10 }),
  },
];
const DISCORD_ACTIONS = ACTIONS.filter((a) => a.discord !== null);

/** The invariant itself: one audit row per case, pointing at it, and none without a case. */
function expectOneAuditPerCase(db: FakeDb): void {
  expect(db.audits).toHaveLength(db.cases.length);
  for (const row of db.cases) {
    const audits = db.audits.filter((a) => a.targetId === row.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'moderation.case.create', targetType: 'moderation_case' });
  }
}

describe('audit trail: one audit row per moderation action', () => {
  it.each(ACTIONS)('$name writes one case and one audit row', async (action) => {
    const h = harness();

    await action.run(h.service);

    expect(h.db.cases).toHaveLength(1);
    expect(h.db.cases[0]?.type).toBe(action.caseType);
    expectOneAuditPerCase(h.db);
  });

  it.each(DISCORD_ACTIONS)('$name writes nothing when its Discord call fails', async (action) => {
    const h = harness({ fail: [action.discord!] });

    await expect(action.run(h.service)).rejects.toThrow();

    // Nothing happened on Discord, so there is nothing to record.
    expect(h.db.cases).toHaveLength(0);
    expect(h.db.audits).toHaveLength(0);
  });

  it.each(ACTIONS)('$name keeps its one audit row when every step after the record fails', async (action) => {
    const h = harness({
      fail: ['modlog.send', 'logging', 'queue', 'config.afterRecord', 'dm', 'case.update'],
    });

    await action.run(h.service);

    expect(h.db.cases).toHaveLength(1);
    expectOneAuditPerCase(h.db);
  });

  it.each(ACTIONS)('$name leaves no case behind when its audit row cannot be written', async (action) => {
    const h = harness({ fail: ['audit.write'] });

    await expect(action.run(h.service)).rejects.toThrow('audit insert failed');

    // Same transaction: the case is rolled back with the audit row, never left without one.
    expect(h.db.cases).toHaveLength(0);
    expect(h.db.audits).toHaveLength(0);
    if (action.discord) {
      expect(h.errors).toContain(
        'moderation: action was applied on Discord but its case and audit row could not be written',
      );
    }
  });
});

describe('audit trail: Discord fails part-way through', () => {
  it('softban: the ban lands but the unban fails — recorded once, as the BAN it now is', async () => {
    const h = harness({ fail: ['unban'] });

    await expect(h.service.softban(base)).rejects.toThrow(/still banned \(case #1\)/);

    expect(h.db.cases).toHaveLength(1);
    expect(h.db.cases[0]).toMatchObject({
      type: 'BAN',
      metadata: { softban: true, softbanUnbanFailed: true },
    });
    expectOneAuditPerCase(h.db);
  });

  it('unlock: the channel is unlocked but the bot cannot drop its own overwrite — still recorded once', async () => {
    const h = harness();
    await h.service.lock(channelBase);
    h.db.cases.length = 0;
    h.db.audits.length = 0;

    const failing = harness({ fail: ['overwrite.delete'] });
    // Same channel state as after the lock above: @everyone denied, the bot's own allow in place.
    for (const [id, bits] of h.channel.overwrites) failing.channel.overwrites.set(id, { ...bits });

    await failing.service.unlock(channelBase);

    expect(failing.db.cases.map((c) => c.type)).toEqual(['UNLOCK']);
    expectOneAuditPerCase(failing.db);
  });

  it.each([
    ['untimeout', (s: ModerationServiceImpl) => s.untimeout(base)],
    ['unban', (s: ModerationServiceImpl) => s.unban(base)],
  ] as const)(
    '%s: Discord succeeds but marking the old case expired fails — still recorded once',
    async (_name, run) => {
      const h = harness({ fail: ['case.updateMany'] });

      await run(h.service);

      expect(h.db.cases).toHaveLength(1);
      expectOneAuditPerCase(h.db);
    },
  );

  it('a run of mixed actions keeps exactly one audit row per case', async () => {
    const h = harness();
    for (const action of ACTIONS) await action.run(h.service);

    expect(h.db.cases).toHaveLength(ACTIONS.length);
    expectOneAuditPerCase(h.db);
  });
});

describe('audit trail: warnings and appeals', () => {
  function seedWarnings(db: FakeDb, count: number): void {
    for (let i = 0; i < count; i += 1) {
      db.warnings.push({ id: `seed-${i}`, guildId: GUILD_ID, userId: TARGET_ID, active: true });
    }
  }

  it('clearing warnings writes one audit row, and none when nothing was cleared', async () => {
    const h = harness();
    seedWarnings(h.db, 2);

    expect(await h.service.clearWarnings(GUILD_ID, TARGET_ID, MODERATOR_ID)).toBe(2);
    expect(await h.service.clearWarnings(GUILD_ID, TARGET_ID, MODERATOR_ID)).toBe(0);

    expect(h.db.audits).toHaveLength(1);
    expect(h.db.audits[0]).toMatchObject({
      action: 'moderation.warning.clear',
      targetType: 'user',
      targetId: TARGET_ID,
      actorId: MODERATOR_ID,
      after: { cleared: 2, warningId: null },
    });
  });

  it('clearing warnings changes nothing when the audit row cannot be written', async () => {
    const h = harness({ fail: ['audit.write'] });
    seedWarnings(h.db, 2);

    await expect(h.service.clearWarnings(GUILD_ID, TARGET_ID, MODERATOR_ID)).rejects.toThrow();

    expect(h.db.warnings.every((w) => w.active === true)).toBe(true);
    expect(h.db.audits).toHaveLength(0);
  });

  function seedAppeal(db: FakeDb): void {
    db.cases.push({ id: 'case-1', guildId: GUILD_ID, caseNumber: 1, type: 'TIMEOUT', targetId: TARGET_ID });
    db.audits.push({ id: 'audit-seed', targetId: 'case-1', action: 'moderation.case.create' });
    db.appeals.push({
      id: 'appeal-1',
      guildId: GUILD_ID,
      caseId: 'case-1',
      userId: TARGET_ID,
      status: 'PENDING',
    });
  }

  it('an appeal decision keeps its one audit row when the Discord-side effects fail', async () => {
    const h = harness({ fail: ['dm', 'timeout'] });
    seedAppeal(h.db);

    await h.service.decideAppeal({
      guildId: GUILD_ID,
      appealId: 'appeal-1',
      reviewerId: MODERATOR_ID,
      accept: true,
    });

    const decisionAudits = h.db.audits.filter((a) => a.targetId === 'appeal-1');
    expect(decisionAudits).toHaveLength(1);
    expect(decisionAudits[0]).toMatchObject({ action: 'moderation.appeal.approve' });
    expect(h.db.appeals[0]?.status).toBe('ACCEPTED');
  });

  it('an appeal decision is not saved when its audit row cannot be written', async () => {
    const h = harness({ fail: ['audit.write'] });
    seedAppeal(h.db);

    await expect(
      h.service.decideAppeal({
        guildId: GUILD_ID,
        appealId: 'appeal-1',
        reviewerId: MODERATOR_ID,
        accept: false,
      }),
    ).rejects.toThrow();

    expect(h.db.appeals[0]?.status).toBe('PENDING');
    expect(h.db.audits.filter((a) => a.targetId === 'appeal-1')).toHaveLength(0);
  });
});
