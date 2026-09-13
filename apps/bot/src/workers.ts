import { Worker, type Job } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type { Logger } from 'pino';
import type { Plugin, PluginContext } from '@pavisie/plugins';

export interface StartWorkersDeps {
  plugins: Plugin[];
  /** Returns the already-built `PluginContext` for a plugin (see host/loader.ts) — job processors need the same
   * context the rest of the host uses (shared services, config store bindings, etc), not a fresh one. */
  ctxFactory: (plugin: Plugin) => PluginContext | undefined;
  connection: RedisOptions;
  logger: Logger;
}

export interface StartedWorkers {
  workers: Worker[];
  close(): Promise<void>;
}

/**
 * Starts a BullMQ `Worker` for every `<pluginId>:<jobName>` queue declared by any loaded plugin (ARCHITECTURE.md
 * §9's `workers.ts`). Deliberately takes `{ ctxFactory, plugins }` rather than building its own plugin contexts,
 * so job *processing* could be split into its own process later while still sharing the same plugin definitions
 * and context-building logic as the gateway process (host/loader.ts already handles registering each repeatable
 * job's scheduler — this only starts the workers that pull jobs off those queues and run them).
 */
export function startWorkers(deps: StartWorkersDeps): StartedWorkers {
  const workers: Worker[] = [];

  for (const plugin of deps.plugins) {
    const jobs = plugin.jobs ?? [];
    if (jobs.length === 0) continue;

    const ctx = deps.ctxFactory(plugin);
    if (!ctx) {
      deps.logger.warn(
        { plugin: plugin.manifest.id },
        'workers: no PluginContext available for a plugin with declared jobs; skipping',
      );
      continue;
    }

    for (const job of jobs) {
      const queueName = `${plugin.manifest.id}.${job.name}`;
      // `PluginJob<T>`'s payload type `T` is erased on `Plugin['jobs']` (declared `PluginJob<any>[]` in
      // sdk/types.ts) for the same reason every other heterogeneous-plugin-array loop in this file needs it;
      // each job's own `processor` stays fully typed.
      const processor = (bullJob: Job) => job.processor(ctx, bullJob as never);
      const worker = new Worker(queueName, processor, {
        connection: deps.connection,
        concurrency: job.concurrency ?? 1,
      });

      worker.on('failed', (bullJob, err) => {
        deps.logger.error(
          { plugin: plugin.manifest.id, job: job.name, jobId: bullJob?.id, err: err.message },
          'plugin job failed',
        );
        ctx.events.emit('plugin.error', {
          pluginId: plugin.manifest.id,
          error: err.message,
          context: { job: job.name, jobId: bullJob?.id },
        });
      });
      worker.on('error', (err) => {
        deps.logger.error({ plugin: plugin.manifest.id, job: job.name, err }, 'plugin job worker error');
      });

      workers.push(worker);
    }
  }

  return {
    workers,
    close: async () => {
      await Promise.all(workers.map((worker) => worker.close()));
    },
  };
}
