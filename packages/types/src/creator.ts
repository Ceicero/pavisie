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

// ---------------------------------------------------------------------------
// Channel-owned currency (creator dashboard phase 2a, ARCHITECTURE.md §18b / §19e)
// ---------------------------------------------------------------------------

/** A channel's own virtual currency settings (mirrors `ChannelEconomy`). Virtual only: no purchase, no cash-out. */
export interface CreatorChannelEconomySettingsDto {
  /** Master switch: chat commands (!balance/!daily/!give/!top) and the Twitch extension panel. */
  enabled: boolean;
  currencyName: string;
  currencySymbol: string;
  dailyMinAmount: number;
  dailyMaxAmount: number;
  streakBonusPerDay: number;
  streakBonusMax: number;
  giveMinAmount: number;
  giveMaxAmount: number;
  /** Award currency for chatting while the stream is live. */
  earnEnabled: boolean;
  earnPerMessage: number;
  earnCooldownSeconds: number;
  /** Max a viewer can earn from chat per UTC day (0 = no earning). */
  earnDailyCap: number;
}

/** `GET/PATCH /creator/twitch/economy`. `configured` is false until the streamer's first save; `settings` then
 * carries the defaults a first save would start from (nothing is stored by merely viewing). */
export interface CreatorChannelEconomyDto {
  configured: boolean;
  settings: CreatorChannelEconomySettingsDto;
}

export interface CreatorEconomyEarnedEntryDto {
  viewerUserId: string;
  displayName: string | null;
  /** Lifetime earned (daily + chat earning), a decimal string. */
  earned: string;
}

export interface CreatorEconomyBalanceEntryDto {
  viewerUserId: string;
  displayName: string | null;
  /** Current balance, a decimal string. */
  balance: string;
}

/** `GET /creator/twitch/economy/leaderboard` — empty arrays (not an error) before setup or before anyone earned. */
export interface CreatorEconomyLeaderboardDto {
  configured: boolean;
  earned: CreatorEconomyEarnedEntryDto[];
  balance: CreatorEconomyBalanceEntryDto[];
}

/** `POST /creator/twitch/economy/adjust` body. */
export interface CreatorEconomyAdjustInput {
  /** The viewer's Twitch login (a leading @ is fine). */
  login: string;
  direction: 'add' | 'remove';
  amount: number;
  /** Why — recorded on the transaction. */
  reason: string;
}

export interface CreatorEconomyAdjustResultDto {
  viewer: { userId: string; login: string; displayName: string };
  direction: 'add' | 'remove';
  amount: string;
  newBalance: string;
}

// ---------------------------------------------------------------------------
// Channel points: rewards, OBS overlay, TTS key (creator dashboard phase 2b, ARCHITECTURE.md §19b / §19e)
// ---------------------------------------------------------------------------

/** `GET /creator/twitch/rewards`. Everything the "Channel points" section needs to decide what to show; none of it
 * is a secret (the overlay URL and the TTS key are never in here). */
export interface CreatorRewardsStatusDto {
  /** The creator has a Pavisie chat channel row (rewards are attached to it). */
  channelExists: boolean;
  /** The bot is switched on for that channel — rewards only run while it is. */
  channelEnabled: boolean;
  /** Master switch for channel-point rewards on this channel. */
  rewardsEnabled: boolean;
  /** Pavisie holds a working broadcaster authorization (`channel:read:redemptions`) for this channel. */
  authorized: boolean;
  /** Why the stored authorization stopped working (a revoked/expired grant), or null. The streamer re-authorizes. */
  authorizationError: string | null;
  /** An OBS overlay URL has been created (the URL itself comes from `GET .../overlay`, owner only). */
  hasOverlay: boolean;
  /** The channel has its OWN OpenAI key for TTS ("set / not set" only — the key is write-only). */
  ttsKeyConfigured: boolean;
  /** The channel is also linked to a Discord server (which may hold its own TTS key as a fallback). */
  discordLinked: boolean;
  /** Per-channel reward cap. */
  maxRewards: number;
}

/** `PUT /creator/twitch/rewards/tts-key` and `DELETE` answer with this; the key itself is never returned. */
export interface CreatorTtsKeyStatusDto {
  ttsKeyConfigured: boolean;
}
