# `utility` plugin

General-purpose, member-facing utility commands: server/user lookups, timestamps, a calculator, AFK status, an
embed builder, optional translation/weather adapters, and a bot/plugin health summary. Default enabled.

## What it does

- **`/help`** — an ephemeral `StringSelectMenu` listing every currently-enabled plugin; picking one shows that
  plugin's full command list (name + description), built from a live `application.commands` fetch and grouped by
  owning plugin via the static `help-map.ts` table (falls back to a one-line-per-plugin summary from the
  manifest registry if the live fetch is ever unavailable).
- **`/utility userinfo|serverinfo|avatar|banner|roleinfo|channelinfo`** — read-only lookups rendered as embeds.
  `avatar`/`banner` fetch the target with `force: true` where needed (banners aren't cached by default).
- **`/utility timestamp <text> [timezone]`** — parses free-form date/time text (ISO 8601, RFC 2822, a curated
  list of common explicit formats, then a native `Date.parse` fallback) via `luxon`, and prints all seven
  Discord `<t:unix:style>` tags. Defaults to your saved timezone (`/utility timezone set`), then `UTC`.
- **`/utility timezone set|get|list`** — stores an IANA timezone on your cross-guild `UserProfile.timezone`, with
  autocomplete (and `list`) over every zone the Node runtime knows about (`Intl.supportedValuesOf('timeZone')`).
- **`/utility calculator <expression>`** — a hand-written tokenizer + recursive-descent evaluator (`calculator.ts`)
  for `+ - * / % ^`, parentheses, unary minus, `sqrt abs round floor ceil min max sin cos tan log ln exp`, and
  the constants `pi`/`e`. **No `eval`/`Function`/`vm` anywhere** — unrecognized identifiers (`process`, `require`,
  `constructor`, ...) are rejected at parse time as "unknown identifier/function", never evaluated.
- **`/utility afk [message]`** — toggles AFK (`AfkStatus`); the `messageCreate` handler clears it the moment you
  send a message, and replies (at most once per mentioned user per 60s, via a Redis `NX` dedupe key) when someone
  mentions a currently-AFK member.
- **`/utility translate <text> <to> [from]`** — routes through the configured adapter (`TRANSLATE_PROVIDER`:
  `none` | `deepl` | `libretranslate`); replies with a clear "not configured" message otherwise. Ephemeral, 5s
  per-user cooldown.
- **`/utility weather <location>`** — routes through the configured adapter (`WEATHER_PROVIDER`: `none` |
  `open-meteo` (free, no key, geocodes then fetches current conditions) | `openweathermap`); results are cached
  10 minutes in Redis per `(units, location)`. 5s per-user cooldown (skipped on a cache hit).
- **`/utility status`** — bot/plugin health summary, reusing the `host` service's `getPluginHealth`/`getBotStats`
  (same data `/health` in `admin` uses, presented per-plugin here).
- **`/embed builder`** — a 5-field modal (title/description/color hex/image URL/footer) → sanitized, ephemeral
  preview with three components: a `ChannelSelectMenu` ("send to channel", checked against the bot's permissions
  in the chosen channel before sending), an "Edit" button (re-opens the modal pre-filled), and an "Import JSON"
  button (a modal accepting either this plugin's flat shape or a standard Discord embed JSON object). Requires
  Manage Messages; additionally requires `helper` staff level when `embedBuilderStaffOnly` is on (default).
- **Context menu "User info"** — same embed as `/utility userinfo`, on any user.

## Sanitisation & safety

- Embed text fields go through `sanitizeEmbedText` (strips `@everyone`/`@here`/mentions, truncates to Discord's
  embed field limits) before ever being previewed or sent.
- The embed builder's image URL is validated with core's `assertPublicHttpUrl` (https-only, rejects private/
  loopback/link-local/metadata addresses) before it's ever put in an embed or fetched.
- The LibreTranslate adapter also runs its configured base URL through `assertPublicHttpUrl` before every
  request — `LIBRETRANSLATE_URL` must be `https://`.
- The calculator's tokenizer only recognizes digits/`.`, letters/`_` (identifiers), the operator/paren/comma
  characters, and whitespace — anything else is a parse error, and identifiers are checked against a fixed
  whitelist of function names and the `pi`/`e` constants before ever being "called".

## Config keys (`utility.*`, per guild)

| Key                      | Type                     | Default    | Notes                                                                                                                                              |
| ------------------------ | ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `afkEnabled`             | boolean                  | `true`     | Turns off both `/utility afk` and the mention-reply behavior.                                                                                      |
| `translateDefaultTarget` | string                   | `'en'`     | Reserved for a future default-target UX; the command's `to` option is currently always required.                                                   |
| `weatherUnits`           | `'metric' \| 'imperial'` | `'metric'` | Controls both the adapter request and the displayed units.                                                                                         |
| `embedBuilderStaffOnly`  | boolean                  | `true`     | When on, `/embed builder` additionally requires `helper` staff level (on top of the Manage Messages Discord permission, which is always required). |

No dashboard page: utility is configured entirely through the plugin config drawer (auto-generated from
`configSchema`) on `/dashboard/[guildId]/plugins` — `manifest.dashboard` is intentionally left `undefined`.

## Permissions

| Permission      | Feature                            | Optional | Fallback                                                                                                                                                              |
| --------------- | ---------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View Channel    | every read-only command            | No       | Interaction replies go over the interaction token; nothing actually needs this, listed for completeness.                                                              |
| Embed Links     | rich embed replies                 | Yes      | Discord may render some embeds as plain links without it.                                                                                                             |
| Manage Messages | `/embed builder` → send to channel | No       | The command is hidden from members without it (`setDefaultMemberPermissions`); "Send to channel" also re-checks the bot's own permissions in the destination channel. |

No privileged intents: the AFK-mention flow only reads `message.mentions`/`message.author`, which are present on
every gateway message regardless of the Message Content intent.

## Privacy

- `/utility afk` stores only your optional message and the time you went AFK; cleared automatically on your next
  message.
- `/utility timezone set` stores an IANA timezone string on your cross-guild `UserProfile`, used only to render
  `/utility timestamp` in your local time.
- `/utility translate`/`/utility weather` send only the text/location you provide to the configured third-party
  adapter — never message history — and only when an operator has configured a provider.
- The embed builder stores nothing durably; the draft lives only in Redis (`pavisie:pending:<id>`, 10-minute TTL)
  while you're actively editing it, and is deleted once its TTL expires.

## Known deviation from this task's literal instructions (documented, not a bug)

The spec said to build the `/help` command catalog "at onLoad from `ctx.client.application.commands` (fetch)".
That's not actually reachable: per `apps/bot/src/index.ts` / ARCHITECTURE.md §9, `loadPlugins()` (and every
plugin's `onLoad`) runs **before** `client.login()`, so `ctx.client.application` is still `null` at `onLoad`
time — fetching then would always fail. `command-catalog.ts` instead fetches lazily on first `/help` use (after
which point the client is guaranteed logged in) and caches the result in-process for 10 minutes, which is both
correct and self-healing (a failed fetch is simply retried on the next `/help` call rather than staying broken
for the process's whole lifetime).

## Files

```
manifest.ts                  PluginManifest (no dashboard entry — config-drawer only)
calculator.ts                 safe expression tokenizer/evaluator (pure, unit-tested)
timestamp.ts                   date/time text parsing + IANA timezone helpers (pure, unit-tested)
format.ts                       shared embed-formatting helpers (permission summary, channel type labels)
help-map.ts                      static top-level-command-name -> plugin id map for /help
command-catalog.ts                 live application-command fetch + grouping for /help (see deviation note above)
embed-payload.ts                    /embed builder sanitisation + JSON import parsing (pure, unit-tested)
index.ts                             wires manifest + commands + components + events, registers locales
adapters/
  translate/{types,deepl,libretranslate,index}.ts   TRANSLATE_PROVIDER adapter selection
  weather/{types,open-meteo,openweathermap,index}.ts  WEATHER_PROVIDER adapter selection
commands/
  help.ts                       /help
  utility.ts                     /utility <subcommand...> (userinfo, serverinfo, avatar, banner, roleinfo,
                                  channelinfo, timestamp, timezone set|get|list, calculator, afk, translate,
                                  weather, status)
  embed.ts                        /embed builder + the shared create/edit modal builder
  user-info-context.ts              context menu "User info"
components/
  help.ts                        /help's plugin-picker StringSelect handler
  embed-builder.ts                 create/edit/import modals, "send to channel" ChannelSelect, edit/import buttons
events/
  afk.ts                        messageCreate: clears the sender's AFK, notifies mentioners of AFK targets
locales/en.json                 utility namespace strings
__tests__/
  calculator.test.ts             precedence/associativity, functions, injection-string rejection, huge numbers
  timestamp.test.ts               format parsing + timezone validation
  translate-adapters.test.ts       deepl/libretranslate request shapes + error handling (mocked fetch)
  weather-adapters.test.ts          open-meteo/openweathermap request shapes + error handling (mocked fetch)
  embed-payload.test.ts             sanitisation, color parsing, JSON import (both shapes), error cases
  help-map.test.ts                   HELP_MAP coverage over allPlugins' actually-registered commands
```
