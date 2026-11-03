import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type { Logger } from 'pino';

/**
 * Repeatable jobs whose code has been removed. `loadPlugins` only ever *upserts* schedulers for jobs a plugin still
 * declares, so a removed job's scheduler (and the one delayed job it keeps queued) would otherwise sit in Redis
 * forever with no worker. Each entry is the BullMQ queue name (`<pluginId>.<jobName>`, see context.ts) and the
 * scheduler id (the job name).
 *
 * - `gamestats.gamestats-refresh` — the Game Stats plugin, removed 2026-11-03.
 * - `integrations.poll-steam` — the Steam integration connector, removed 2026-11-03.
 */
export const RETIRED_JOB_SCHEDULERS: readonly { queue: string; scheduler: string }[] = [
  { queue: 'gamestats.gamestats-refresh', scheduler: 'gamestats-refresh' },
  { queue: 'integrations.poll-steam', scheduler: 'poll-steam' },
];

type RetiredQueue = Pick<Queue, 'removeJobScheduler' | 'obliterate' | 'close'>;

/**
 * Removes every retired job's scheduler and clears its (now worker-less) queue. Idempotent — a no-op once the keys
 * are gone — and never throws: a Redis hiccup here must not stop the bot from starting.
 */
export async function removeRetiredJobSchedulers(
  connection: RedisOptions,
  logger: Logger,
  makeQueue: (name: string) => RetiredQueue = (name) => new Queue(name, { connection }),
): Promise<void> {
  for (const { queue: queueName, scheduler } of RETIRED_JOB_SCHEDULERS) {
    const queue = makeQueue(queueName);
    try {
      await queue.removeJobScheduler(scheduler);
      await queue.obliterate({ force: true });
    } catch (err) {
      logger.warn({ queue: queueName, err }, 'failed to remove retired job scheduler');
    } finally {
      await queue.close().catch(() => undefined);
    }
  }
}
