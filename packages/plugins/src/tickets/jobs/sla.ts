// Runs every minute: alerts support roles (in the ticket + the configured alert channel) once per ticket whose
// SLA is overdue and has had no first staff response yet. Dedupe via a Redis `NX` flag (ARCHITECTURE.md-adjacent
// TASK spec: "job 'tickets:sla' every minute ... alert support roles ... once").
import { redisKey } from '@pavisie/core';
import { infoEmbed, resolveTextChannel, type PluginJob } from '../../sdk';
import type { TicketsConfig } from '../manifest';

const ALERT_TTL_SECONDS = 24 * 60 * 60;
const BATCH_SIZE = 200;

export const slaJob: PluginJob<Record<string, never>> = {
  name: 'sla',
  repeat: { pattern: '* * * * *' },
  async processor(ctx, _job) {
    const overdue = await ctx.prisma.ticket.findMany({
      where: { status: 'OPEN', firstResponseAt: null, slaDueAt: { lte: new Date() } },
      take: BATCH_SIZE,
    });

    for (const ticket of overdue) {
      const flagKey = redisKey('tickets', 'sla-alerted', ticket.id);
      const claimed = await ctx.redis.set(flagKey, '1', 'EX', ALERT_TTL_SECONDS, 'NX');
      if (claimed !== 'OK') continue;

      try {
        const enabled = await ctx.isEnabled(ticket.guildId);
        if (!enabled) continue;

        const config = await ctx.getConfig<TicketsConfig>(ticket.guildId);
        let supportRoleIds = config.supportRoleIds;
        if (ticket.panelId) {
          const panel = await ctx.prisma.ticketPanel.findUnique({ where: { id: ticket.panelId } });
          if (panel) supportRoleIds = panel.supportRoleIds;
        }

        const guild = await ctx.client.guilds.fetch(ticket.guildId).catch(() => null);
        if (!guild) continue;

        const mentionContent =
          supportRoleIds.length > 0 ? supportRoleIds.map((id) => `<@&${id}>`).join(' ') : undefined;
        const embed = infoEmbed(
          'SLA breached',
          `Ticket #${ticket.number} has had no staff response since it opened.`,
        );
        const payload = {
          content: mentionContent,
          embeds: [embed],
          allowedMentions: { roles: supportRoleIds },
        };

        const ticketChannelId = ticket.threadId ?? ticket.channelId;
        if (ticketChannelId) {
          const channel = await guild.channels.fetch(ticketChannelId).catch(() => null);
          if (channel?.isTextBased()) {
            await channel
              .send(payload)
              .catch((err) =>
                ctx.logger.warn(
                  { err, ticketId: ticket.id },
                  'tickets: sla alert failed to post in ticket channel',
                ),
              );
          }
        }

        if (config.alertChannelId) {
          const alertChannel = await resolveTextChannel(guild, config.alertChannelId);
          if (alertChannel) {
            await alertChannel
              .send(payload)
              .catch((err) =>
                ctx.logger.warn(
                  { err, ticketId: ticket.id },
                  'tickets: sla alert failed to post in alert channel',
                ),
              );
          }
        }
      } catch (err) {
        ctx.logger.error({ err, ticketId: ticket.id }, 'tickets: sla job failed for a ticket');
      }
    }
  },
};
