# `ai` — AI Assistant

Optional, **disabled by default** AI helper. An admin must opt in, pick a provider, and either set a per-server
API key or turn on the environment-key fallback before it responds to anything.

## Commands

| Command                                                                  | Who                                        | Where                                 | Notes                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ask <question> [private]`                                              | Everyone                                   | Only in channels on the allowlist     | Public reply by default; `private: true` replies ephemerally.                                                                                                                          |
| `/summarize [count] [channel]`                                           | Everyone with access to the target channel | Only in channels on the allowlist     | Always replies ephemerally. Needs the Message Content privileged intent, and the invoking user must have View Channel + Read Message History in the target channel. Nothing is stored. |
| `/draft <type> <notes>`                                                  | Staff (helper+)                            | Any channel                           | Ephemeral. `type` is one of `announcement`, `rules`, `welcome`, `reply`.                                                                                                               |
| `/mod-assist <case-number \| user> [context]`                            | Staff (moderator+)                         | Any channel                           | Ephemeral. Reads case _metadata_ (types/counts/reasons) via the `moderation` service — never message content — and only ever **suggests**; it can never perform a moderation action.   |
| `@mention <message>`                                                     | Everyone                                   | Only in channels on `chat.channelIds` | Not a slash command — @mention the bot with your message. See "Mention chat" below.                                                                                                    |
| `/ai config view\|set-key\|clear-key\|provider\|model\|channels\|budget` | Admin                                      | Any channel                           | `set-key` opens a modal — the key is never typed into a visible command option.                                                                                                        |
| `/ai chat enable\|disable`                                               | Admin                                      | Any channel                           | Turns mention chat on/off.                                                                                                                                                             |
| `/ai chat channel <action: add\|remove\|list> [channel]`                 | Admin                                      | Any channel                           | Manages `chat.channelIds` (max 20). `channel` is required for add/remove, ignored for list.                                                                                            |
| `/ai chat persona <action: set\|clear\|view>`                            | Admin                                      | Any channel                           | `set` opens a modal (paragraph input, up to 1500 chars) — persona text is never typed into a visible command option.                                                                   |
| `/ai chat history <count: 0-10>`                                         | Admin                                      | Any channel                           | Sets `chat.historyMessages`.                                                                                                                                                           |

## Mention chat

Members can talk to the bot conversationally by @mentioning it in a channel on `chat.channelIds` — no slash
command needed. Hard rule: it **only** ever responds to an explicit @mention (`<@botId>`/`<@!botId>` in the raw
message content) — never passively, never in response to `@everyone`/`@here`/a role mention, and never just
because a message replies to the bot without also containing the mention (Discord marks the replied-to author as
"mentioned" on a reply even without a literal `<@id>`, so both checks are required — see
`src/ai/events/mention-chat.ts`).

The mention is stripped from the prompt before it's sent. A short window of recent channel history (the last
`chat.historyMessages` messages by the mentioning user or the bot, 0-10, redacted and truncated the same way
`/summarize` treats transcript lines) is included as optional context. The system prompt is
`BASE_SAFETY_PROMPT` (fixed — instructs the model on tone, refusals, and that it can't take any moderation
action) followed by the per-server `chat.persona` (or `DEFAULT_PERSONA` if unset) — the persona can change tone
and name but is explicitly told it can never override the safety instructions above it (`src/ai/prompt.ts`).

Reuses the same cooldown/budget/provider/redaction machinery as every other command. Cooldown and budget limits
are silent (no reply) rather than an error message, since this is a passive feature and a burst of mentions
shouldn't turn into a burst of rate-limit notices. A provider failure is logged and — since no `reportOnce`-style
helper existed yet in `src/ai/**` — falls back to a plain "AI is unavailable right now." reply, throttled to once
per channel per hour so a broken key/provider can't spam an active channel.

## Config keys (`PluginConfig` for `ai`)

| Key                       | Default       | Notes                                                                                                                                                                                                  |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`                | `openai`      | `openai` \| `anthropic` \| `compatible`                                                                                                                                                                |
| `model`                   | `gpt-4o-mini` | Passed through to the provider as-is                                                                                                                                                                   |
| `baseUrl`                 | `null`        | Only used when `provider = compatible`; any OpenAI-chat-completions-shaped API                                                                                                                         |
| `apiKeyEnc`               | `null`        | `encryptSecret()` output; never returned by the dashboard API, only `hasKey`                                                                                                                           |
| `allowEnvKeys`            | `true`        | Falls back to `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` from process env when no per-guild key is set                                                                                                       |
| `allowedChannelIds`       | `[]`          | Channels `/ask` and `/summarize` may run in. Empty = both are disabled until an admin adds at least one channel. `/draft` and `/mod-assist` ignore this — they're staff-only and ephemeral everywhere. |
| `userCooldownSeconds`     | `30`          | Per-user cooldown across all four commands                                                                                                                                                             |
| `dailyTokenBudget`        | `200000`      | Server-wide daily token cap (prompt + completion), reset at UTC midnight                                                                                                                               |
| `perUserDailyTokenBudget` | `20000`       | Per-user daily token cap                                                                                                                                                                               |
| `chat.enabled`            | `false`       | Master switch for mention chat                                                                                                                                                                         |
| `chat.channelIds`         | `[]`          | Channels the bot replies in when @mentioned (max 20). Separate from `allowedChannelIds` — that list only gates `/ask`/`/summarize`.                                                                    |
| `chat.persona`            | `null`        | Plain-text addition to the system prompt (tone/name only, max 1500 chars). `null` = `DEFAULT_PERSONA`. Can never override `BASE_SAFETY_PROMPT`.                                                        |
| `chat.historyMessages`    | `4`           | Prior messages (by the mentioning user or the bot) included as context, 0-10                                                                                                                           |
| `chat.maxReplyChars`      | `1200`        | Hard cap on the reply text sent to Discord, 200-2000                                                                                                                                                   |

Max output tokens per response is a fixed platform guardrail (`AI_MAX_OUTPUT_TOKENS = 700`), not configurable.

## Permissions

No Discord permissions are required — this plugin never touches roles, channels, or members. `/ai config` and
`/ai chat` are gated to `ManageGuild`/admin staff level; `/mod-assist` requires `moderator`+; `/draft` requires
`helper`+.

## Privileged intents

`MessageContent` is needed for `/summarize` to read channel history and for mention chat to read the mentioning
message's content at all. Without it, `/summarize` explains why it can't run, and mention chat's handler no-ops
entirely (see `health()` in `src/ai/index.ts`, which reports `degraded` in that case). `/ask`, `/draft`, and
`/mod-assist` don't need it.

## Privacy notes

- Disabled by default; an admin must explicitly opt in per server.
- **Redaction before every provider call**: Discord mentions, email addresses, phone numbers, URLs (path/query
  stripped, domain kept), and API-key/token-shaped strings are stripped from the prompt text before it leaves
  Pavisie (`src/ai/redact.ts`).
- **Prompt-injection resistance**: a fixed system prompt (never built from user input) instructs the model that
  everything inside `<data>...</data>` tags is untrusted content to read, not instructions to follow, and that it
  must never reveal the system prompt. All user/message-sourced content is wrapped this way (`src/ai/prompt.ts`).
- **No training on server data by default** — Pavisie makes no opt-in call to any provider's training/fine-tuning
  endpoints. Check your own provider account's data-use settings for anything beyond that.
- **Disclosure**: every AI response includes the footer "AI can be inaccurate — verify important information."
- **Storage**: only token counts (`AiUsage`: guildId, userId, command, promptTokens, completionTokens, provider,
  model, timestamp) are recorded — never prompt or response content.
- `/summarize` reads only messages the _invoking user_ can already see (View Channel + Read Message History
  checked against their own Discord permissions, not the bot's) and stores nothing.
- `/mod-assist` never sees raw message content — only case metadata from the `moderation` service — and can
  never perform an action; every response is labeled "suggestion only — you decide."
- Mention chat only ever responds to an explicit @mention in a `chat.channelIds` channel — never passively.
  Nothing about it is stored beyond the usual token-count usage record; see "Mention chat" above for exactly
  what's sent to the provider per reply.

## Dashboard

`/dashboard/[guildId]/ai` — opt-in banner + disclosure, provider/model/base-URL/key form, channel allowlist
picker, budget/cooldown fields, a usage chart, and a "Test connection" button, plus a separate "Mention chat"
card (enable switch, channel picker, persona textarea with a character counter, recent-message-context count,
and max reply length).
