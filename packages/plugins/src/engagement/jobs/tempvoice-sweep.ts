import type { PluginJob } from '../../sdk';
import { isOrphanTempVoiceChannel } from '../service';

/**
 * Backstop for temp-voice cleanup: `voiceStateUpdate` already deletes a temp channel the moment it
 * empties, but a bot restart (or a missed gateway event) can leave an orphan behind. Runs every 5
 * minutes across every guild, deleting any temp-voice channel that's gone (already deleted out of
 * band) or has zero members.
 */
export const tempVoiceSweepJob: PluginJob = {
  name: 'tempvoice-sweep',
  repeat: { pattern: '*/5 * * * *' },
  async processor(ctx) {
    const rows = await ctx.prisma.tempVoiceChannel.findMany();
    if (rows.length === 0) return;

    for (const row of rows) {
      try {
        const guild = await ctx.client.guilds.fetch(row.guildId).catch(() => null);
        if (!guild) {
          // Bot is no longer in the guild; the row is unreachable data — drop it.
          await ctx.prisma.tempVoiceChannel.delete({ where: { id: row.id } }).catch(() => undefined);
          continue;
        }

        const channel = await guild.channels.fetch(row.channelId).catch(() => null);
        if (!channel || !channel.isVoiceBased()) {
          await ctx.prisma.tempVoiceChannel.delete({ where: { id: row.id } }).catch(() => undefined);
          continue;
        }

        if (isOrphanTempVoiceChannel(channel.members.size)) {
          await channel
            .delete('Pavisie engagement: temp voice sweep (empty channel)')
            .catch(() => undefined);
          await ctx.prisma.tempVoiceChannel.delete({ where: { id: row.id } }).catch(() => undefined);
        }
      } catch (err) {
        ctx.logger.warn(
          {
            guildId: row.guildId,
            channelId: row.channelId,
            err: err instanceof Error ? err.message : String(err),
          },
          'engagement: tempvoice sweep failed for one channel',
        );
      }
    }
  },
};
