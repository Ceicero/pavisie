import { SlashCommandBuilder } from 'discord.js';
import { PermissionError, ValidationError, newId } from '@pavisie/core';
import { errorEmbed, listEmbed, successEmbed, type CommandContext, type PluginCommand } from '../../sdk';
import { hasDjPermission } from '../dj-gate';
import { MediaUnavailableError } from '../errors';
import type { MediaConfig } from '../manifest';
import { MediaQueueManager, type LoopMode, type QueueState } from '../queue';
import { resolveMediaProvider } from '../providers/resolve';
import type { Track } from '../providers/types';

const LOOP_CHOICES = [
  { name: 'Off', value: 'off' },
  { name: 'Track', value: 'track' },
  { name: 'Queue', value: 'queue' },
] as const;

const data = new SlashCommandBuilder()
  .setName('music')
  .setDescription('Manage the music queue.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('play')
      .setDescription('Search and queue a track.')
      .addStringOption((opt) =>
        opt.setName('query').setDescription('Search text or a track URL').setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('queue').setDescription('Show the current queue.'))
  .addSubcommand((sub) => sub.setName('skip').setDescription('Skip to the next track.'))
  .addSubcommand((sub) => sub.setName('pause').setDescription('Pause playback.'))
  .addSubcommand((sub) => sub.setName('resume').setDescription('Resume playback.'))
  .addSubcommand((sub) =>
    sub
      .setName('volume')
      .setDescription('Set the volume (0-150).')
      .addIntegerOption((opt) =>
        opt.setName('level').setDescription('0-150').setRequired(true).setMinValue(0).setMaxValue(150),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('loop')
      .setDescription('Set the loop mode.')
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Loop mode')
          .setRequired(true)
          .addChoices(...LOOP_CHOICES),
      ),
  )
  .addSubcommand((sub) => sub.setName('stop').setDescription('Stop playback and clear the queue.'))
  .addSubcommand((sub) => sub.setName('shuffle').setDescription('Shuffle the upcoming tracks.'))
  .addSubcommand((sub) => sub.setName('nowplaying').setDescription('Show the currently playing track.'))
  .addSubcommandGroup((group) =>
    group
      .setName('playlist')
      .setDescription('Saved playlists.')
      .addSubcommand((sub) =>
        sub
          .setName('save')
          .setDescription('Save the current queue as a playlist.')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(100),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('load')
          .setDescription('Queue a saved playlist.')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List saved playlists.'))
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a saved playlist.')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true),
          ),
      ),
  );

function playlistKey(name: string): string {
  return name.trim().toLowerCase();
}

function formatTrack(track: Track, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const duration = track.durationSec
    ? ` (${Math.floor(track.durationSec / 60)}:${String(track.durationSec % 60).padStart(2, '0')})`
    : '';
  const artist = track.artist ? ` — ${track.artist}` : '';
  return `${prefix}[${track.title}${artist}](${track.url})${duration}`;
}

function queueSummaryLines(state: QueueState): string[] {
  if (state.tracks.length === 0) return ['The queue is empty.'];
  const lines: string[] = [];
  const current = state.currentIndex >= 0 ? state.tracks[state.currentIndex] : undefined;
  lines.push(
    current
      ? `${state.playing ? '▶️ Now playing' : '⏸️ Paused'}: ${formatTrack(current)}`
      : 'Nothing is currently selected.',
  );
  lines.push(`Volume: ${state.volume} · Loop: ${state.loop}`);
  const upcoming = state.tracks.slice(state.currentIndex + 1, state.currentIndex + 11);
  if (upcoming.length > 0) {
    lines.push('', 'Up next:', ...upcoming.map((t, i) => formatTrack(t, i)));
  }
  return lines;
}

