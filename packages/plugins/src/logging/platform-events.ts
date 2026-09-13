import { redisKey } from '@pavisie/core';
import type { PluginContext } from '../sdk';

const MODERATION_DEDUPE_TTL_SECONDS = 60;

/**
 * Subscribes to the in-process `PlatformEvents` bus (ARCHITECTURE.md §7.6) and mirrors the relevant events into
 * `LoggingService.log`. Unlike the `events: PluginEventHandler[]` array (Discord gateway events, wired by the
 * host per plugin per guild), platform events are bridged once here in `onLoad` — `ctx.events` is a single
 * process-wide bus, and every payload already carries its own `guildId`.
 */
export function registerPlatformEventBridge(ctx: PluginContext): void {
  ctx.events.on('plugin.error', (payload) => {
    if (!payload.guildId) return; // host-level errors with no guild context aren't attributable to any server's log channels
    void ctx.services.get('logging')?.log(payload.guildId, 'bot.error', {
      title: `Error in "${payload.pluginId}"`,
      description: payload.error,
    });
  });

  ctx.events.on('webhook.deliveryFailed', (payload) => {
    void ctx.services.get('logging')?.log(payload.guildId, 'webhook.failure', {
      title: 'Webhook delivery failed',
      description: `Endpoint \`${payload.endpointId}\`: ${payload.error}${payload.status ? ` (HTTP ${payload.status})` : ''}`,
    });
  });

  ctx.events.on('moderation.caseCreated', (payload) => {
    void (async () => {
      // Dedupe by caseId (ARCHITECTURE.md's logging task): the moderation plugin may in the future call
      // `logging.log()` directly for a case *and* emit this event for other listeners — the first writer of
      // this Redis key wins, so the same case is never mirrored into the log twice.
      const dedupeKey = redisKey('logging', 'dedupe', 'case', payload.caseId);
      const acquired = await ctx.redis.set(dedupeKey, '1', 'EX', MODERATION_DEDUPE_TTL_SECONDS, 'NX');
      if (acquired !== 'OK') return;

      await ctx.services.get('logging')?.log(payload.guildId, 'moderation.action', {
        actorId: payload.moderatorId,
        targetId: payload.targetId,
        title: `Moderation action: ${payload.type}`,
        description: payload.reason ?? '_No reason given._',
      });
    })();
  });

  ctx.events.on('automod.triggered', (payload) => {
    void ctx.services.get('logging')?.log(payload.guildId, 'automod.trigger', {
      targetId: payload.userId,
      channelId: payload.channelId,
      title: `Automod triggered${payload.dryRun ? ' (dry run)' : ''}`,
      description: `Rule type \`${payload.ruleType}\` → action \`${payload.action}\`.`,
    });
  });

  ctx.events.on('ticket.opened', (payload) => {
    void ctx.services.get('logging')?.log(payload.guildId, 'ticket.event', {
      targetId: payload.userId,
      title: 'Ticket opened',
      description: `Ticket \`${payload.ticketId}\` opened.`,
    });
  });

  ctx.events.on('ticket.closed', (payload) => {
    void ctx.services.get('logging')?.log(payload.guildId, 'ticket.event', {
      targetId: payload.userId,
      title: 'Ticket closed',
      description: `Ticket \`${payload.ticketId}\` closed.`,
    });
  });

  ctx.events.on('member.verified', (payload) => {
    void ctx.services.get('logging')?.log(payload.guildId, 'verification.event', {
      targetId: payload.userId,
      title: 'Member verified',
      description: `Verified via \`${payload.method}\`.`,
    });
  });
}
