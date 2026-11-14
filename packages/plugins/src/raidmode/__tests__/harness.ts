// Test harness for raid mode: an in-memory database with all-or-nothing transactions (so "state change and its
// audit row in one transaction" is observable), a guild whose channels resolve permissions like Discord, and a
// queue that records update jobs instead of running them.
import {
  ChannelType,
  GuildVerificationLevel,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
} from 'discord.js';
import type { PluginContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { configSchema, type RaidModeConfig } from '../manifest';
import type { UpdateJobData } from '../incident';

type Row = Record<string, unknown>;

export const BOT_ID = '900000000000000001';
export const ADMIN_ID = '900000000000000002';
export const ALERT_CHANNEL_ID = '900000000000000003';

interface OverwriteBits {
  allow: bigint;
  deny: bigint;
}

const BOT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageGuild;

/** A text channel whose overwrites behave like Discord's: per-flag allow / deny / unset. */
export class FakeChannel {
  readonly type = ChannelType.GuildText;
  readonly overwrites = new Map<string, OverwriteBits>();
  readonly sent: unknown[] = [];
  readonly edits: unknown[] = [];
  failEdits = false;
  constructor(readonly id: string) {}

  isThread(): boolean {
    return false;
  }
  isTextBased(): boolean {
    return true;
  }
  permissionsFor(): PermissionsBitField {
    return new PermissionsBitField(BOT_PERMISSIONS);
  }
  get permissionOverwrites() {
    const cache = new Map(
      [...this.overwrites].map(([id, bits]) => [
        id,
        { id, allow: new PermissionsBitField(bits.allow), deny: new PermissionsBitField(bits.deny) },
      ]),
    );
    return {
      cache,
      edit: async (target: string | { id: string }, options: Record<string, boolean | null>) => {
        if (this.failEdits) throw new Error('Missing Permissions');
        const id = typeof target === 'string' ? target : target.id;
        const current = this.overwrites.get(id) ?? { allow: 0n, deny: 0n };
        for (const [name, value] of Object.entries(options)) {
          const bit = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
          current.allow &= ~bit;
          current.deny &= ~bit;
          if (value === true) current.allow |= bit;
          if (value === false) current.deny |= bit;
        }
        this.overwrites.set(id, current);
      },
      delete: async (target: string | { id: string }) => {
        this.overwrites.delete(typeof target === 'string' ? target : target.id);
      },
    };
  }
  get messages() {
    return {
      edit: async (_id: string, payload: unknown) => {
        this.edits.push(payload);
      },
    };
  }
  async send(payload: unknown) {
    this.sent.push(payload);
    return { id: `msg-${this.sent.length}` };
  }
}

/** In-memory raid mode tables. `$transaction` keeps changes only when the callback resolves. */
export class FakeDb {
  incidents: Row[] = [];
  changes: Row[] = [];
  scores: Row[] = [];
  audits: Row[] = [];
  failAudit = false;
  private seq = 0;

  private matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
        const v = value as Row;
        if ('in' in v) return (v.in as unknown[]).includes(row[key]);
        if ('lt' in v) return (row[key] as Date | null) !== null && (row[key] as Date) < (v.lt as Date);
        if ('gte' in v) return (row[key] as number) >= (v.gte as number);
        if ('some' in v) return this.scores.some((s) => s.incidentId === row.id);
      }
      return row[key] === value;
    });
  }

  private delegates(t: { incidents: Row[]; changes: Row[]; scores: Row[]; audits: Row[] }) {
    const id = (prefix: string) => `${prefix}-${++this.seq}`;
    return {
      raidModeIncident: {
        create: async ({ data }: { data: Row }) => {
          const row = {
            status: 'ACTIVE',
            endedAt: null,
            riskLow: 0,
            riskMedium: 0,
            riskHigh: 0,
            lockdownState: 'NONE',
            lockdownActions: [],
            lockdownAppliedAt: null,
            lockdownAppliedBy: null,
            lockdownRestoredAt: null,
            lockdownRestoredBy: null,
            reminderSentAt: null,
            alertChannelId: null,
            alertMessageId: null,
            ...data,
          };
          t.incidents.push(row);
          return { ...row };
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          const row = t.incidents.find((r) => r.id === where.id);
          if (!row) throw new Error('incident not found');
          Object.assign(row, data);
          return { ...row };
        },
        findUnique: async ({ where }: { where: { id: string } }) => {
          const row = t.incidents.find((r) => r.id === where.id);
          return row ? { ...row } : null;
        },
        findFirst: async ({ where }: { where: Row }) => {
          const rows = t.incidents.filter((r) => this.matches(r, where));
          return rows.length ? { ...rows[rows.length - 1] } : null;
        },
        findMany: async ({ where }: { where: Row }) => t.incidents.filter((r) => this.matches(r, where)),
      },
      raidModeLockdownChange: {
        create: async ({ data }: { data: Row }) => {
          const row = { id: id('change'), restoreSkippedReason: null, ...data };
          t.changes.push(row);
          return { ...row };
        },
        delete: async ({ where }: { where: { id: string } }) => {
          t.changes.splice(
            t.changes.findIndex((r) => r.id === where.id),
            1,
          );
        },
        deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          const before = t.changes.length;
          for (let i = t.changes.length - 1; i >= 0; i -= 1) {
            if (where.id.in.includes(t.changes[i]!.id as string)) t.changes.splice(i, 1);
          }
          return { count: before - t.changes.length };
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          const row = t.changes.find((r) => r.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        },
        findMany: async ({ where }: { where: Row }) =>
          t.changes.filter((r) => this.matches(r, where)).map((r) => ({ ...r })),
      },
      raidModeRiskScore: {
        createMany: async ({ data }: { data: Row[] }) => {
          let count = 0;
          for (const d of data) {
            if (t.scores.some((s) => s.incidentId === d.incidentId && s.userId === d.userId)) continue;
            t.scores.push({ id: id('score'), ...d });
            count += 1;
          }
          return { count };
        },
        deleteMany: async ({ where }: { where: { incidentId: { in: string[] } } }) => {
          const before = t.scores.length;
          t.scores = t.scores.filter((s) => !where.incidentId.in.includes(s.incidentId as string));
          return { count: before - t.scores.length };
        },
      },
      auditLog: {
        create: async ({ data }: { data: Row }) => {
          if (this.failAudit) throw new Error('audit insert failed');
          t.audits.push(data);
          return data;
        },
      },
    };
  }

  get prisma(): PluginContext['prisma'] {
    return {
      ...this.delegates(this),
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
        const staged = {
          incidents: this.incidents.map((r) => ({ ...r })),
          changes: this.changes.map((r) => ({ ...r })),
          scores: this.scores.map((r) => ({ ...r })),
          audits: [...this.audits],
        };
        const result = await cb(this.delegates(staged));
        Object.assign(this, staged);
        return result;
      },
    } as unknown as PluginContext['prisma'];
  }
}

