/** A single playable item, independent of which provider found/resolved it. */
export interface Track {
  id: string;
  title: string;
  artist?: string;
  durationSec?: number;
  /** Canonical URL for the track on the provider's own service (never a re-hosted/ripped copy). */
  url: string;
  /** `MediaProvider.id` of whichever provider produced this track. */
  provider: string;
  thumbnailUrl?: string;
}

/**
 * Loose env-like shape so providers don't need `@pavisie/core`'s `env` type directly, while still accepting
 * the real (fully-typed, not-all-strings) `ctx.env`/`coreEnv` object as-is: `MEDIA_PROVIDER` is always a string
 * (the core env schema defaults it to `'none'`), and every other key is read defensively by providers anyway.
 */
export interface MediaProviderEnv {
  MEDIA_PROVIDER?: string;
  [key: string]: unknown;
}

/**
 * Playback-source abstraction (SPEC.md §I / ARCHITECTURE.md §7.1 `media`): "Create an adapter interface for
 * legal, user-authorized audio sources or streaming providers where their API and terms permit use." No shipped
 * implementation of this interface performs scraping, stream ripping, or any other licensing bypass — see
 * `none.ts` (the default, always-unconfigured provider) and `example-licensed.ts` (a documented template for a
 * real integration, not a working one).
 */
export interface MediaProvider {
  readonly id: string;
  readonly name: string;
  /** Whether this provider has everything it needs (API keys, etc.) to actually be used, given the process env. */
  isConfigured(env: MediaProviderEnv): boolean;
  search(query: string): Promise<Track[]>;
  resolve(url: string): Promise<Track | null>;
  /**
   * Playback-abstraction hook for a future, compliant voice adapter (`@discordjs/voice`) — intentionally not
   * wired up by any command in this build. Returning a readable/stream handle is provider-specific, so this is
   * typed loosely on purpose; a real adapter defines its own concrete return type.
   */
  createStream?(track: Track): Promise<unknown>;
}
