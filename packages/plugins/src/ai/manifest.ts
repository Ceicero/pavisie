import { z } from 'zod';
import { defineManifest } from '../sdk';

/** Every output response carries this disclosure, per SPEC.md §K ("Clear disclosure that AI responses can be inaccurate"). */
export const AI_DISCLOSURE = 'AI can be inaccurate — verify important information.';

/** Hard ceiling on completion length, independent of any per-guild config (ARCHITECTURE.md task spec: "max output tokens 700"). */
export const AI_MAX_OUTPUT_TOKENS = 700;

export const configSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'compatible']).default('openai'),
  model: z.string().trim().min(1).max(200).default('gpt-4o-mini'),
  /** Only used when `provider === 'compatible'` — an OpenAI-chat-completions-shaped base URL override. */
  baseUrl: z.string().trim().url().nullable().default(null),
  /** `encryptSecret()` output (`v1:<iv>:<tag>:<ciphertext>`), or null if no per-guild key is configured. Never sent to the dashboard in plaintext. */
  apiKeyEnc: z.string().nullable().default(null),
  /** When true (default) and no per-guild key is set, fall back to `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` from process env. */
  allowEnvKeys: z.boolean().default(true),
  /** Channels `/ask` and `/summarize` may run in. Empty = nowhere for those two (they stay disabled until an admin picks channels). `/draft` and `/mod-assist` are staff-only and ephemeral, so they ignore this list. */
  allowedChannelIds: z.array(z.string()).max(50).default([]),
  userCooldownSeconds: z.number().int().min(0).max(3600).default(30),
  dailyTokenBudget: z.number().int().min(1000).max(10_000_000).default(200_000),
  perUserDailyTokenBudget: z.number().int().min(100).max(1_000_000).default(20_000),
  /**
   * "Mention chat" — members can talk to the bot in designated channels by @mentioning it, with a per-server
   * persona. Separate from `allowedChannelIds` (which only gates `/ask` and `/summarize`): a channel needs to be
   * in `chat.channelIds`, not `allowedChannelIds`, for mention chat to respond there.
   */
  chat: z
    .object({
      enabled: z.boolean().default(false),
      /** Channels the bot replies in when @mentioned. Empty = mention chat never triggers, even if `enabled`. */
      channelIds: z.array(z.string()).max(20).default([]),
      /** Plain-text addition to the system prompt (tone/name only). Null = the built-in `DEFAULT_PERSONA` (see prompt.ts). Never overrides `BASE_SAFETY_PROMPT`, which always takes precedence. */
      persona: z.string().trim().min(1).max(1500).nullable().default(null),
      /** How many prior messages (by the mentioning user or the bot, in the same channel) to include as short-term context. */
      historyMessages: z.number().int().min(0).max(10).default(4),
      /** Hard cap on the reply text sent back to Discord; the completion itself is separately capped by `AI_MAX_OUTPUT_TOKENS`. */
      maxReplyChars: z.number().int().min(200).max(2000).default(1200),
    })
    .default({}),
});
export type AiConfig = z.infer<typeof configSchema>;

export const manifest = defineManifest({
  id: 'ai',
  name: 'AI Assistant',
  description:
    'Optional, disabled-by-default AI helper (/ask, /summarize, /draft, /mod-assist, @mention chat) with per-server opt-in, per-channel allowlisting, cooldowns, and token budgets.',
  category: 'ai',
  version: '0.1.0',
  defaultEnabled: false,
  permissions: [],
  intents: [],
  // No global env var is required to load the plugin — the provider and API key are configured per-guild via
  // `/ai config` (or the dashboard), not through process env. `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` are an
  // optional env fallback (config.allowEnvKeys) checked at request time, not at plugin-availability time.
  requiredEnv: [],
  optionalEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  // `/summarize` reads channel history and mention chat reads the mentioning message's raw content — both need
  // the privileged Message Content intent. Without it the registry marks this plugin `degraded` (not
  // unavailable): `/ask`, `/draft`, and `/mod-assist` are unaffected either way.
  privilegedIntents: ['MessageContent'],
  configSchema,
  dashboard: { path: '/dashboard/[guildId]/ai', label: 'AI Assistant', icon: 'sparkles' },
  privacyNotes: [
    'Disabled by default. An admin must opt in and configure a provider and API key (or enable the env-key fallback) before it will respond.',
    `${AI_DISCLOSURE} This disclosure is attached to every AI response.`,
    'Message content sent to the configured provider is redacted where possible first (mentions, emails, phone numbers, URL paths, and token/key-shaped strings are stripped before the request leaves Pavisie).',
    "The platform does not opt server data into provider model training by default; check your provider's own data-use terms for your account.",
    "/summarize only reads messages the invoking user could already see and permits (channel view + read history) — it never reads other channels on the user's behalf.",
    '/mod-assist reads moderation case metadata (types, counts, reasons) for context, never raw message content, and only ever suggests — it can never perform a moderation action itself.',
    'Only token counts (prompt/completion), not message content, are stored in usage records (`AiUsage`), visible to server staff in the dashboard.',
    'Mention chat (chat.enabled) only ever replies when a member explicitly @mentions the bot in one of the configured chat.channelIds — never passively, and never just because a message replies to the bot. The mentioning message plus up to chat.historyMessages recent messages from that channel (redacted, same as everything else) are sent to the configured provider for that one reply; nothing is stored beyond the usual token-count usage record.',
  ],
});
