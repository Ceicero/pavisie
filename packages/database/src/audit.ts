import type { ActorType, AuditLog, AuditSource, Prisma, PrismaClient } from '@prisma/client';

const SENSITIVE_KEY_PATTERN = /token|secret|password|key$/i;

/** Recursively strips keys that look like tokens/secrets/passwords/keys before an object is persisted to the audit log. */
export function redactForAudit<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactForAudit(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactForAudit(val);
      }
    }
    return out as T;
  }
  return value;
}

export type AuditActorType = 'user' | 'system';
export type AuditWriteSource = 'bot' | 'dashboard' | 'system';

export interface WriteAuditInput {
  guildId: string;
  actorId: string;
  actorType?: AuditActorType;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  source: AuditWriteSource;
}

const ACTOR_TYPE_MAP: Record<AuditActorType, ActorType> = {
  user: 'USER',
  system: 'SYSTEM',
};

const AUDIT_SOURCE_MAP: Record<AuditWriteSource, AuditSource> = {
  bot: 'BOT',
  dashboard: 'DASHBOARD',
  system: 'SYSTEM',
};

/**
 * Creates an AuditLog row, redacting `before`/`after` payloads and mapping friendly string enums to Prisma enums.
 * Accepts a transaction client too, so a caller can write the audit row in the same transaction as the change it
 * records (then the two can never exist without each other).
 */
export async function writeAudit(
  prisma: Pick<PrismaClient, 'auditLog'> | Prisma.TransactionClient,
  entry: WriteAuditInput,
): Promise<AuditLog> {
  return prisma.auditLog.create({
    data: {
      guildId: entry.guildId,
      actorId: entry.actorId,
      actorType: ACTOR_TYPE_MAP[entry.actorType ?? 'user'],
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: (entry.before !== undefined
        ? redactForAudit(entry.before)
        : undefined) as Prisma.InputJsonValue,
      after: (entry.after !== undefined ? redactForAudit(entry.after) : undefined) as Prisma.InputJsonValue,
      reason: entry.reason,
      source: AUDIT_SOURCE_MAP[entry.source],
    },
  });
}
