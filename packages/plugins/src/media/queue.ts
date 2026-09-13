import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';
import type { Track } from './providers/types';

export type LoopMode = 'off' | 'track' | 'queue';

export interface QueueState {
  tracks: Track[];
  /** Index into `tracks` of the current track, or -1 if nothing is queued/current. */
  currentIndex: number;
  playing: boolean;
  /** 0-150 (matches the `/music volume` option range). */
  volume: number;
  loop: LoopMode;
}

function defaultState(defaultVolume: number): QueueState {
  return { tracks: [], currentIndex: -1, playing: false, volume: defaultVolume, loop: 'off' };
}

function queueKey(guildId: string): string {
  return redisKey('media', 'queue', guildId);
}

/**
 * Per-guild playback queue, held in Redis (ARCHITECTURE.md task spec: "queue manager in Redis per guild").
 * Pure queue bookkeeping — it never touches Discord voice; `@discordjs/voice` playback is intentionally not
 * wired (see `providers/types.ts`'s `createStream`), so `playing`/`currentIndex` describe *intended* playback
 * state a future voice adapter would act on, not audio actually happening in a channel right now.
 */
export class MediaQueueManager {
  constructor(private readonly redis: Redis) {}

  async getState(guildId: string, defaultVolume = 100): Promise<QueueState> {
    const raw = await this.redis.get(queueKey(guildId));
    if (!raw) return defaultState(defaultVolume);
    return JSON.parse(raw) as QueueState;
  }

  private async setState(guildId: string, state: QueueState): Promise<QueueState> {
    await this.redis.set(queueKey(guildId), JSON.stringify(state));
    return state;
  }

  /** Appends `tracks` to the queue; if nothing was playing, starts at the first newly-added track. */
  async add(guildId: string, tracks: Track[], defaultVolume = 100): Promise<QueueState> {
    const state = await this.getState(guildId, defaultVolume);
    const wasEmpty = state.tracks.length === 0;
    state.tracks.push(...tracks);
    if (wasEmpty && state.tracks.length > 0) {
      state.currentIndex = 0;
      state.playing = true;
    }
    return this.setState(guildId, state);
  }

  /** Removes the track at `index` (0-based, across the whole queue including already-played tracks). */
  async removeAt(guildId: string, index: number): Promise<QueueState> {
    const state = await this.getState(guildId);
    if (index < 0 || index >= state.tracks.length) {
      throw new RangeError(
        `removeAt: index ${index} is out of range (queue has ${state.tracks.length} tracks).`,
      );
    }
    state.tracks.splice(index, 1);
    if (index < state.currentIndex) {
      state.currentIndex -= 1;
    } else if (index === state.currentIndex) {
      if (state.tracks.length === 0) {
        state.currentIndex = -1;
        state.playing = false;
      } else if (state.currentIndex >= state.tracks.length) {
        state.currentIndex = state.tracks.length - 1;
      }
    }
    return this.setState(guildId, state);
  }

  /** Advances to the next track, honoring `loop: 'queue'` (wraps to the start) and stopping at the end otherwise. `loop: 'track'` is ignored by an explicit skip — it only affects natural end-of-track advance, which this system doesn't drive on its own since playback isn't wired. */
  async skip(guildId: string): Promise<QueueState> {
    const state = await this.getState(guildId);
    if (state.tracks.length === 0) return state;

    if (state.currentIndex + 1 < state.tracks.length) {
      state.currentIndex += 1;
    } else if (state.loop === 'queue') {
      state.currentIndex = 0;
    } else {
      state.currentIndex = -1;
      state.playing = false;
    }
    return this.setState(guildId, state);
  }

  async pause(guildId: string): Promise<QueueState> {
    const state = await this.getState(guildId);
    state.playing = false;
    return this.setState(guildId, state);
  }

  async resume(guildId: string): Promise<QueueState> {
    const state = await this.getState(guildId);
    if (state.tracks.length > 0 && state.currentIndex >= 0) {
      state.playing = true;
    }
    return this.setState(guildId, state);
  }

  async setVolume(guildId: string, volume: number): Promise<QueueState> {
    const state = await this.getState(guildId);
    state.volume = Math.max(0, Math.min(150, Math.round(volume)));
    return this.setState(guildId, state);
  }

  async setLoop(guildId: string, mode: LoopMode): Promise<QueueState> {
    const state = await this.getState(guildId);
    state.loop = mode;
    return this.setState(guildId, state);
  }

  /** Clears the entire queue and resets playback state. */
  async stop(guildId: string, defaultVolume = 100): Promise<QueueState> {
    return this.setState(guildId, defaultState(defaultVolume));
  }

  /**
   * Shuffles only the *upcoming* tracks (after the current one) — history and the currently-playing track stay
   * put. `rng` defaults to `Math.random` but accepts an injected generator for deterministic tests
   * (Fisher-Yates, `rng()` expected to return `[0, 1)`).
   */
  async shuffle(guildId: string, rng: () => number = Math.random): Promise<QueueState> {
    const state = await this.getState(guildId);
    const upcomingStart = state.currentIndex + 1;
    const upcoming = state.tracks.slice(upcomingStart);

    for (let i = upcoming.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
    }

    state.tracks = [...state.tracks.slice(0, upcomingStart), ...upcoming];
    return this.setState(guildId, state);
  }

  async nowPlaying(guildId: string): Promise<Track | null> {
    const state = await this.getState(guildId);
    if (state.currentIndex < 0) return null;
    return state.tracks[state.currentIndex] ?? null;
  }
}
