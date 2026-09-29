/**
 * DTOs for the creator dashboard API (`/creator/*`, ARCHITECTURE.md §19e) — a streamer signs in with their
 * streaming-platform account (Twitch today, Kick later) and uses Pavisie with no Discord server involved.
 */
import type { TwitchChatCommandDto, TwitchChatTimerDto } from './integrations';

/** Streaming platforms a creator can sign in with. Only `twitch` is implemented; the discriminator exists so a
 * second platform (Kick) plugs into the same session/URL shapes later. */
export type CreatorPlatform = 'twitch';

/** The signed-in creator, as held in their session (no token of theirs is ever stored). */
export interface CreatorIdentityDto {
  platform: CreatorPlatform;
  /** The platform's own user id (a Twitch user id for `twitch`) — also the broadcaster id this creator owns. */
  platformUserId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
}

/** `GET /creator/me`. */
export interface CreatorMeDto {
  creator: CreatorIdentityDto;
  /** Sent back as `X-CSRF-Token` on every mutating `/creator/*` request. */
  csrfToken: string;
}

/** A creator's own Twitch chat-bot channel. Deliberately narrower than `TwitchChatChannelDto`: no Discord bridge
 * or reward fields — those belong to the Discord dashboard (and later phases). */
export interface CreatorTwitchChannelDto {
  id: string;
  broadcasterLogin: string;
  broadcasterUserId: string;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error' | 'pending';
  lastError: string | null;
  commandPrefix: string;
  /** True when the channel is also linked to a Discord server (the Discord-side link stays untouched). */
  discordLinked: boolean;
  createdAt: string;
}

/** `GET /creator/twitch/channel`. */
export interface CreatorTwitchChannelStatusDto {
  /** Whether Pavisie's own Twitch bot account has been authorized by the operator. */
  botConfigured: boolean;
  botLogin: string | null;
  /** Whether TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET are set on this deployment at all. */
  envConfigured: boolean;
  /** `null` until the creator has connected the bot to their chat. */
  channel: CreatorTwitchChannelDto | null;
}

export type CreatorTwitchCommandDto = TwitchChatCommandDto;
export type CreatorTwitchTimerDto = TwitchChatTimerDto;
