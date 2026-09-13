import { Worker, type Job } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import { env } from '@pavisie/core';
import { ensureGuild, markGuildLeft, type PrismaClient } from '@pavisie/database';

export const DATA_REQUESTS_QUEUE_NAME = 'data-requests';

export interface DataRequestJobData {
  requestId: string;
  guildId: string;
  requestedBy: string;
}

/** How long a generated export download stays available before `resultUrl` is treated as expired. */
const EXPORT_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface DataRequestsWorkerDeps {
  client: Client;
  prisma: PrismaClient;
  connection: RedisOptions;
  logger: Logger;
  concurrency?: number;
}

/** Recursively strips fields that are (or contain) secrets — encrypted API keys, webhook secrets, OAuth
 * tokens — from anything about to be written into a user-facing data export. A guild admin exporting "their"
 * data should never receive ciphertext they can't do anything with, or a live OAuth/webhook secret. */
const SECRET_KEY_PATTERN =
  /(secretenc|apikeyenc|tokenenc|accesstoken|refreshtoken|clientsecret|^secret$|^password$)/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * Gathers the guild-scoped rows a "download my data" export should contain: configuration, the moderation and
 * enforcer compliance ledgers, automod rules/events, tickets, level profiles, member-shared birthdays
 * (month/day only), linked game accounts + stat snapshots (gamestats plugin), and the audit log. Not every
 * guild-scoped table in the schema (giveaways/polls/economy/etc. are lower-priority, less personal-data-bearing
 * tables) — this covers the categories called out in docs/PRIVACY_POLICY_TEMPLATE.md and the compliance-relevant
 * ones. Every value passes through `redactSecrets` before being returned.
 */
export async function collectGuildExport(
  prisma: PrismaClient,
  guildId: string,
): Promise<Record<string, unknown>> {
  const [
    guild,
    config,
    pluginConfigs,
    pluginStates,
    moderationCases,
    moderationWarnings,
    moderationNotes,
    moderationAppeals,
    automodRules,
    automodEvents,
    tickets,
    rolePanels,
    levelProfiles,
    enforcerPolicies,
    enforcerRecords,
    auditLogs,
    birthdays,
    gameAccountLinks,
    gameStatSnapshots,
  ] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.guildConfig.findUnique({ where: { guildId } }),
    prisma.pluginConfig.findMany({ where: { guildId } }),
    prisma.pluginState.findMany({ where: { guildId } }),
    prisma.moderationCase.findMany({ where: { guildId } }),
    prisma.moderationWarning.findMany({ where: { guildId } }),
    prisma.moderationNote.findMany({ where: { guildId } }),
    prisma.moderationAppeal.findMany({ where: { guildId } }),
    prisma.automodRule.findMany({ where: { guildId } }),
    prisma.automodEvent.findMany({ where: { guildId } }),
    prisma.ticket.findMany({ where: { guildId } }),
    prisma.rolePanel.findMany({ where: { guildId } }),
    prisma.levelProfile.findMany({ where: { guildId } }),
    prisma.enforcerPolicy.findMany({ where: { guildId } }),
    prisma.enforcerRecord.findMany({ where: { guildId } }),
    prisma.auditLog.findMany({ where: { guildId } }),
    prisma.birthday.findMany({ where: { guildId }, select: { userId: true, month: true, day: true } }),
    prisma.gameAccountLink.findMany({ where: { guildId } }),
    prisma.gameStatSnapshot.findMany({ where: { guildId } }),
  ]);

  return redactSecrets({
    exportedAt: new Date().toISOString(),
    guild,
    config,
    pluginConfigs,
    pluginStates,
    moderation: {
      cases: moderationCases,
      warnings: moderationWarnings,
      notes: moderationNotes,
      appeals: moderationAppeals,
    },
    automod: { rules: automodRules, events: automodEvents },
    tickets,
    rolePanels,
    levelProfiles,
    enforcer: { policies: enforcerPolicies, records: enforcerRecords },
    birthdays,
    gamestats: { accountLinks: gameAccountLinks, statSnapshots: gameStatSnapshots },
    auditLogs,
  }) as Record<string, unknown>;
}

