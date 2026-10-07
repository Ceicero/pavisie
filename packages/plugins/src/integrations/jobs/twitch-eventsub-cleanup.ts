import type { PluginJob } from '../../sdk';
import { cleanupOrphanedTwitchEventSubs } from '../providers/twitch';

/**
 * Every 30 minutes: deletes `stream.online` EventSub WEBHOOK subscriptions that no active Twitch alert connection
 * wants any more (an alert removed long ago, or one created under a retired callback domain). One Helix list call
 * plus a delete per orphan, cached/rate-limit-aware inside `cleanupOrphanedTwitchEventSubs`; it never touches the
 * chat bot's WebSocket subscriptions. Logs counts only.
 */
export const twitchEventSubCleanupJob: PluginJob = {
  name: 'twitch-eventsub-cleanup',
  repeat: { pattern: '*/30 * * * *' },
  concurrency: 1,
  async processor(ctx) {
    if (!ctx.env.TWITCH_CLIENT_ID || !ctx.env.TWITCH_CLIENT_SECRET) return;
    try {
      const result = await cleanupOrphanedTwitchEventSubs(ctx);
      if (result.skipped) {
        ctx.logger.warn({ reason: result.skipped }, 'integrations/twitch: EventSub cleanup skipped');
      }
    } catch (err) {
      ctx.logger.warn({ err }, 'integrations/twitch: EventSub cleanup failed');
    }
  },
};
