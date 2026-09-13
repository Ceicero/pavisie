// DTOs owned by the `integrations` build stage (ARCHITECTURE.md §7.1 row 'integrations', §10, SPEC.md §J).
// Imported via the subpath '@pavisie/types/integrations' (packages/types exports "./*") so this file can be
// added without touching the shared index.ts barrel (owned by the wiring stage).
import type { IntegrationConnectionDto, WebhookEndpointDto } from './api';

/** Every connector the `integrations` plugin knows about, matching (lowercased) `IntegrationProvider` Prisma enum
 * values. GitHub, Notion and Stripe (the guild-facing connector) were removed as offered providers on
 * 2026-09-02 — their Prisma enum values are retained for historical rows only (see schema.prisma), but they are
 * deliberately absent here, so no code can newly connect one. */
export const INTEGRATION_PROVIDER_IDS = [
  'twitch',
  'youtube',
  'instagram',
  'reddit',
  'steam',
  'google_calendar',
  'microsoft_calendar',
  'generic_webhook',
] as const;

export type IntegrationProviderId = (typeof INTEGRATION_PROVIDER_IDS)[number];

/** How a connection to this provider is established. */
export type IntegrationProviderKind = 'oauth' | 'apikey' | 'webhook' | 'public';

/** Providers that support `/integration alerts add|remove|list` watch-target connections. */
export const ALERT_PROVIDER_IDS = ['twitch', 'youtube', 'reddit', 'steam'] as const;
export type AlertProviderId = (typeof ALERT_PROVIDER_IDS)[number];

/** `GET /guilds/:guildId/integrations/providers` — per-provider availability, for the dashboard's setup hints. */
export interface IntegrationProviderInfoDto {
  id: IntegrationProviderId;
  name: string;
  kind: IntegrationProviderKind;
  available: boolean;
  missingEnv: string[];
  supportsAlerts: boolean;
}

