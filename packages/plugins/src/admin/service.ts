import { z } from 'zod';
import type { StreamerStarterResultDto } from '@pavisie/types';
import type { AdminService, PluginContext } from '../sdk';
import { STREAMER_STARTER_RESULT_TTL_SECONDS, streamerStarterResultKey } from './starter-pack';
import { StarterAlreadyRunningError, runStreamerStarter } from './starter-pack-runtime';

const payloadSchema = z.object({
  requestId: z.string().min(1).max(64),
  twitchLogin: z.string().max(100).nullish(),
  alertChannelId: z.string().max(32).nullish(),
});

/**
 * The `admin` plugin's cross-plugin service: the entry point the dashboard reaches through the `bot-actions` queue
 * (`admin.streamerStarter`). It runs the very same `runStreamerStarter` as `/setup streamer`, then leaves the outcome
 * in Redis for `apps/api` to hand back to the polling dashboard. It never throws — a failed run is stored as the
 * result, since a rejected queue job would only reach the bot's logs and the dashboard would wait forever.
 */
export function createAdminService(ctx: PluginContext): AdminService {
  async function store(guildId: string, requestId: string, result: StreamerStarterResultDto): Promise<void> {
    await ctx.redis.set(
      streamerStarterResultKey(guildId, requestId),
      JSON.stringify(result),
      'EX',
      STREAMER_STARTER_RESULT_TTL_SECONDS,
    );
  }

  return {
    async streamerStarter({ guildId, payload, requestedBy }) {
      const parsed = payloadSchema.safeParse(payload);
      if (!parsed.success) {
        ctx.logger.warn({ guildId }, 'admin: streamerStarter bot action had an invalid payload');
        return;
      }
      const { requestId, twitchLogin, alertChannelId } = parsed.data;

      try {
        if (!requestedBy) throw new Error('missing requestedBy');
        const guild = await ctx.client.guilds.fetch(guildId);
        const host = ctx.services.require('host');
        const { locale } = await host.getGuildConfig(guildId);
        const report = await runStreamerStarter({
          ctx,
          guild,
          input: { twitchLogin: twitchLogin ?? null, alertChannelId: alertChannelId ?? null },
          actor: { id: requestedBy, source: 'dashboard' },
          t: (key, vars) => ctx.t(key, vars, locale),
        });
        await store(guildId, requestId, { status: 'done', report });
      } catch (err) {
        if (!(err instanceof StarterAlreadyRunningError)) {
          ctx.logger.error(
            { guildId, err: err instanceof Error ? err.message : String(err) },
            'admin: streamer starter pack failed',
          );
        }
        const error =
          err instanceof StarterAlreadyRunningError
            ? ctx.t('setup.streamer.alreadyRunning')
            : ctx.t('setup.streamer.genericFailure');
        await store(guildId, requestId, { status: 'failed', error }).catch(() => undefined);
      }
    },
  };
}
