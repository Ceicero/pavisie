import { ChannelType } from 'discord.js';
import type { PluginEventHandler } from '../../sdk';
import { applyMuteRoleToChannel } from '../channels';
import type { EnforcerConfig } from '../manifest';

/**
 * Keeps the Enforcer mute-role deny-overwrites in sync as new channels appear, without waiting for a manual
 * `/enforcer setup repair:true` (ARCHITECTURE.md §19): a channel created after the mute role was set up would
 * otherwise silently let muted members send/speak/react in it until someone remembers to repair. Applies to
 * every channel type the bulk apply covers (text, voice, announcement, forum, stage) plus categories — a
 * category can hold its own overwrites, so applying there means channels created under it inherit the deny too.
 *
 * `channelCreate`'s payload type (`NonThreadGuildBasedChannel`) already rules out threads and DM channels, so no
 * runtime check is needed for those; `!channel.isThread()` below is kept only as defensive documentation,
 * matching `applyMuteRoleToChannels`'s own filter in `../channels.ts`.
 *
 * Plugin-enablement ("if enforcer is enabled for the guild") is handled by the host's automatic `guildIdOf`
 * gating (see `apps/bot/src/host/loader.ts`), the same convention every other event handler in this plugin uses
 * (e.g. `./message-create.ts`) — this handler does not re-check `ctx.isEnabled` itself.
 *
 * Best-effort only: any failure (missing Manage Roles/Manage Channels, a role deleted out from under us, a
 * transient API error) is logged at `warn` and swallowed — a single bad apply must never throw out of the
 * listener and take down other plugins' `channelCreate` handlers.
 */
export const channelCreateHandler: PluginEventHandler<'channelCreate'> = {
  event: 'channelCreate',
  guildIdOf: (channel) => channel.guild.id,
  async handler(ctx, channel) {
    try {
      if (channel.isThread()) return;

      const isRelevantType =
        channel.isTextBased() || channel.isVoiceBased() || channel.type === ChannelType.GuildCategory;
      if (!isRelevantType) return;
      if (!channel.manageable) return;

      const config = await ctx.getConfig<EnforcerConfig>(channel.guild.id);
      if (!config.muteRoleId) return;

      const role = await channel.guild.roles.fetch(config.muteRoleId).catch(() => null);
      if (!role) return;

      await applyMuteRoleToChannel(channel, role, 'Enforcer: apply mute role overwrite (new channel)');
    } catch (err) {
      ctx.logger.warn(
        { err, guildId: channel.guild.id, channelId: channel.id },
        'enforcer: failed to apply mute role overwrite to newly created channel',
      );
    }
  },
};
