// Fires due `TwitchChatTimer` messages. Called from the `twitch-chat-tick` job, after `manager.reconcile`.
import type { PluginContext } from '../../sdk';
import { sendChatMessage } from './helix';
import type { TwitchChatManager } from './manager';

/**
 * Sends any enabled timer whose interval has elapsed, for channels the manager currently has a live EventSub
 * subscription for (a timer firing into a channel Pavisie isn't actually connected to would just fail the
 * Helix send and waste a rate-limit slot). A timer that has never fired (`lastFiredAt: null`) is due immediately
 * on the first tick after its channel connects.
 */
export async function fireDueTimers(ctx: PluginContext, manager: TwitchChatManager): Promise<void> {
  const connectedChannelIds = manager.connectedChannelIds();
  if (connectedChannelIds.length === 0) return;

  const now = new Date();
  const timers = await ctx.prisma.twitchChatTimer.findMany({
    where: { enabled: true, channelId: { in: connectedChannelIds } },
    include: { channel: true },
  });

  for (const timer of timers) {
    const dueAt = timer.lastFiredAt
      ? new Date(timer.lastFiredAt.getTime() + timer.intervalMinutes * 60_000)
      : now;
    if (dueAt.getTime() > now.getTime()) continue;

    try {
      const result = await sendChatMessage(ctx, timer.channel.broadcasterUserId, timer.message);
      if (result.ok) {
        await ctx.prisma.twitchChatTimer.update({ where: { id: timer.id }, data: { lastFiredAt: now } });
      }
    } catch (err) {
      ctx.logger.warn({ err, timerId: timer.id }, 'integrations/twitch-chat: timer send failed');
    }
  }
}
