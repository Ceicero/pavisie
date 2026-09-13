/** DTOs for the `ai` plugin (ARCHITECTURE.md §7.1 row 'ai', SPEC.md §K). Imported via the `@pavisie/types/ai` subpath — not re-exported from `./index` (see the `ai` build stage's ownership notes). */

export type AiProviderId = 'openai' | 'anthropic' | 'compatible';

/**
 * "Mention chat" settings — members talk to the bot by @mentioning it in one of `channelIds`, with an optional
 * per-server persona. Separate from `AiSettingsDto.allowedChannelIds`, which only gates `/ask` and `/summarize`.
 */
export interface AiChatSettingsDto {
  enabled: boolean;
  /** Channels the bot replies in when @mentioned (max 20). Empty = mention chat never triggers. */
  channelIds: string[];
  /** Null = the built-in default persona. Max 1500 chars. */
  persona: string | null;
  /** How many prior messages (by the mentioning user or the bot) to include as context. 0-10. */
  historyMessages: number;
  /** Hard cap on the reply length sent back to Discord. 200-2000. */
  maxReplyChars: number;
}

/** `GET/PUT /guilds/:guildId/ai/settings` response shape. The encrypted key itself is never returned — only `hasKey`. */
export interface AiSettingsDto {
  guildId: string;
  provider: AiProviderId;
  model: string;
  /** Only meaningful for `provider: 'compatible'`; null otherwise. */
  baseUrl: string | null;
  hasKey: boolean;
  allowEnvKeys: boolean;
  allowedChannelIds: string[];
  userCooldownSeconds: number;
  dailyTokenBudget: number;
  perUserDailyTokenBudget: number;
  chat: AiChatSettingsDto;
}

/** `PUT /guilds/:guildId/ai/settings` request body. `apiKey` sets a new key (encrypted server-side); `clearKey` removes it. */
export interface AiSettingsPatchDto {
  provider?: AiProviderId;
  model?: string;
  baseUrl?: string | null;
  apiKey?: string;
  clearKey?: boolean;
  allowEnvKeys?: boolean;
  allowedChannelIds?: string[];
  userCooldownSeconds?: number;
  dailyTokenBudget?: number;
  perUserDailyTokenBudget?: number;
  /** Always sent whole — the dashboard form keeps `chat` as one draft object, same as every other settings field. */
  chat?: AiChatSettingsDto;
}

export interface AiUsageDailyPointDto {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export interface AiUsageTopCommandDto {
  command: string;
  requests: number;
  totalTokens: number;
}

/** `GET /guilds/:guildId/ai/usage` response — token counts only, never message content (ARCHITECTURE.md §K). */
export interface AiUsageSummaryDto {
  guildId: string;
  rangeDays: number;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  dailyTokenBudget: number;
  perUserDailyTokenBudget: number;
  daily: AiUsageDailyPointDto[];
  topCommands: AiUsageTopCommandDto[];
}

/** `POST /guilds/:guildId/ai/test` response, mirrored from the bot-action `ai.test` result. */
export interface AiTestResultDto {
  ok: boolean;
  detail?: string;
}