/** An alert-watch connection (`/integration alerts add`): one `IntegrationConnection` row per watched target. */
export interface IntegrationConnectionDetailDto extends IntegrationConnectionDto {
  label: string | null;
  target: string | null;
  channelId: string | null;
  roleId: string | null;
  template: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface WebhookEndpointDetailDto extends WebhookEndpointDto {
  name: string;
  events: string[];
  channelId: string | null;
  failureCount: number;
  lastDeliveryAt: string | null;
}

export interface WebhookDeliveryDto {
  id: string;
  endpointId: string;
  direction: 'inbound' | 'outbound';
  status: number | null;
  success: boolean;
  attempt: number;
  error: string | null;
  createdAt: string;
}

export interface CreateAlertConnectionInput {
  provider: AlertProviderId;
  target: string;
  channelId: string;
  roleId?: string | null;
  template?: string | null;
}

export interface UpdateAlertConnectionInput {
  channelId?: string;
  roleId?: string | null;
  template?: string | null;
}

export interface CreateOutboundEndpointInput {
  name: string;
  url: string;
  events: string[];
}

export interface CreateInboundWebhookInput {
  name: string;
  provider?: string;
  channelId?: string | null;
  events?: string[];
}

/** Returned exactly once, at creation time, for both inbound (HMAC secret) and future secret-rotation flows. */
export interface WebhookSecretRevealDto {
  secret: string;
  url: string;
}

export interface StripeRewardRule {
  priceId: string;
  roleId: string;
}

export interface ConnectOAuthResponseDto {
  url: string;
}

/** `GET /guilds/:guildId/integrations/live` — one entry per (non-chat-kind) `IntegrationConnection` in the
 * guild, in the same order as `GET /guilds/:guildId/integrations`. Only Twitch has a real, cheaply-checkable
 * live/offline concept today (see `apps/api/src/lib/integrations/live-status.ts`); every other provider,
 * including YouTube, always reports `live: null` here — never a fabricated on/offline state. */
export interface IntegrationLiveStatusDto {
  connectionId: string;
  /** `true`/`false` = a real, just-checked Twitch Helix result. `null` = this provider has no live concept,
   * this connection has no resolvable target to check, or the lookup failed — callers must never treat `null`
   * as `false`. */
  live: boolean | null;
  /** Populated only when `live === true`. */
  title: string | null;
  startedAt: string | null;
}

/** Platform events an outbound webhook can subscribe to. Single source of truth for this list — the `integrations`
 * plugin (packages/plugins/src/integrations/service.ts), the API's validation schema
 * (apps/api/src/lib/integrations/outbound-events.ts), and the dashboard's create-webhook form all reference this
 * instead of duplicating the literal (ARCHITECTURE.md §11: the dashboard never imports `@pavisie/plugins`, so this
 * lives in the one package both sides already depend on). */
export const OUTBOUND_PLATFORM_EVENTS = [
  'moderation.caseCreated',
  'ticket.opened',
  'ticket.closed',
  'member.verified',
  'level.up',
  'automod.triggered',
  'enforcer.decided',
] as const;

export type OutboundPlatformEvent = (typeof OUTBOUND_PLATFORM_EVENTS)[number];

// ---------------------------------------------------------------------------
// Twitch chat bot — Pavisie joins a streamer's Twitch chat; lives inside the `integrations` plugin
// rather than as its own 15th plugin. Runtime lives in packages/plugins/src/integrations/twitch-chat/;
// API routes in apps/api/src/routes/twitch-chat.ts.
// ---------------------------------------------------------------------------

/** Chat-privilege ladder for custom commands, matching (lowercased) the `TwitchChatLevel` Prisma enum. */
export const TWITCH_CHAT_LEVELS = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'] as const;

export type TwitchChatLevelId = (typeof TWITCH_CHAT_LEVELS)[number];

/** Built-in command names every channel already answers; custom commands may not reuse them. */
export const TWITCH_CHAT_RESERVED_COMMAND_NAMES = ['commands', 'uptime', 'title'] as const;

/** One linked Twitch channel's chat-bot config, as returned to the dashboard/bot. */
export interface TwitchChatChannelDto {
  id: string;
  broadcasterLogin: string;
  broadcasterUserId: string;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error' | 'pending';
  lastError: string | null;
  commandPrefix: string;
  /** Whether channel-point reward redemptions are turned on for this channel (channel-points spec v1). */
  rewardsEnabled: boolean;
  createdAt: string;
}

/** `GET /guilds/:guildId/integrations/twitch-chat` — overall chat-bot availability + this guild's channels. */
export interface TwitchChatStatusDto {
  /** Whether Pavisie's own Twitch bot account (`TwitchBotIdentity`) has been authorized by the bot owner. */
  botConfigured: boolean;
  botLogin: string | null;
  /** Whether TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET are set on this deployment at all. */
  envConfigured: boolean;
  channels: TwitchChatChannelDto[];
}

export interface TwitchChatCommandDto {
  id: string;
  name: string;
  response: string;
  cooldownSeconds: number;
  minLevel: TwitchChatLevelId;
  enabled: boolean;
  createdAt: string;
}

export interface TwitchChatTimerDto {
  id: string;
  name: string;
  message: string;
  intervalMinutes: number;
  enabled: boolean;
  lastFiredAt: string | null;
  createdAt: string;
}

export interface UpdateTwitchChatChannelInput {
  enabled?: boolean;
  /** Exactly one printable, non-space, non-`/` character. */
  commandPrefix?: string;
  /** Turns channel-point reward redemptions on/off for this channel (channel-points spec v1). */
  rewardsEnabled?: boolean;
}

export interface CreateTwitchChatCommandInput {
  name: string;
  response: string;
  cooldownSeconds?: number;
  minLevel?: TwitchChatLevelId;
}

export interface UpdateTwitchChatCommandInput {
  name?: string;
  response?: string;
  cooldownSeconds?: number;
  minLevel?: TwitchChatLevelId;
  enabled?: boolean;
}

export interface CreateTwitchChatTimerInput {
  name: string;
  message: string;
  intervalMinutes: number;
}

export interface UpdateTwitchChatTimerInput {
  name?: string;
  message?: string;
  intervalMinutes?: number;
  enabled?: boolean;
}

/** Owner-only (`/owner/twitch-bot`): Pavisie's own Twitch bot account status. */
export interface TwitchBotIdentityDto {
  botLogin: string;
  botUserId: string;
  status: 'connected' | 'disconnected' | 'error' | 'pending';
  lastError: string | null;
  scopes: string[];
  connectedAt: string;
}

// ---------------------------------------------------------------------------
// Twitch channel-point rewards — extends the twitch-chat feature above (channel-points spec v1). A viewer
// redeeming a configured channel-point reward triggers an action: an OBS overlay SOUND/TTS, a TWITCH CHAT
// message, or a DISCORD post. Runtime lives alongside twitch-chat in
// packages/plugins/src/integrations/twitch-chat/; API routes extend apps/api/src/routes/twitch-chat.ts.
// ---------------------------------------------------------------------------

/** What a redeemed reward triggers, matching (lowercased) the `TwitchRewardActionKind` Prisma enum. */
export const TWITCH_REWARD_ACTION_KINDS = ['sound', 'tts', 'chat', 'discord'] as const;

export type TwitchRewardActionKindId = (typeof TWITCH_REWARD_ACTION_KINDS)[number];

/** One channel-point reward → action row for a linked Twitch chat channel. Only the fields matching `action`
 * are meaningful (validated at write time — see `createTwitchChatRewardSchema`'s `superRefine`). */
export interface TwitchChatRewardDto {
  id: string;
  /** Twitch custom reward id, when picked from the "list rewards from Twitch" dropdown; null means match
   * redemptions by `rewardTitle` (case-insensitively) instead. */
  rewardId: string | null;
  rewardTitle: string;
  enabled: boolean;
  action: TwitchRewardActionKindId;
  // SOUND
  soundUrl: string | null;
  volume: number;
  // TTS
  ttsTemplate: string | null;
  // CHAT
  chatTemplate: string | null;
  // DISCORD
  discordChannelId: string | null;
  discordTemplate: string | null;
  /** 0..3600 seconds, enforced in memory per reward. */
  cooldownSeconds: number;
  createdAt: string;
}

export interface CreateTwitchChatRewardInput {
  rewardId?: string | null;
  rewardTitle: string;
  action: TwitchRewardActionKindId;
  soundUrl?: string | null;
  volume?: number;
  ttsTemplate?: string | null;
  chatTemplate?: string | null;
  discordChannelId?: string | null;
  discordTemplate?: string | null;
  cooldownSeconds?: number;
}

export interface UpdateTwitchChatRewardInput {
  rewardId?: string | null;
  rewardTitle?: string;
  enabled?: boolean;
  action?: TwitchRewardActionKindId;
  soundUrl?: string | null;
  volume?: number;
  ttsTemplate?: string | null;
  chatTemplate?: string | null;
  discordChannelId?: string | null;
  discordTemplate?: string | null;
  cooldownSeconds?: number;
}

/** `GET /guilds/:guildId/integrations/twitch-chat/channels/:channelId/overlay` (and its regenerate action) —
 * the OBS browser-source URL. `url` carries the full capability URL (treat it like a password) only right
 * after it's generated/regenerated; `hasToken` alone is returned on subsequent reads, once a token exists. */
export interface TwitchOverlayInfoDto {
  url: string | null;
  hasToken: boolean;
}
