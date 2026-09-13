import type { IntegrationProviderId } from '@pavisie/types/integrations';
import type { PluginJob } from '../../sdk';
import { getProvider, isProviderEnvSatisfied, PROVIDER_ENUM_MAP } from '../providers';
import { markConnectionError } from '../providers/util';

/** Builds a repeatable poll job for one alert-style provider: every `cronPattern`, calls `provider.poll` for
 * every CONNECTED (or previously-ERROR'd, so a fixed misconfiguration self-heals on the next run) connection of
 * that provider across every guild. One connection's failure never stops the others (SPEC.md §J). */
function makePollJob(name: string, providerId: IntegrationProviderId, cronPattern: string): PluginJob {
  return {
    name,
    repeat: { pattern: cronPattern },
    concurrency: 1,
    async processor(ctx) {
      const provider = getProvider(providerId);
      if (!provider?.poll) return;
      if (!isProviderEnvSatisfied(provider.requiredEnv, ctx.env)) return;

      const connections = await ctx.prisma.integrationConnection.findMany({
        where: {
          provider: PROVIDER_ENUM_MAP[providerId],
          status: { in: ['CONNECTED', 'ERROR'] },
          deletedAt: null,
        },
      });

      for (const connection of connections) {
        try {
          await provider.poll(ctx, connection);
        } catch (err) {
          await markConnectionError(ctx, connection.id, err);
          ctx.logger.warn(
            { err, connectionId: connection.id, provider: providerId },
            `integrations: ${providerId} poll failed`,
          );
        }
      }
    },
  };
}

export const pollTwitchJob = makePollJob('poll-twitch', 'twitch', '*/2 * * * *');
export const pollYoutubeJob = makePollJob('poll-youtube', 'youtube', '*/10 * * * *');
export const pollRedditJob = makePollJob('poll-reddit', 'reddit', '*/5 * * * *');
export const pollSteamJob = makePollJob('poll-steam', 'steam', '*/30 * * * *');
export const pollGoogleCalendarJob = makePollJob('poll-google-calendar', 'google_calendar', '*/15 * * * *');
export const pollMicrosoftCalendarJob = makePollJob(
  'poll-microsoft-calendar',
  'microsoft_calendar',
  '*/15 * * * *',
);
export const pollInstagramJob = makePollJob('poll-instagram', 'instagram', '*/15 * * * *');