export async function processExport(prisma: PrismaClient, job: Job<DataRequestJobData>): Promise<void> {
  const { requestId, guildId } = job.data;
  await prisma.dataRequest
    .update({ where: { id: requestId }, data: { status: 'RUNNING' } })
    .catch(() => undefined);

  const data = await collectGuildExport(prisma, guildId);
  const content = JSON.stringify(data, null, 2);

  await prisma.dataExportBlob.upsert({
    where: { requestId },
    create: { requestId, guildId, content },
    update: { content },
  });

  const resultUrl = `${env.API_BASE_URL ?? ''}/guilds/${guildId}/data/requests/${requestId}/download`;
  await prisma.dataRequest.update({
    where: { id: requestId },
    data: {
      status: 'DONE',
      resultUrl,
      resultExpiresAt: new Date(Date.now() + EXPORT_RESULT_TTL_MS),
      completedAt: new Date(),
    },
  });
}

export async function processDelete(
  deps: DataRequestsWorkerDeps,
  job: Job<DataRequestJobData>,
): Promise<void> {
  const { requestId, guildId, requestedBy } = job.data;
  const { prisma, client } = deps;

  const before = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!before) {
    await prisma.dataRequest
      .update({
        where: { id: requestId },
        data: { status: 'FAILED', error: 'That server has no data on file.' },
      })
      .catch(() => undefined);
    return;
  }

  await prisma.dataRequest
    .update({ where: { id: requestId }, data: { status: 'RUNNING' } })
    .catch(() => undefined);

  // Deletes every row across every guild-scoped table via `onDelete: Cascade` — including, notably, this very
  // `DataRequest` row. That's intentional: "delete everything" means everything, including the request log
  // that asked for it.
  await prisma.guild.delete({ where: { id: guildId } });

  // Re-create a minimal shell row so the guild id stays addressable (dashboard guild list, any future request
  // against this guildId) and so a completed `DataRequest` can be recorded at all (its FK requires the guild
  // to exist).
  const stillPresent = await client.guilds.fetch(guildId).catch(() => null);
  await ensureGuild(prisma, {
    id: before.id,
    name: before.name,
    iconHash: before.iconHash,
    ownerId: before.ownerId,
    memberCount: before.memberCount ?? undefined,
  });
  if (!stillPresent) {
    await markGuildLeft(prisma, guildId).catch(() => undefined);
  }

  await prisma.dataRequest.create({
    data: { guildId, type: 'DELETE', status: 'DONE', requestedBy, completedAt: new Date() },
  });
}

async function processDataRequestJob(
  deps: DataRequestsWorkerDeps,
  job: Job<DataRequestJobData>,
): Promise<void> {
  if (job.name === 'export') {
    await processExport(deps.prisma, job);
    return;
  }
  if (job.name === 'delete') {
    await processDelete(deps, job);
    return;
  }
  throw new Error(`data-requests: unknown job name "${job.name}".`);
}

/** Starts the `data-requests` BullMQ Worker (dashboard-initiated export/delete, ARCHITECTURE.md §10/§17). */
export function createDataRequestsWorker(deps: DataRequestsWorkerDeps): Worker<DataRequestJobData> {
  const worker = new Worker<DataRequestJobData>(
    DATA_REQUESTS_QUEUE_NAME,
    async (job) => {
      try {
        await processDataRequestJob(deps, job);
      } catch (err) {
        await deps.prisma.dataRequest
          .update({
            where: { id: job.data.requestId },
            data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err) },
          })
          .catch(() => undefined);
        throw err;
      }
    },
    { connection: deps.connection, concurrency: deps.concurrency ?? 2 },
  );

  worker.on('failed', (job, err) => {
    deps.logger.error(
      { jobId: job?.id, name: job?.name, guildId: job?.data.guildId, err: err.message },
      'data-requests job failed',
    );
  });
  worker.on('error', (err) => {
    deps.logger.error({ err }, 'data-requests worker error');
  });

  return worker;
}