export interface HarnessOptions {
  config?: Partial<RaidModeConfig>;
  channels?: number;
  verificationLevel?: GuildVerificationLevel;
}

export function harness(guildId: string, options: HarnessOptions = {}) {
  const db = new FakeDb();
  const config = configSchema.parse({
    alertChannelId: ALERT_CHANNEL_ID,
    joinThreshold: 5,
    ...options.config,
  });
  const alert = new FakeChannel(ALERT_CHANNEL_ID);
  const channels = Array.from(
    { length: options.channels ?? 3 },
    (_, i) => new FakeChannel(`${guildId}-c${i}`),
  );
  const all = new Map<string, FakeChannel>([[alert.id, alert], ...channels.map((c) => [c.id, c] as const)]);
  const queued: UpdateJobData[] = [];
  const features: string[] = [];

  const guild = {
    id: guildId,
    features,
    verificationLevel: options.verificationLevel ?? GuildVerificationLevel.Low,
    roles: { everyone: { id: guildId } },
    members: { me: { id: BOT_ID, permissions: new PermissionsBitField(BOT_PERMISSIONS) } },
    channels: {
      cache: all,
      fetch: async (id: string) => all.get(id) ?? null,
    },
    async setVerificationLevel(level: GuildVerificationLevel) {
      guild.verificationLevel = level;
    },
    async disableInvites(disabled: boolean) {
      const i = features.indexOf('INVITES_DISABLED');
      if (disabled && i < 0) features.push('INVITES_DISABLED');
      if (!disabled && i >= 0) features.splice(i, 1);
    },
  };

  const { ctx, redis } = createTestContext({
    config,
    overrides: {
      prisma: db.prisma,
      client: {
        guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild },
        user: { id: BOT_ID },
      } as never,
      queue: () =>
        ({
          add: async (_name: string, data: UpdateJobData) => {
            queued.push(data);
          },
        }) as never,
    },
  });

  let n = 0;
  /** A member joining now, with an account `ageHours` old. */
  const member = (
    options: { ageHours?: number; avatar?: boolean; username?: string; bot?: boolean } = {},
  ) => {
    n += 1;
    return {
      id: `${guildId}-u${n}`,
      guild,
      user: {
        bot: options.bot ?? false,
        avatar: options.avatar ? 'abc' : null,
        username: options.username ?? `member${n}`,
        createdAt: new Date(Date.now() - (options.ageHours ?? 1) * 3_600_000),
        flags: { has: () => false },
      },
    } as never;
  };

  return {
    ctx,
    redis,
    db,
    config,
    guild: guild as unknown as Guild,
    rawGuild: guild,
    alert,
    channels,
    queued,
    member,
  };
}
