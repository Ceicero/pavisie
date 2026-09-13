import { ChannelType, PermissionFlagsBits, PermissionsBitField, type Guild } from 'discord.js';
import type { PluginContext } from '../../sdk';

export const GUILD_ID = '111111111111111111';
export const CHANNEL_ID = '222222222222222222';
export const EVERYONE_ROLE_ID = GUILD_ID; // Discord's @everyone role id is the guild id.
export const BOT_ID = '333333333333333333';

/** The bot's guild-level permissions in these fakes: the least-privilege invite set, never Administrator. */
const BOT_BASE_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles;

interface OverwriteBits {
  allow: bigint;
  deny: bigint;
}

type OverwriteTarget = string | { id: string };

function targetId(target: OverwriteTarget): string {
  return typeof target === 'string' ? target : target.id;
}

/**
 * A guild text channel that resolves permissions the way Discord actually does — the `@everyone` channel
 * overwrite applies to the bot too, and only a member overwrite can win it back. A mock that always answers
 * "yes, the bot may send here" cannot see the lock/unlock defect at all, which is the point of doing it this
 * way rather than stubbing `permissionsFor`.
 */
export class FakeTextChannel {
  readonly id = CHANNEL_ID;
  readonly type = ChannelType.GuildText;
  readonly overwrites = new Map<string, OverwriteBits>();
  readonly sent: unknown[] = [];
  rateLimitPerUser = 0;
  guild!: Guild;

  isTextBased(): boolean {
    return true;
  }

  /** Seeds an overwrite directly, as if a human (or hub-setup) had written it in Discord. */
  seedOverwrite(id: string, bits: Partial<OverwriteBits>): void {
    this.overwrites.set(id, { allow: bits.allow ?? 0n, deny: bits.deny ?? 0n });
  }

  permissionsFor(member: { id: string }): PermissionsBitField {
    let bits = BOT_BASE_PERMISSIONS;
    const everyone = this.overwrites.get(EVERYONE_ROLE_ID);
    if (everyone) {
      bits = (bits & ~everyone.deny) | everyone.allow;
    }
    const own = this.overwrites.get(member.id);
    if (own) {
      bits = (bits & ~own.deny) | own.allow;
    }
    return new PermissionsBitField(bits);
  }

  private readonly editOverwrite = async (
    target: OverwriteTarget,
    options: Record<string, boolean | null>,
  ): Promise<void> => {
    const id = targetId(target);
    const current = this.overwrites.get(id) ?? { allow: 0n, deny: 0n };
    for (const [name, value] of Object.entries(options)) {
      const bit = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
      if (value === true) {
        current.allow |= bit;
        current.deny &= ~bit;
      } else if (value === false) {
        current.deny |= bit;
        current.allow &= ~bit;
      } else {
        current.allow &= ~bit;
        current.deny &= ~bit;
      }
    }
    this.overwrites.set(id, current);
  };

  private readonly deleteOverwrite = async (target: OverwriteTarget): Promise<void> => {
    this.overwrites.delete(targetId(target));
  };

  get permissionOverwrites() {
    const cache = new Map(
      [...this.overwrites].map(([id, bits]) => [
        id,
        { id, allow: new PermissionsBitField(bits.allow), deny: new PermissionsBitField(bits.deny) },
      ]),
    );
    return { cache, edit: this.editOverwrite, delete: this.deleteOverwrite };
  }

  async setRateLimitPerUser(seconds: number): Promise<void> {
    this.rateLimitPerUser = seconds;
  }

  async send(payload: unknown): Promise<{ id: string }> {
    this.sent.push(payload);
    return { id: 'message-1' };
  }

  /** True when the bot itself may still talk here (what `lock` must never take away from itself). */
  botCanSend(): boolean {
    return this.permissionsFor({ id: BOT_ID }).has(PermissionFlagsBits.SendMessages);
  }
}

/** Builds a one-channel guild whose `members.me` is a plain (non-Administrator) bot member. */
export function createFakeGuild(): { guild: Guild; channel: FakeTextChannel } {
  const channel = new FakeTextChannel();
  const guild = {
    id: GUILD_ID,
    name: 'Test Guild',
    members: { me: { id: BOT_ID }, fetch: async () => ({ id: BOT_ID }) },
    roles: { everyone: { id: EVERYONE_ROLE_ID } },
    channels: {
      fetch: async (id: string) => (id === channel.id ? channel : null),
      resolve: (id: string) => (id === channel.id ? channel : null),
    },
  } as unknown as Guild;
  channel.guild = guild;
  return { guild, channel };
}

/**
 * Minimal `PrismaClient` surface for `createCase`: `withNextCaseNumber` (@pavisie/database) calls
 * `prisma.$transaction(cb)` directly, which the SDK's generic `createPrismaStub` proxy can't represent.
 */
export function createCasePrisma(caseId = 'ckcase00000000000000000001'): {
  prisma: PluginContext['prisma'];
  rows: Record<string, unknown>[];
} {
  const rows: Record<string, unknown>[] = [];
  let maxCaseNumber = 0;

  const moderationCase = {
    aggregate: async () => ({ _max: { caseNumber: maxCaseNumber } }),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      maxCaseNumber = Math.max(maxCaseNumber, data.caseNumber as number);
      const row = {
        id: caseId,
        expiredAt: null,
        dmSent: false,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      rows.push(row);
      return row;
    },
    update: async () => undefined,
    updateMany: async () => ({ count: 0 }),
  };

  const prisma = {
    moderationCase,
    $transaction: async (cb: (tx: unknown) => unknown) => cb({ moderationCase }),
  };

  return { prisma: prisma as unknown as PluginContext['prisma'], rows };
}