const MUTATING_SUBCOMMANDS = new Set(['skip', 'pause', 'resume', 'volume', 'loop', 'stop', 'shuffle']);
const PLAYLIST_MUTATING_SUBCOMMANDS = new Set(['save', 'load', 'delete']);

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true },
  async execute(c) {
    const provider = resolveMediaProvider(c.ctx.env);
    if (!provider.isConfigured(c.ctx.env)) {
      throw new MediaUnavailableError(c.t('errors.unavailable'));
    }

    const config = await c.config<MediaConfig>();
    const group = c.interaction.options.getSubcommandGroup(false);
    const sub = c.interaction.options.getSubcommand(true);
    const queueManager = new MediaQueueManager(c.ctx.redis);

    const voiceChannel = c.interaction.member.voice.channel;
    const isAlone = voiceChannel ? voiceChannel.members.filter((m) => !m.user.bot).size <= 1 : false;
    const djAllowed = () =>
      hasDjPermission({
        djRoleId: config.djRoleId,
        staffLevel: c.staffLevel,
        memberRoleIds: [...c.interaction.member.roles.cache.keys()],
        isAloneInVoiceChannel: isAlone,
      });

    if (
      (group === 'playlist' && PLAYLIST_MUTATING_SUBCOMMANDS.has(sub)) ||
      (!group && MUTATING_SUBCOMMANDS.has(sub))
    ) {
      if (!djAllowed()) {
        throw new PermissionError(c.t('errors.notDj'));
      }
    }

    if (group === 'playlist') {
      await handlePlaylistSubcommand(c, sub, config, queueManager);
      return;
    }

    switch (sub) {
      case 'play': {
        const query = c.interaction.options.getString('query', true);
        const results = await provider.search(query);
        const track = results[0];
        if (!track) {
          await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.noResults'))], ephemeral: true });
          return;
        }
        await queueManager.add(c.guildId, [track], config.defaultVolume);
        await c.interaction.reply({
          embeds: [successEmbed(c.t('play.queued', { track: formatTrack(track) }))],
          ephemeral: false,
        });
        return;
      }
      case 'queue': {
        const state = await queueManager.getState(c.guildId, config.defaultVolume);
        await c.interaction.reply({
          embeds: [listEmbed(c.t('queue.title'), queueSummaryLines(state))],
          ephemeral: true,
        });
        return;
      }
      case 'skip': {
        await queueManager.skip(c.guildId);
        await c.interaction.reply({ embeds: [successEmbed(c.t('skip.done'))], ephemeral: true });
        return;
      }
      case 'pause': {
        await queueManager.pause(c.guildId);
        await c.interaction.reply({ embeds: [successEmbed(c.t('pause.done'))], ephemeral: true });
        return;
      }
      case 'resume': {
        await queueManager.resume(c.guildId);
        await c.interaction.reply({ embeds: [successEmbed(c.t('resume.done'))], ephemeral: true });
        return;
      }
      case 'volume': {
        const level = c.interaction.options.getInteger('level', true);
        const state = await queueManager.setVolume(c.guildId, level);
        await c.interaction.reply({
          embeds: [successEmbed(c.t('volume.done', { level: state.volume }))],
          ephemeral: true,
        });
        return;
      }
      case 'loop': {
        const mode = c.interaction.options.getString('mode', true) as LoopMode;
        await queueManager.setLoop(c.guildId, mode);
        await c.interaction.reply({ embeds: [successEmbed(c.t('loop.done', { mode }))], ephemeral: true });
        return;
      }
      case 'stop': {
        await queueManager.stop(c.guildId, config.defaultVolume);
        await c.interaction.reply({ embeds: [successEmbed(c.t('stop.done'))], ephemeral: true });
        return;
      }
      case 'shuffle': {
        const state = await queueManager.shuffle(c.guildId);
        await c.interaction.reply({
          embeds: [successEmbed(c.t('shuffle.done', { count: state.tracks.length }))],
          ephemeral: true,
        });
        return;
      }
      case 'nowplaying': {
        const track = await queueManager.nowPlaying(c.guildId);
        await c.interaction.reply({
          embeds: [track ? successEmbed(formatTrack(track)) : errorEmbed(c.t('nowplaying.nothing'))],
          ephemeral: true,
        });
        return;
      }
      default:
        await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.generic'))], ephemeral: true });
    }
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    if (focused.name !== 'name') {
      await c.interaction.respond([]);
      return;
    }
    const config = await c.config<MediaConfig>();
    const query = String(focused.value).toLowerCase();
    const matches = Object.values(config.playlists)
      .filter((p) => p.name.toLowerCase().includes(query))
      .slice(0, 25);
    await c.interaction.respond(
      matches.map((p) => ({ name: `${p.name} (${p.tracks.length} tracks)`, value: p.name })),
    );
  },
};

async function handlePlaylistSubcommand(
  c: CommandContext,
  sub: string,
  config: MediaConfig,
  queueManager: MediaQueueManager,
): Promise<void> {
  const actor = { id: c.interaction.user.id, source: 'bot' as const };

  if (sub === 'list') {
    const names = Object.values(config.playlists).map((p) => `${p.name} (${p.tracks.length} tracks)`);
    await c.interaction.reply({ embeds: [listEmbed(c.t('playlist.listTitle'), names)], ephemeral: true });
    return;
  }

  if (sub === 'save') {
    const name = c.interaction.options.getString('name', true);
    const state = await queueManager.getState(c.guildId, config.defaultVolume);
    if (state.tracks.length === 0) {
      throw new ValidationError(c.t('errors.emptyQueue'));
    }
    const key = playlistKey(name);
    const nextPlaylists = {
      ...config.playlists,
      [key]: {
        name,
        tracks: state.tracks,
        createdBy: c.interaction.user.id,
        createdAt: new Date().toISOString(),
      },
    };
    await c.ctx.setConfig<MediaConfig>(c.guildId, { playlists: nextPlaylists }, actor);
    await c.interaction.reply({ embeds: [successEmbed(c.t('playlist.saved', { name }))], ephemeral: true });
    return;
  }

  if (sub === 'load') {
    const name = c.interaction.options.getString('name', true);
    const playlist = config.playlists[playlistKey(name)];
    if (!playlist) {
      throw new ValidationError(c.t('errors.playlistNotFound', { name }));
    }
    const tracksWithFreshIds: Track[] = playlist.tracks.map((t) => ({ ...t, id: newId() }));
    await queueManager.add(c.guildId, tracksWithFreshIds, config.defaultVolume);
    await c.interaction.reply({
      embeds: [
        successEmbed(c.t('playlist.loaded', { name: playlist.name, count: tracksWithFreshIds.length })),
      ],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'delete') {
    const name = c.interaction.options.getString('name', true);
    const key = playlistKey(name);
    if (!config.playlists[key]) {
      throw new ValidationError(c.t('errors.playlistNotFound', { name }));
    }
    const { [key]: _removed, ...rest } = config.playlists;
    await c.ctx.setConfig<MediaConfig>(c.guildId, { playlists: rest }, actor);
    await c.interaction.reply({ embeds: [successEmbed(c.t('playlist.deleted', { name }))], ephemeral: true });
    return;
  }

  await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.generic'))], ephemeral: true });
}
