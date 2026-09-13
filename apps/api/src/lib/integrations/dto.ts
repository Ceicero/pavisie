// DTO mappers owned by the `integrations` build stage — kept in `lib/integrations/` (this plugin's own lib
// subtree) rather than the shared `lib/dto.ts`, since the base `IntegrationConnectionDto`/`WebhookEndpointDto`
// mappers there already cover the fields every other route needs; these add the integrations-specific detail.
import type {
  IntegrationConnection,
  TwitchBotIdentity,
  TwitchChatChannel,
  TwitchChatCommand,
  TwitchChatLevel,
  TwitchChatReward,
  TwitchChatTimer,
  TwitchRewardActionKind,
  WebhookDelivery,
  WebhookEndpoint,
} from '@pavisie/database';
import type {
  IntegrationConnectionDetailDto,
  TwitchBotIdentityDto,
  TwitchChatChannelDto,
  TwitchChatCommandDto,
  TwitchChatLevelId,
  TwitchChatRewardDto,
  TwitchChatTimerDto,
  TwitchRewardActionKindId,
  WebhookDeliveryDto,
  WebhookEndpointDetailDto,
} from '@pavisie/types/integrations';
import { CONNECTION_STATUS_MAP, toIntegrationConnectionDto, toWebhookEndpointDto } from '../dto';

export function toIntegrationConnectionDetailDto(row: IntegrationConnection): IntegrationConnectionDetailDto {
  const config = (row.config as Record<string, unknown> | null) ?? {};
  return {
    ...toIntegrationConnectionDto(row),
    label: row.label,
    target: typeof config.target === 'string' ? config.target : null,
    channelId: typeof config.channelId === 'string' ? config.channelId : null,
    roleId: typeof config.roleId === 'string' ? config.roleId : null,
    template: typeof config.template === 'string' ? config.template : null,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastError: row.lastError,
  };
}

export function toWebhookEndpointDetailDto(row: WebhookEndpoint): WebhookEndpointDetailDto {
  return {
    ...toWebhookEndpointDto(row),
    name: row.name,
    events: row.events,
    channelId: row.channelId,
    failureCount: row.failureCount,
    lastDeliveryAt: row.lastDeliveryAt ? row.lastDeliveryAt.toISOString() : null,
  };
}

export function toWebhookDeliveryDto(row: WebhookDelivery): WebhookDeliveryDto {
  return {
    id: row.id,
    endpointId: row.endpointId,
    direction: row.direction === 'INBOUND' ? 'inbound' : 'outbound',
    status: row.status,
    success: row.success,
    attempt: row.attempt,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Twitch chat bot (routes/twitch-chat.ts, routes/twitch-bot.ts) — DTO mappers only; input->enum mapping for
// writes (the reverse of TWITCH_CHAT_LEVEL_MAP) lives next to the routes that need it.
// ---------------------------------------------------------------------------------------------------------

export const TWITCH_CHAT_LEVEL_MAP: Record<TwitchChatLevel, TwitchChatLevelId> = {
  EVERYONE: 'everyone',
  SUBSCRIBER: 'subscriber',
  VIP: 'vip',
  MODERATOR: 'moderator',
  BROADCASTER: 'broadcaster',
};

export function toTwitchChatChannelDto(row: TwitchChatChannel): TwitchChatChannelDto {
  return {
    id: row.id,
    broadcasterLogin: row.broadcasterLogin,
    broadcasterUserId: row.broadcasterUserId,
    enabled: row.enabled,
    status: CONNECTION_STATUS_MAP[row.status],
    lastError: row.lastError,
    commandPrefix: row.commandPrefix,
    rewardsEnabled: row.rewardsEnabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toTwitchChatCommandDto(row: TwitchChatCommand): TwitchChatCommandDto {
  return {
    id: row.id,
    name: row.name,
    response: row.response,
    cooldownSeconds: row.cooldownSeconds,
    minLevel: TWITCH_CHAT_LEVEL_MAP[row.minLevel],
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toTwitchChatTimerDto(row: TwitchChatTimer): TwitchChatTimerDto {
  return {
    id: row.id,
    name: row.name,
    message: row.message,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Twitch channel-point rewards (channel-points spec v1) — extends the twitch-chat mappers above.
// ---------------------------------------------------------------------------------------------------------

/** Reverse of `TWITCH_REWARD_ACTION_ENUM_MAP` (routes/twitch-chat.ts) — Prisma enum -> input action id, for reads. */
export const TWITCH_REWARD_ACTION_MAP: Record<TwitchRewardActionKind, TwitchRewardActionKindId> = {
  SOUND: 'sound',
  TTS: 'tts',
  CHAT: 'chat',
  DISCORD: 'discord',
};

export function toTwitchChatRewardDto(row: TwitchChatReward): TwitchChatRewardDto {
  return {
    id: row.id,
    rewardId: row.rewardId,
    rewardTitle: row.rewardTitle,
    enabled: row.enabled,
    action: TWITCH_REWARD_ACTION_MAP[row.action],
    soundUrl: row.soundUrl,
    volume: row.volume,
    ttsTemplate: row.ttsTemplate,
    chatTemplate: row.chatTemplate,
    discordChannelId: row.discordChannelId,
    discordTemplate: row.discordTemplate,
    cooldownSeconds: row.cooldownSeconds,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Owner-only (`/owner/twitch-bot`) — never includes `accessTokenEnc`/`refreshTokenEnc`. */
export function toTwitchBotIdentityDto(row: TwitchBotIdentity): TwitchBotIdentityDto {
  return {
    botLogin: row.botLogin,
    botUserId: row.botUserId,
    status: CONNECTION_STATUS_MAP[row.status],
    lastError: row.lastError,
    scopes: row.scopes,
    connectedAt: row.createdAt.toISOString(),
  };
}
