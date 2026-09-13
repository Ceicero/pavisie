import { Worker, type Job } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import { ensureGuild, type PrismaClient } from '@pavisie/database';
import type { ServiceMap, ServiceRegistry } from '@pavisie/plugins';

export const BOT_ACTIONS_QUEUE_NAME = 'bot-actions';

/** Every bot-action job type this worker knows how to dispatch (ARCHITECTURE.md §9). */
export type BotActionType =
  | 'roles.postPanel'
  | 'roles.testWelcome'
  | 'roles.verificationDecision'
  | 'tickets.postPanel'
  | 'tickets.close'
  | 'integrations.testWebhook'
  | 'ai.test'
  | 'enforcer.decide'
  | 'enforcer.repairChannels'
  | 'twitchChat.reconcile'
  | 'guild.refresh';

export interface BotActionJobData {
  type: BotActionType;
  guildId: string;
  payload?: unknown;
  requestedBy?: string;
}

/** Maps a bot-action job type to the `ServiceMap` key and method name it dispatches to. `guild.refresh` is handled directly (host-level, not owned by any plugin service). */
const DISPATCH_TABLE: Partial<Record<BotActionType, { service: keyof ServiceMap; method: string }>> = {
  'roles.postPanel': { service: 'roles', method: 'postPanel' },
  'roles.testWelcome': { service: 'roles', method: 'testWelcome' },
  'roles.verificationDecision': { service: 'roles', method: 'verificationDecision' },
  'tickets.postPanel': { service: 'tickets', method: 'postPanel' },
  'tickets.close': { service: 'tickets', method: 'closeTicketFromDashboard' },
  'integrations.testWebhook': { service: 'integrations', method: 'testWebhook' },
  'ai.test': { service: 'ai', method: 'test' },
  'enforcer.decide': { service: 'enforcer', method: 'decide' },
  'enforcer.repairChannels': { service: 'enforcer', method: 'repairChannels' },
  // `reconcileNow()` takes no arguments — it ignores the `{ guildId, payload, requestedBy }` object every other
  // dispatch target receives, since the Twitch chat reconcile loop isn't scoped to one guild.
  'twitchChat.reconcile': { service: 'twitchChat', method: 'reconcileNow' },
};

export interface BotActionsWorkerDeps {
  services: ServiceRegistry;
  client: Client;
  prisma: PrismaClient;
  connection: RedisOptions;
  logger: Logger;
  concurrency?: number;
}

/**
 * Handles `guild.refresh`: re-fetches the guild from the gateway/API and upserts it (name, icon, owner, member
 * count) via `ensureGuild`. Not a plugin action — every other job type dispatches to a plugin-registered service.
 */
async function handleGuildRefresh(deps: BotActionsWorkerDeps, guildId: string): Promise<void> {
  const guild = await deps.client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    throw new Error(
      `bot-actions: guild "${guildId}" is not reachable (bot may not be a member, or the id is invalid).`,
    );
  }
  await ensureGuild(deps.prisma, {
    id: guild.id,
    name: guild.name,
    iconHash: guild.icon,
    ownerId: guild.ownerId,
    memberCount: guild.memberCount,
  });
}

/**
 * Dispatches one `bot-actions` job to the owning plugin's cross-plugin service (ARCHITECTURE.md §9). Every
 * non-`guild.refresh` type is looked up dynamically against `ServiceMap` and invoked with a single merged
 * `{ guildId, payload, requestedBy }` object; the target plugin's service implementation is responsible for
 * accepting that shape (all current targets — `roles`, `tickets`, `integrations`, `ai`, `enforcer` — do, via a
 * small dual-calling-convention wrapper documented in each plugin's `service.ts`, since those same methods are
 * also called positionally in-process by other plugins per the `ServiceMap` interface in `sdk/services.ts`).
 * If a service or method is unavailable (owning plugin disabled/not loaded), the job fails with a clear,
 * non-crashing message rather than throwing an unhandled error.
 */
async function dispatchBotAction(deps: BotActionsWorkerDeps, job: Job<BotActionJobData>): Promise<void> {
  const { type, guildId, payload, requestedBy } = job.data;

  if (type === 'guild.refresh') {
    await handleGuildRefresh(deps, guildId);
    return;
  }

  const target = DISPATCH_TABLE[type];
  if (!target) {
    throw new Error(`bot-actions: unknown job type "${String(type)}".`);
  }

  const service = deps.services.get(target.service) as unknown as Record<string, unknown> | undefined;
  const method = service?.[target.method];

  if (typeof method !== 'function') {
    deps.logger.warn(
      { type, guildId, service: target.service, method: target.method },
      'bot-actions: target service/method is not registered (owning plugin likely disabled, unavailable, or not yet built)',
    );
    throw new Error(
      `Action "${type}" is not available right now: the "${target.service}" plugin does not implement "${target.method}".`,
    );
  }

  await (method as (...args: unknown[]) => unknown).call(service, { guildId, payload, requestedBy });
}

/** Starts the shared `bot-actions` BullMQ Worker (dashboard/host → bot one-off action requests, ARCHITECTURE.md §9). */
export function createBotActionsWorker(deps: BotActionsWorkerDeps): Worker<BotActionJobData> {
  const worker = new Worker<BotActionJobData>(BOT_ACTIONS_QUEUE_NAME, (job) => dispatchBotAction(deps, job), {
    connection: deps.connection,
    concurrency: deps.concurrency ?? 4,
  });

  worker.on('failed', (job, err) => {
    deps.logger.error(
      { jobId: job?.id, type: job?.data.type, guildId: job?.data.guildId, err: err.message },
      'bot-actions job failed',
    );
  });
  worker.on('error', (err) => {
    deps.logger.error({ err }, 'bot-actions worker error');
  });

  return worker;
}
