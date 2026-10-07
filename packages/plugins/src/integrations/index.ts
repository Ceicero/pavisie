import { definePlugin, registerPluginLocales } from '../sdk';
import { manifest } from './manifest';
import { command as integrationCommand, integrationConfirmComponents } from './commands/integration';
import { twitchBridgeMessageCreateHandler } from './twitch-chat/bridge-discord-handler';
import { inboundJob } from './jobs/inbound';
import { outboundJob } from './jobs/outbound';
import {
  pollGoogleCalendarJob,
  pollInstagramJob,
  pollMicrosoftCalendarJob,
  pollRedditJob,
  pollSteamJob,
  pollTwitchJob,
  pollYoutubeJob,
} from './jobs/poll';
import { tokenRefreshJob } from './jobs/token-refresh';
import { createTwitchChatTickJob } from './jobs/twitch-chat-tick';
import { twitchEventSubCleanupJob } from './jobs/twitch-eventsub-cleanup';
import { createIntegrationsService, registerOutboundEventBridge } from './service';
import { TwitchChatManager, createTwitchChatService } from './twitch-chat/manager';
import en from './locales/en.json';

registerPluginLocales('integrations', { en });

// Module-level singleton (not built inside `onLoad`) so the same instance backs both the `twitch-chat-tick`
// job (registered in `jobs` below, at module-load time) and the service registered from `onLoad`. Only
// `apps/bot` ever imports this module's `onLoad`/jobs — `apps/api` builds its `PluginRegistry` from manifests
// only (`apps/api/src/lib/config-store.ts`) — so there is exactly one of these per deployment.
const twitchChatManager = new TwitchChatManager();
const twitchChatTickJob = createTwitchChatTickJob(twitchChatManager);

export const plugin = definePlugin({
  manifest,
  commands: [integrationCommand],
  events: [twitchBridgeMessageCreateHandler],
  components: [...integrationConfirmComponents],
  jobs: [
    inboundJob,
    outboundJob,
    pollTwitchJob,
    pollYoutubeJob,
    pollRedditJob,
    pollSteamJob,
    pollGoogleCalendarJob,
    pollMicrosoftCalendarJob,
    pollInstagramJob,
    tokenRefreshJob,
    twitchChatTickJob,
    twitchEventSubCleanupJob,
  ],
  async onLoad(ctx) {
    ctx.services.register('integrations', createIntegrationsService(ctx));
    registerOutboundEventBridge(ctx);

    ctx.services.register('twitchChat', createTwitchChatService(ctx, twitchChatManager));
    // Fire-and-forget: `start` only resolves once its *attempt* finishes (idle if env/bot-identity are missing,
    // or the first connect attempt otherwise) — never blocks plugin load on a network round trip. Actual
    // connection failures are handled internally (backoff + retry), not surfaced here.
    void twitchChatManager.start(ctx).catch((err: unknown) => {
      ctx.logger.error({ err }, 'integrations/twitch-chat: manager failed to start');
    });
  },
  async health(ctx) {
    const active = await ctx.prisma.integrationConnection
      .count({ where: { status: 'CONNECTED', deletedAt: null } })
      .catch(() => 0);
    const errored = await ctx.prisma.integrationConnection
      .count({ where: { status: 'ERROR', deletedAt: null } })
      .catch(() => 0);

    const twitchChat = ctx.services.get('twitchChat')?.status();
    const twitchChatDetail = !twitchChat
      ? undefined
      : !twitchChat.enabled
        ? `Twitch chat idle (${twitchChat.reason ?? 'not configured'}).`
        : twitchChat.connected
          ? `Twitch chat connected (${twitchChat.joinedChannels} channel(s)).`
          : `Twitch chat reconnecting${twitchChat.lastError ? ` (${twitchChat.lastError})` : ''}.`;

    if (errored > 0 && active === 0) {
      return {
        status: 'degraded',
        details: [`${errored} connection(s) in an error state.`, twitchChatDetail].filter(Boolean).join(' '),
      };
    }
    return {
      status: 'ok',
      details: [
        `${active} connection(s) active${errored > 0 ? `, ${errored} in error` : ''}.`,
        twitchChatDetail,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

export default plugin;
