# Pavisie — Architecture & Coding Conventions

This document is binding for everyone (human or agent) writing code in this repo. It fixes the decisions that
`SPEC.md` leaves open so that independently-built parts fit together. When SPEC.md and this file conflict on a
mechanism, this file wins; when they conflict on a _requirement_, SPEC.md wins.

---

## 1. Repository layout

```
pavisie/
├── apps/
│   ├── bot/            @pavisie/bot        Discord gateway process + BullMQ workers
│   ├── api/            @pavisie/api        Fastify REST API, Discord OAuth, webhook receivers, OpenAPI
│   ├── web/            @pavisie/web        Next.js 15 (App Router) marketing site + per-guild config dashboard (/dashboard/**, §11)
│   └── dashboard/      @pavisie/dashboard  Next.js 15 (App Router); legacy app.pavisie.com redirector today, owner-only ops console next (§11a)
├── packages/
│   ├── types/          @pavisie/types      Shared TS types (no runtime deps)
│   ├── core/           @pavisie/core       env config, logger, errors, encryption, permissions, rate limiting, i18n, utils
│   ├── database/       @pavisie/database   Prisma schema, client singleton, migrations, seed
│   ├── plugins/        @pavisie/plugins    Plugin SDK + every feature plugin
│   └── ui/             @pavisie/ui         Shared component library (Tailwind + Radix), used by both apps/web's dashboard routes and apps/dashboard
├── infra/
│   ├── docker/         Dockerfile.bot, Dockerfile.api, Dockerfile.web, Dockerfile.dashboard
│   └── DEPLOYMENT.md
├── docs/               SPEC.md, ARCHITECTURE.md, PERMISSIONS.md, SECURITY.md, PRIVACY_POLICY_TEMPLATE.md, ROADMAP.md, PLUGINS.md, TROUBLESHOOTING.md
├── .github/workflows/ci.yml
├── docker-compose.yml
├── .env.example
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.config.js  .prettierrc  .gitignore  .nvmrc
└── README.md
```

## 2. Toolchain & versions (pin these ranges)

| Tool                                                                                     | Version                                    | Notes                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                                                                                     | >=22 (`.nvmrc` = 22)                       | dev machine runs 24                                                                                                                                               |
| pnpm                                                                                     | 9.15.x (`"packageManager": "pnpm@9.15.9"`) | pnpm workspaces, **no turbo**                                                                                                                                     |
| typescript                                                                               | ^5.6                                       | strict                                                                                                                                                            |
| discord.js                                                                               | ^14.16                                     |                                                                                                                                                                   |
| prisma / @prisma/client                                                                  | ^6.1                                       |                                                                                                                                                                   |
| ioredis                                                                                  | ^5.4                                       |                                                                                                                                                                   |
| bullmq                                                                                   | ^5.30                                      |                                                                                                                                                                   |
| fastify                                                                                  | ^5.1                                       | + @fastify/cookie ^11, @fastify/cors ^10, @fastify/helmet ^13, @fastify/rate-limit ^10, @fastify/swagger ^9, @fastify/swagger-ui ^5, fastify-type-provider-zod ^4 |
| next                                                                                     | ^15.1                                      | react ^19, react-dom ^19                                                                                                                                          |
| tailwindcss                                                                              | ^3.4                                       | classic `tailwind.config.ts` (NOT v4 CSS-first)                                                                                                                   |
| zod                                                                                      | ^3.23                                      | (not zod 4)                                                                                                                                                       |
| pino                                                                                     | ^9                                         | pino-pretty ^13 (dev only)                                                                                                                                        |
| vitest                                                                                   | ^3                                         |                                                                                                                                                                   |
| @playwright/test                                                                         | ^1.49                                      |                                                                                                                                                                   |
| eslint                                                                                   | ^9 (flat config)                           | typescript-eslint ^8, eslint-config-prettier                                                                                                                      |
| prettier                                                                                 | ^3                                         |                                                                                                                                                                   |
| tsx                                                                                      | ^4.19                                      | runs bot & api from TS source                                                                                                                                     |
| @tanstack/react-query                                                                    | ^5                                         | dashboard data fetching                                                                                                                                           |
| next-themes                                                                              | ^0.4                                       | dark mode                                                                                                                                                         |
| lucide-react                                                                             | latest                                     | icons                                                                                                                                                             |
| class-variance-authority, clsx, tailwind-merge                                           | latest                                     | ui                                                                                                                                                                |
| @radix-ui/react-{dialog,switch,select,tabs,tooltip,dropdown-menu,checkbox,label,popover} | latest                                     | ui primitives                                                                                                                                                     |
| safe-regex2                                                                              | ^4                                         | regex safety heuristic                                                                                                                                            |
| dotenv                                                                                   | ^16                                        |                                                                                                                                                                   |

## 3. Module system & build strategy — SOURCE-FIRST WORKSPACE PACKAGES

- Every package/app has `"type": "module"`. ESM everywhere. **No `__dirname`/`require`** — use `import.meta.url` + `fileURLToPath` when a path is needed.
- Workspace packages export **TypeScript source directly** — no build step for libraries:
  ```json
  {
    "name": "@pavisie/core",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" },
    "types": "./src/index.ts",
    "scripts": { "typecheck": "tsc --noEmit", "lint": "eslint src", "test": "vitest run" }
  }
  ```
  (Packages with subpath entry points may add explicit entries, e.g. `"./manifests": "./src/manifests.ts"`.)
- Apps `bot` and `api` run with `tsx` in dev (`tsx watch src/index.ts`) **and** in production Docker (`tsx src/index.ts`). This is deliberate: zero build pipeline, one less thing to break. `typecheck` = `tsc --noEmit`.
- Dashboard uses `next build`; `next.config.ts` sets `transpilePackages: ['@pavisie/ui', '@pavisie/types', '@pavisie/core']`. The dashboard **never imports `@pavisie/database` or `@pavisie/plugins`** — it talks to the API only.
- Workspace deps are declared as `"@pavisie/core": "workspace:*"`.
- `tsconfig.base.json`:
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "lib": ["ES2022"],
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "resolveJsonModule": true,
      "isolatedModules": true,
      "forceConsistentCasingInFileNames": true,
      "noEmit": true,
      "declaration": false,
      "types": ["node"]
    }
  }
  ```
  Each package: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "vitest.config.ts"], "compilerOptions": { ... } }`. Dashboard adds `"jsx": "preserve"`, `"lib": ["dom","dom.iterable","ES2022"]`, `"plugins": [{"name":"next"}]`, `"incremental": true`.
- Imports between files inside a package use relative paths **without** `.js` extensions (Bundler resolution + tsx + vitest + next all accept this).
- Root scripts (`package.json`):
  ```
  dev            → concurrently runs bot, api, dashboard dev (script `pnpm -r --parallel --filter ./apps/* run dev`)
  lint           → pnpm -r run lint
  typecheck      → pnpm -r run typecheck
  test           → pnpm -r run test
  test:e2e       → pnpm --filter @pavisie/dashboard test:e2e
  build          → pnpm -r run build          (only dashboard has a real build; others are no-ops or omitted)
  db:generate    → pnpm --filter @pavisie/database generate
  db:migrate     → pnpm --filter @pavisie/database migrate:deploy
  db:migrate:dev → pnpm --filter @pavisie/database migrate:dev
  db:seed        → pnpm --filter @pavisie/database seed
  commands:register → pnpm --filter @pavisie/bot register
  format         → prettier --write .
  ```
- Root `.env` is the single env file; apps load it with `dotenv` from repo root (`config({ path: findUp('.env') })` — core exposes `loadEnv()` which walks up from `process.cwd()` looking for `.env`; missing file is fine).
- ESLint: one root `eslint.config.js` (flat) using typescript-eslint recommended (non-type-checked, to keep it fast), `eslint-config-prettier` last, ignores `**/dist`, `**/.next`, `**/node_modules`, `**/generated`. Rule tweaks: `@typescript-eslint/no-unused-vars: ["warn", {argsIgnorePattern:"^_", varsIgnorePattern:"^_"}]`, `@typescript-eslint/no-explicit-any: "warn"`. Package `lint` scripts run `eslint .` from the package dir using the root config (`eslint` finds the root config automatically since flat config lookup starts from cwd — so each package's lint script is `eslint --config ../../eslint.config.js src` to be explicit).

## 4. Environment variables (`.env.example`) — all read through `@pavisie/core` `env`

Required (process fails fast with a clear message if missing where needed):

```
NODE_ENV=development
LOG_LEVEL=info
DATABASE_URL=postgresql://pavisie:pavisie@localhost:5432/pavisie
REDIS_URL=redis://localhost:6379
DISCORD_TOKEN=                # bot only
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=        # api only (OAuth)
DISCORD_OAUTH_REDIRECT_URI=http://localhost:3001/auth/discord/callback
ENCRYPTION_KEY=               # 32 bytes, base64. Generate: openssl rand -base64 32
SESSION_SECRET=               # >=32 chars random. cookie signing
API_PORT=3001
API_BASE_URL=http://localhost:3001
DASHBOARD_URL=http://localhost:3003            # CORS allowlist + OAuth return (config dashboard lives in web now, §11)
NEXT_PUBLIC_API_URL=http://localhost:3001      # web (marketing + dashboard routes) → api
```

Optional:

```
BOT_OWNER_IDS=                # comma-separated user IDs (bot-owner-only commands, protected from moderation)
DEV_GUILD_ID=                 # if set, `register` registers commands to this guild only (instant) instead of globally
BOT_HEALTH_PORT=3002          # tiny HTTP /health for Docker
ENABLE_MESSAGE_CONTENT_INTENT=false   # privileged; enable only after Discord approval/eligibility
ENABLE_GUILD_MEMBERS_INTENT=true      # privileged; needed for joins/leaves, welcome, raid detection, role persistence
ENABLE_GUILD_PRESENCES_INTENT=false   # privileged; not used by default
COOKIE_DOMAIN=                # prod: shared parent domain for api+dashboard cookies
TRUST_PROXY=false             # integer hop count, not a boolean; production behind Railway/Render must be `1` — see infra/DEPLOYMENT.md
E2E_TEST_MODE=false           # enables /auth/test-login (NEVER in production; api refuses if NODE_ENV=production)
# Integrations / adapters (all optional; features disable themselves when unset)
TWITCH_CLIENT_ID= TWITCH_CLIENT_SECRET= TWITCH_EVENTSUB_SECRET=
YOUTUBE_API_KEY=
GITHUB_WEBHOOK_SECRET= # vestigial — the GitHub connector was removed 2026-09-02 (see §18a); no code reads this
KOFI_URL=   # donations: the Ko-fi page to link out to; unset = donations not offered, see §18
REDDIT_CLIENT_ID= REDDIT_CLIENT_SECRET= REDDIT_USER_AGENT=
STEAM_API_KEY=
GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID= MICROSOFT_CLIENT_SECRET=
INSTAGRAM_CLIENT_ID= INSTAGRAM_CLIENT_SECRET=   # Instagram API with Instagram Login, own-account connect only
OPENAI_API_KEY= ANTHROPIC_API_KEY=
TRANSLATE_PROVIDER=none       # none | deepl | libretranslate
DEEPL_API_KEY= LIBRETRANSLATE_URL= LIBRETRANSLATE_API_KEY=
WEATHER_PROVIDER=none         # none | openweathermap | open-meteo (open-meteo needs no key)
OPENWEATHERMAP_API_KEY=
CAPTCHA_PROVIDER=none         # none | hcaptcha | turnstile — optional for roles plugin verification
HCAPTCHA_SITE_KEY= HCAPTCHA_SECRET= TURNSTILE_SITE_KEY= TURNSTILE_SECRET=
MEDIA_PROVIDER=none           # none | <compliant provider id>; media plugin is unavailable when none
PUBLIC_WEBHOOK_BASE_URL=      # public https base for inbound webhooks (EventSub, GitHub, generic)
```

`@pavisie/core` exports `env` (a zod-validated object) with **all keys optional except NODE_ENV/LOG_LEVEL**, plus `requireEnv('DISCORD_TOKEN')` helper that throws `ConfigError` with a helpful message. Each app validates the subset it needs at boot.

## 5. `@pavisie/types` (pure types)

- `StaffLevel = 'member' | 'helper' | 'moderator' | 'admin' | 'owner'` (ordered; helper `STAFF_LEVEL_RANK`).
- `PluginId` string union of all plugin ids (§7.1).
- `PlatformEventMap` — typed in-process event bus payloads (see §7.6).
- API DTOs (shared between api & dashboard): `ApiError`, `SessionUser`, `GuildSummary`, `PluginSummary`, `GuildConfigDto`, `AuditLogEntryDto`, `ModerationCaseDto`, `AutomodRuleDto`, `TicketDto`, `RolePanelDto`, `IntegrationConnectionDto`, `AnalyticsDto`, `RetentionPolicyDto`, `Paginated<T>`.
- Branded `Snowflake = string`.

## 6. `@pavisie/core` (exports from `src/index.ts`)

| Module                     | Exports                                                                                                                                                                                                                                                                                           | Notes                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.ts`                   | `loadEnv()`, `env`, `requireEnv()`, `isProduction`                                                                                                                                                                                                                                                | zod schema; never logs values                                                                                                                                                                              |
| `logger.ts`                | `createLogger(name)`, `logger`                                                                                                                                                                                                                                                                    | pino; `redact` paths: `*.token, *.accessToken, *.refreshToken, *.password, *.secret, *.authorization, req.headers.authorization, req.headers.cookie, *.content, *.messageContent, *.apiKey`; pretty in dev |
| `errors.ts`                | `AppError(code, message, {status, details, expose})`, `ValidationError`, `PermissionError`, `NotFoundError`, `RateLimitError`, `ConfigError`, `ExternalServiceError`, `isAppError`, `toPublicError(err)`                                                                                          | `toPublicError` never leaks stack/secrets                                                                                                                                                                  |
| `crypto/encryption.ts`     | `encryptSecret(plain, key?)`, `decryptSecret(cipher, key?)`, `generateEncryptionKey()`, `EncryptedString` format `v1:<iv b64>:<tag b64>:<ciphertext b64>` (AES-256-GCM, 12-byte IV, key from `ENCRYPTION_KEY` base64)                                                                             | key rotation: `ENCRYPTION_KEY_PREVIOUS` supported for decrypt fallback                                                                                                                                     |
| `crypto/signatures.ts`     | `timingSafeEqualStr`, `verifyHmacSha256(payload, secret, signature, {prefix})`, `verifyGithubSignature`, `verifyStripeSignature(payload, header, secret, toleranceSec)`, `verifyTwitchEventSubSignature`, `verifyDiscordInteractionSignature(publicKey, sig, ts, body)` (ed25519 via node:crypto) | pure functions, unit tested                                                                                                                                                                                |
| `permissions/staff.ts`     | `resolveStaffLevel({ member, guildOwnerId, botOwnerIds, staffRoles: {adminRoleIds, modRoleIds, helperRoleIds} }): StaffLevel`, `hasStaffLevel(level, required)`                                                                                                                                   | Discord perms fallback: Administrator/ManageGuild → admin; ModerateMembers/KickMembers/BanMembers/ManageMessages → moderator                                                                               |
| `permissions/hierarchy.ts` | `checkModerationTarget({ actor, target, botMember, guildOwnerId, botOwnerIds }): { ok: true } \| { ok: false; reason: HierarchyReason }` where reason ∈ `'self' \| 'bot' \| 'guild_owner' \| 'bot_owner' \| 'target_higher_or_equal_than_actor' \| 'target_higher_or_equal_than_bot'`             | takes plain data (`{ id, highestRolePosition, isBot }`) so it is unit-testable without discord.js                                                                                                          |
| `permissions/discord.ts`   | `PERMISSION_NAMES`, `describePermission(flag)`, `missingPermissions(member/channel, required)`, `INVITE_PERMISSIONS` (least-privilege default set), `buildInviteUrl(clientId, permissions)`                                                                                                       |                                                                                                                                                                                                            |
| `ratelimit.ts`             | `RateLimiter` (Redis sliding window via `MULTI INCR/PEXPIRE`), `MemoryRateLimiter` (same interface, for tests), `Cooldowns` (`take(key, seconds)`)                                                                                                                                                | interface `RateLimiterLike { consume(key, limit, windowMs): Promise<{allowed, remaining, resetMs}> }`                                                                                                      |
| `redis.ts`                 | `createRedis(url)`, `getRedis()` singleton, `redisKey(...parts)` → `pavisie:${parts.join(':')}`                                                                                                                                                                                                  |                                                                                                                                                                                                            |
| `i18n/index.ts`            | `t(key, vars?, locale?)`, `locales/en.json`, `resolveLocale(discordLocale)`                                                                                                                                                                                                                       | fallback to en; interpolation `{name}`                                                                                                                                                                     |
| `audit.ts`                 | `AuditAction` string constants (`config.update`, `plugin.enable`, `plugin.disable`, `moderation.*`, `automod.rule.*`, `ticket.*`, `integration.*`, `retention.update`, `data.export`, `data.delete`, ...), `type AuditEntry`                                                                      | writer lives in database package (`writeAudit`)                                                                                                                                                            |
| `utils/safe-regex.ts`      | `validateUserRegex(pattern, flags): {ok, error?}` (max length 256, `safe-regex2`, disallow lookbehind-heavy nesting), `safeTest(re, input, {maxInputLength=2000})`                                                                                                                                |                                                                                                                                                                                                            |
| `utils/ssrf.ts`            | `assertPublicHttpUrl(url): Promise<URL>` (https/http only, no creds in URL, resolves DNS and rejects private/loopback/link-local/metadata IPs, rejects ports other than 80/443 unless allowlisted), `SsrfError`                                                                                   | uses `node:dns/promises`; unit tests mock lookup                                                                                                                                                           |
| `utils/sanitize.ts`        | `escapeMarkdown`, `escapeHtml`, `sanitizeFilename`, `truncate(str, max)`, `sanitizeEmbedText`, `stripMentions`                                                                                                                                                                                    |                                                                                                                                                                                                            |
| `utils/time.ts`            | `parseDuration('10m' \| '2h' \| '3d')` → ms or null, `formatDuration`, `discordTimestamp(date, style)`                                                                                                                                                                                            |                                                                                                                                                                                                            |
| `utils/ids.ts`             | `newId()` (crypto.randomUUID), `shortId()`                                                                                                                                                                                                                                                        |                                                                                                                                                                                                            |
| `utils/pagination.ts`      | `paginate(params)`                                                                                                                                                                                                                                                                                |                                                                                                                                                                                                            |
| `events.ts`                | `PlatformEvents` (typed EventEmitter over `PlatformEventMap`), `createPlatformEvents()`                                                                                                                                                                                                           |                                                                                                                                                                                                            |
| `constants.ts`             | `BRAND = { name: 'Pavisie', color: 0xc7933d, ... }`, `brandIconUrl(env)`, `EMBED_LIMITS`                                                                                                                                                                                                         | gold-5 per §20                                                                                                                                                                                             |

## 7. Plugin SDK (`@pavisie/plugins`, folder `packages/plugins/src/sdk/`)

### 7.1 Plugin ids and ownership

| id             | Folder             | Command groups / top-level commands                                                                                                                                                                                                                                                                                                                                             | Default                                                |
| -------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `admin`        | `src/admin`        | `/setup wizard\|status`, `/config view\|set\|reset`, `/plugin enable\|disable\|status\|list`, `/permissions audit`, `/health`                                                                                                                                                                                                                                                   | always enabled (cannot be disabled)                    |
| `moderation`   | `src/moderation`   | `/mod warn\|warnings\|clearwarns\|timeout\|untimeout\|kick\|ban\|unban\|softban\|purge\|lock\|unlock\|slowmode\|nick\|note\|case\|cases\|appeal-setup`, `/mod role add\|remove` (subcommand group), `/appeal` (member-facing appeal flow), context menus: "Warn user", "View cases"                                                                                             | enabled                                                |
| `automod`      | `src/automod`      | `/automod rule create\|list\|view\|edit\|delete\|toggle\|test`, `/automod exempt add\|remove\|list`, `/automod dryrun`, `/automod review`, `/automod status`                                                                                                                                                                                                                    | enabled, **dry-run on** by default                     |
| `enforcer`     | `src/enforcer`     | `/enforcer setup\|status\|policy create\|list\|view\|edit\|delete\|toggle\|test\|import\|flag\|search\|record\|history\|export\|appeal\|mute\|unmute`, context menu "Flag for review"                                                                                                                                                                                           | disabled                                               |
| `logging`      | `src/logging`      | `/logs set\|disable\|status\|retention\|test\|search`, `/logs redact add\|remove\|list`                                                                                                                                                                                                                                                                                         | enabled (no channels configured → does nothing)        |
| `tickets`      | `src/tickets`      | `/ticket open\|close\|add\|remove\|transcript\|assign\|reopen\|config`, `/ticket tag add\|remove`, `/ticket panel create`                                                                                                                                                                                                                                                       | disabled                                               |
| `roles`        | `src/roles`        | `/roles panel create\|edit\|delete\|list\|post\|option-add\|option-remove`, `/roles group create\|edit\|delete\|list`, `/roles persist on\|off\|status`, `/welcome set\|embed\|test\|disable`, `/goodbye set\|embed\|test\|disable`, `/verify` (member-facing), `/verification setup\|queue\|approve\|deny`, `/onboarding checklist\|config\|rules-post\|step-add\|step-remove` | disabled                                               |
| `engagement`   | `src/engagement`   | `/level rank\|leaderboard\|config\|reset\|xp give\|remove\|set\|rewards add\|remove\|list\|sync\|ignore add\|remove`, `/rep give\|check\|leaderboard\|revoke`, `/starboard set channel\|threshold\|emoji\|selfstar\|status`, `/tempvoice setup\|lock\|unlock\|limit\|rename\|claim\|kick\|permit`                                                                               | enabled (leveling on, rep on, starboard needs channel) |
| `community`    | `src/community`    | `/poll create\|end\|results`, `/giveaway start\|end\|reroll\|list\|cancel`, `/suggest`, `/suggestions setup\|status\|list`, `/announce schedule\|list\|cancel\|preview`, `/remind set\|list\|cancel`, `/event create\|list\|cancel\|rsvps`                                                                                                                                      | enabled                                                |
| `gamestats`    | `src/gamestats`    | `/dbd link\|unlink\|stats\|leaderboard\|refresh` — Steam-linked leaderboards, Dead by Daylight first (§19c)                                                                                                                   | disabled, **unavailable without `STEAM_API_KEY`**      |
| `economy`      | `src/economy`      | `/economy balance\|daily\|give\|leaderboard\|config`, `/economy admin add\|remove` — virtual currency only, **no real money**                                                                                                                                                                                                                                                   | disabled                                               |
| `utility`      | `src/utility`      | `/help`, `/utility userinfo\|serverinfo\|avatar\|banner\|roleinfo\|channelinfo\|timestamp\|timezone set\|get\|list\|calculator\|afk\|translate\|weather\|status`, `/embed builder`, context menu "User info"                                                                                                                                                                    | enabled                                                |
| `media`        | `src/media`        | `/music play\|queue\|skip\|pause\|resume\|volume\|loop\|stop\|shuffle\|nowplaying\|playlist save\|load\|list\|delete` — adapter interface only; unavailable unless `MEDIA_PROVIDER` configured with a compliant provider                                                                                                                                                        | disabled                                               |
| `integrations` | `src/integrations` | `/integration connect\|disconnect\|status\|list`, `/integration alerts add\|remove\|list`, `/integration webhook create\|list\|delete`, `/integration outbound create\|list\|delete\|test` (notifications/alerts only; the Twitch chat bot, channel points and currency run in this plugin but are managed on the creator dashboard — §19a–19b, §19e) | disabled                                               |
| `ai`           | `src/ai`           | `/ask`, `/summarize`, `/draft`, `/mod-assist`, `/ai config view\|set-key\|clear-key\|provider\|model\|channels\|budget`                                                                                                                                                                                                                                                         | disabled                                               |

`PluginId` union in `@pavisie/types` = exactly these ids. `packages/plugins/src/index.ts` exports `allPlugins: Plugin[]` in this order and `packages/plugins/src/manifests.ts` exports `allManifests: PluginManifest[]` (import each plugin's `manifest.ts` only — **manifest files must not import discord.js runtime code beyond types/enums** so the API can load them cheaply).

Every plugin folder has this shape:

```
src/<id>/
  manifest.ts        export const manifest: PluginManifest  (+ export type <Id>Config = z.infer<typeof configSchema>)
  index.ts           export const plugin: Plugin = { manifest, commands, events?, components?, jobs?, ... }; export default plugin
  commands/*.ts      one file per top-level command or group
  events/*.ts        discord.js event handlers
  components/*.ts    button/select/modal handlers
  jobs/*.ts          BullMQ processors
  service.ts         business logic (pure where possible; injected deps) — this is what unit tests target
  README.md          what it does, config keys, permissions, privacy notes
  __tests__/*.test.ts
```

### 7.2 SDK types (`src/sdk/types.ts`) — implement exactly this shape

```ts
import type { z } from 'zod';
import type {
  Client,
  ChatInputCommandInteraction,
  ContextMenuCommandInteraction,
  AutocompleteInteraction,
  ButtonInteraction,
  AnySelectMenuInteraction,
  ModalSubmitInteraction,
  ClientEvents,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandOptionsOnlyBuilder,
  ContextMenuCommandBuilder,
  PermissionResolvable,
  GatewayIntentBits,
  Locale,
} from 'discord.js';
import type { Job, Queue } from 'bullmq';
import type { PrismaClient } from '@pavisie/database';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { PluginId, StaffLevel, PlatformEventMap } from '@pavisie/types';
import type { PlatformEvents, RateLimiterLike } from '@pavisie/core';

export type PluginCategory =
  'admin' | 'moderation' | 'community' | 'utility' | 'integrations' | 'ai' | 'media';
export type PrivilegedIntent = 'MessageContent' | 'GuildMembers' | 'GuildPresences';

export interface PluginPermissionDoc {
  permission: PermissionResolvable; // e.g. PermissionFlagsBits.BanMembers
  feature: string; // "ban / softban"
  optional: boolean;
  fallback: string; // behaviour when missing
}

export interface PluginManifest {
  id: PluginId;
  name: string;
  description: string;
  category: PluginCategory;
  version: string;
  defaultEnabled: boolean;
  alwaysEnabled?: boolean; // admin only
  permissions: PluginPermissionDoc[]; // used by /permissions audit + README matrix
  intents: GatewayIntentBits[]; // non-privileged intents needed
  privilegedIntents?: PrivilegedIntent[]; // features degrade if not enabled
  requiredEnv: string[]; // ALL must be set or plugin status = 'unavailable'
  optionalEnv?: string[];
  configSchema: z.ZodTypeAny; // per-guild config; MUST have defaults for every field
  defaultConfig: unknown; // = configSchema.parse({})
  dashboard?: { path: string; label: string; icon: string }; // icon = lucide icon name
  privacyNotes?: string[]; // shown in dashboard + README
}

export type CommandBuilder =
  | SlashCommandBuilder
  | SlashCommandSubcommandsOnlyBuilder
  | SlashCommandOptionsOnlyBuilder
  | ContextMenuCommandBuilder
  | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;

export interface CommandRequirement {
  staffLevel?: StaffLevel; // minimum configured staff level (see core resolveStaffLevel)
  discordPermissions?: PermissionResolvable[]; // actor must have ALL (checked in addition to staffLevel when both given: staffLevel OR discordPermissions satisfies)
  botPermissions?: PermissionResolvable[]; // bot must have in guild/channel; else friendly error
  botOwnerOnly?: boolean;
  guildOnly?: boolean; // default true
  cooldown?: { seconds: number; scope: 'user' | 'guild' | 'channel' };
}

export interface CommandContext {
  interaction: ChatInputCommandInteraction<'cached'>;
  ctx: PluginContext;
  guildId: string;
  staffLevel: StaffLevel;
  locale: Locale;
  t: (key: string, vars?: Record<string, string | number>) => string;
  config: <T = unknown>() => Promise<T>; // this plugin's guild config (parsed with configSchema)
}
export interface ContextMenuContext extends Omit<CommandContext, 'interaction'> {
  interaction: ContextMenuCommandInteraction<'cached'>;
}
export interface AutocompleteContext extends Omit<CommandContext, 'interaction'> {
  interaction: AutocompleteInteraction<'cached'>;
}
export interface ComponentContext<
  I = ButtonInteraction<'cached'> | AnySelectMenuInteraction<'cached'> | ModalSubmitInteraction<'cached'>,
> extends Omit<CommandContext, 'interaction'> {
  interaction: I;
  args: string[];
}

export interface PluginCommand {
  data: CommandBuilder; // name must be unique across ALL plugins
  requirement?: CommandRequirement;
  execute(c: CommandContext): Promise<void>;
  executeContextMenu?(c: ContextMenuContext): Promise<void>;
  autocomplete?(c: AutocompleteContext): Promise<void>;
}

export interface PluginEventHandler<K extends keyof ClientEvents = keyof ClientEvents> {
  event: K;
  once?: boolean;
  /** Return the guildId the event belongs to (so the host can gate on plugin enablement); return null for non-guild events (then handler runs unconditionally). */
  guildIdOf?: (...args: ClientEvents[K]) => string | null | undefined;
  handler: (ctx: PluginContext, ...args: ClientEvents[K]) => Promise<void>;
}

/** Component custom ids are `<pluginId>:<action>:<arg1>:<arg2>...` (max 100 chars). Host routes by pluginId then action. */
export interface ComponentHandler {
  action: string; // e.g. 'confirm-ban'
  kind: 'button' | 'select' | 'modal';
  handler: (c: ComponentContext) => Promise<void>;
  requirement?: Pick<CommandRequirement, 'staffLevel' | 'discordPermissions' | 'botOwnerOnly'>;
  /** if true (default), only the user who created the component may use it. Encode owner user id as first arg for that check: `<plugin>:<action>:<ownerUserId>:...`. */
  ownerOnly?: boolean;
}

export interface PluginJob<T = unknown> {
  name: string; // queue name = `${pluginId}.${name}` (BullMQ forbids ":" in queue names)
  processor: (ctx: PluginContext, job: Job<T>) => Promise<void>;
  concurrency?: number;
  repeat?: { pattern: string }; // cron; scheduled at load with jobId = name (idempotent)
}

export interface PluginHealth {
  status: 'ok' | 'degraded' | 'unavailable' | 'disabled';
  details?: string;
}

export interface PluginContext {
  client: Client<true>;
  prisma: PrismaClient;
  redis: Redis;
  logger: Logger; // child logger with { plugin: id }
  events: PlatformEvents; // in-process typed bus
  rateLimiter: RateLimiterLike;
  queue: (jobName: string) => Queue; // returns/creates queue `${pluginId}.${jobName}`
  getConfig: <T>(guildId: string) => Promise<T>; // this plugin's guild config with defaults applied
  setConfig: <T>(
    guildId: string,
    patch: Partial<T>,
    actor: { id: string; source: 'bot' | 'dashboard' | 'system' },
  ) => Promise<T>;
  isEnabled: (guildId: string, pluginId?: PluginId) => Promise<boolean>;
  services: ServiceRegistry; // cross-plugin services (see §7.5)
  audit: (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>, locale?: string) => string;
  env: typeof import('@pavisie/core').env;
  botOwnerIds: string[];
  intentsEnabled: { messageContent: boolean; guildMembers: boolean; guildPresences: boolean };
}

export interface Plugin {
  manifest: PluginManifest;
  commands: PluginCommand[];
  events?: PluginEventHandler<any>[];
  components?: ComponentHandler[];
  jobs?: PluginJob<any>[];
  onLoad?(ctx: PluginContext): Promise<void>;
  onGuildEnable?(ctx: PluginContext, guildId: string): Promise<void>;
  onGuildDisable?(ctx: PluginContext, guildId: string): Promise<void>;
  health?(ctx: PluginContext): Promise<PluginHealth>;
  migrations?: { id: string; run(ctx: PluginContext): Promise<void> }[]; // recorded in PluginMigration table
}
```

Helper `definePlugin(p: Plugin): Plugin` (identity, for typing) and `defineManifest`.

### 7.3 Registry (`src/sdk/registry.ts`)

`class PluginRegistry { constructor(plugins: Plugin[]); get(id); list(); commandsJson(); requiredIntents(opts: {privileged: {...}}); availability(env): Map<PluginId, {available: boolean; reason?: string}> }`. Validates at construction: unique plugin ids, unique command names, custom-id action uniqueness per plugin, `defaultConfig` parses. Throws on violation.

### 7.4 Config store (`src/sdk/config-store.ts`)

`GuildConfigStore` — reads `PluginConfig` rows (`guildId`, `pluginId`, `config Json`) merged over `manifest.defaultConfig` via `configSchema.parse({...defaults, ...stored})`; Redis cache key `pavisie:cfg:<guildId>:<pluginId>` TTL 300s, invalidated on write. Enablement is `PluginState` (`guildId`, `pluginId`, `enabled`) with the same cache pattern (`pavisie:plugin:<guildId>:<pluginId>`); missing row → `manifest.defaultEnabled`. Both **api and bot** use this store, so config changes from the dashboard are visible to the bot after invalidation (api deletes the same Redis keys).

### 7.5 Cross-plugin services (`src/sdk/services.ts`)

`ServiceRegistry` = typed map: `register<K extends keyof ServiceMap>(k, impl)`, `get(k): ServiceMap[K] | undefined`, `require(k)`. `ServiceMap` interface (declared in sdk, extended by module augmentation in plugins):

- `moderation`: `{ createCase(input): Promise<ModerationCase>; warn(input); timeout(input); getCase(guildId, caseNumber); listCases(...) }`
- `logging`: `{ log(guildId, kind: LogKind, payload: LogPayload): Promise<void> }` — kind ∈ `member.join|member.leave|message.edit|message.delete|role.update|channel.update|guild.update|moderation.action|voice.join|voice.leave|invite.use|bot.error|webhook.failure|automod.trigger|ticket.event|verification.event`
- `automod`: `{ quarantine(guildId, userId, reason) }`
- `tickets`, `roles` (`assignRoles`, `verifyMember`), `integrations` (`sendOutbound(guildId, endpointId, payload)`), `ai` (`complete(...)`) — each plugin registers its service in `onLoad` and consumers call `ctx.services.get('x')` and no-op gracefully if absent.
- `twitchChat`: `{ status(): TwitchChatRuntimeStatus; reconcileNow(): Promise<void>; stop(): Promise<void> }` — the `integrations` plugin's Twitch chat bot runtime; registered from the same `onLoad` (§19a).

### 7.6 Platform events (`@pavisie/types` `PlatformEventMap`)

```
'guild.configChanged': { guildId; pluginId; actorId; source }
'plugin.enabled' | 'plugin.disabled': { guildId; pluginId; actorId }
'moderation.caseCreated' | 'moderation.caseUpdated': { guildId; caseId; caseNumber; type; targetId; moderatorId; reason? }
'automod.triggered': { guildId; ruleId; ruleType; userId; channelId; action; dryRun }
'ticket.opened' | 'ticket.closed': { guildId; ticketId; userId }
'member.verified': { guildId; userId; method }
'level.up': { guildId; userId; level }
'plugin.error': { pluginId; guildId?; error: string; context? }
'webhook.deliveryFailed': { guildId; endpointId; status?; error }
'moderation.appealOpened': { guildId; appealId; caseId; caseNumber; userId }
'moderation.appealDecided': { guildId; appealId; caseId; caseNumber; userId; accepted: boolean; reviewerId }
'enforcer.flagged': { guildId; recordId; recordNumber; userId; policyId?; source }
'enforcer.decided': { guildId; recordId; recordNumber; userId; decision; moderatorId; caseId? }
```

### 7.7 Command conventions

- Every command file exports `const command: PluginCommand`. Use `SlashCommandBuilder` with `.setDMPermission(false)` and `.setDefaultMemberPermissions(...)` matching the requirement (so Discord hides it from non-staff by default). Set descriptions ≤100 chars, names lowercase.
- Reply **ephemerally** for config, moderation detail, confirmations, errors. Public for community features.
- Destructive actions (kick/ban/softban/purge/bulk role/ticket delete/data delete): reply ephemeral with an embed summarising the action + `Confirm`/`Cancel` buttons (`<plugin>:confirm-<action>:<ownerUserId>:<payload>`), 60s timeout, unless the guild's `admin` config `fastActions=true` **and** the action is not `purge>100`. Payload that doesn't fit in customId → store in Redis `pavisie:pending:<uuid>` TTL 120s and pass the uuid.
- Autocomplete for case ids, config keys, rule ids, ticket ids, plugin ids, timezones.
- Use `t()` for all user-facing strings (add keys to `packages/plugins/src/<id>/locales/en.json`, merged by the SDK into the i18n table under namespace `<pluginId>.`; core i18n exposes `registerLocaleBundle(ns, locale, bundle)`).
- Errors: throw `AppError` subclasses; the host router catches, logs (no user content), and replies with `t('errors.<code>')` ephemerally. Never leak stack traces.
- Rate limits: host applies `requirement.cooldown` via `Cooldowns`; plus a global per-user 20 cmd/10s limiter.

### 7.8 Discord permission model

- Bot invite permission set `INVITE_PERMISSIONS` (core): ViewChannel, SendMessages, SendMessagesInThreads, EmbedLinks, AttachFiles, ReadMessageHistory, AddReactions, UseExternalEmojis, ManageMessages, ManageChannels, ManageRoles, ManageNicknames, ModerateMembers, KickMembers, BanMembers, ManageThreads, CreatePublicThreads, CreatePrivateThreads, ManageWebhooks, ViewAuditLog, Connect, Speak, MoveMembers, ManageEvents, MuteMembers, DeafenMembers. **Never Administrator.**
- Each plugin lists its permissions in `manifest.permissions`; `/permissions audit` diffs against `guild.members.me.permissions` and reports missing ones per feature with the fallback text.

## 8. Database (`@pavisie/database`)

- `prisma/schema.prisma` (postgres). Client singleton in `src/client.ts` (`export const prisma`, `export * from '@prisma/client'` types). `src/index.ts` also exports `writeAudit(prisma, entry)`, `withGuild(guildId)` helpers, and `retention.ts` helpers.
- Migration: `prisma/migrations/0001_init/migration.sql` + `migration_lock.toml`, generated with `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` (no DB needed). Scripts: `generate`, `migrate:dev`, `migrate:deploy`, `migrate:diff`, `seed` (`tsx prisma/seed.ts`), `studio`.
- Conventions: ids `String @id @default(cuid())` unless a Discord snowflake is natural (`Guild.id`, `UserProfile.id` = discord user id). Every tenant table has `guildId String` + `@@index([guildId])` (+ compound indexes for hot lookups). Timestamps `createdAt @default(now())`, `updatedAt @updatedAt`. Soft delete via `deletedAt DateTime?` on ModerationCase, Ticket, RolePanel, AutomodRule, Suggestion, WebhookEndpoint, IntegrationConnection. FK to `Guild` with `onDelete: Cascade` (guild data deletion = delete Guild row → cascades). Json config columns typed `Json`.
- Models (minimum): Guild, GuildConfig (1:1; staff role ids, locale, timezone, fastActions, modLogChannelId, dataCollection flags), PluginState, PluginConfig, PluginMigration, UserProfile, ModerationCase (`caseNumber Int` per guild `@@unique([guildId, caseNumber])`, type enum WARN|TIMEOUT|UNTIMEOUT|KICK|BAN|UNBAN|SOFTBAN|PURGE|LOCK|UNLOCK|SLOWMODE|NICK|ROLE_ADD|ROLE_REMOVE|QUARANTINE|NOTE, targetId, moderatorId, reason, evidenceUrls String[], durationMs, expiresAt, expiredAt, dmSent Boolean, metadata Json, source), ModerationWarning, ModerationNote, ModerationAppeal, ModerationEscalationRule (or inside config Json), AutomodRule, AutomodEvent (with reviewStatus enum PENDING|APPROVED|FALSE_POSITIVE), AuditLog, LogEvent (logging plugin searchable store; content fields nullable), Ticket, TicketParticipant, TicketTranscript, TicketPanel, RolePanel, RolePanelOption, RoleGroup, MemberRoleSnapshot (role persistence), VerificationRequest, OnboardingProgress, ScheduledJob, Reminder, ScheduledAnnouncement, Giveaway, GiveawayEntry, Poll, PollOption, PollVote, Suggestion, SuggestionVote, StarboardEntry, TempVoiceChannel, CommunityEvent, EventRsvp, LevelProfile, LevelReward, ReputationEvent, EconomyAccount, EconomyTransaction (guild wallets; `platform = TWITCH` rows are legacy, §18b), ChannelEconomy, ChannelWallet, ChannelTransaction (a streaming channel's own currency, enum `StreamPlatform` — §18b/§19e), AfkStatus, IntegrationConnection, OAuthToken (encrypted fields `accessTokenEnc`, `refreshTokenEnc`, `expiresAt`, `scopes String[]`), WebhookEndpoint (inbound + outbound, `secretEnc`), WebhookDelivery, ProcessedWebhookEvent (idempotency: `@@unique([provider, eventId])`), DataRetentionPolicy, DataRequest (export/delete jobs), AiUsage, GuildAnalyticsDaily, TwitchBotIdentity (singleton — Pavisie's own Twitch chat-bot account), TwitchChatChannel (a guild's linked Twitch channel, with `overlayTokenEnc` + `rewardsEnabled` for channel-point rewards — §19b), TwitchChatCommand, TwitchChatTimer (enum `TwitchChatLevel` EVERYONE|SUBSCRIBER|VIP|MODERATOR|BROADCASTER — see §19a), TwitchChatReward (channel-point reward → action mapping, enum `TwitchRewardActionKind` SOUND|TTS|CHAT|DISCORD — see §19b), GameAccountLink, GameStatSnapshot (enum `GameAccountProvider` STEAM only in v1, per-guild opt-in link + latest curated stat snapshot — see §19c).
- Seed (`prisma/seed.ts`): only creates a **demo guild clearly named `Pavisie Demo (seed)`** with id `000000000000000000`, sample plugin states, one sample automod rule in dry-run, sample retention policy. No fake users/messages.

## 9. Bot host (`apps/bot`)

```
src/index.ts          bootstrap: loadEnv → requireEnv(DISCORD_TOKEN, DATABASE_URL, REDIS_URL) → prisma/redis → registry → client → login → workers → health http → graceful shutdown
src/client.ts         createClient(intents) with partials [Channel, Message, Reaction, GuildMember, User]
src/host/context.ts   builds PluginContext per plugin (child logger, queue factory, config store bindings)
src/host/loader.ts    loads plugins: availability by env/intents; registers events (with guild gating + enablement check + try/catch → events.emit('plugin.error')), components, jobs (BullMQ Worker per queue), onLoad, migrations
src/host/router.ts    interactionCreate: slash → command lookup → guildOnly/availability/enabled/requirement/cooldown → execute; autocomplete; components by customId prefix; modals; unified error handling + t()
src/host/prefix/       message-command prefix layer — transforms `+commandname args` into slash-command interactions
src/host/permissions.ts   resolveStaffLevel wrapper using GuildConfig; requirement checks; bot permission checks
src/host/health.ts    tiny http server GET /health → { status, uptime, guilds, ws ping, plugins: {id: health} }
src/register.ts       `pnpm --filter @pavisie/bot register [--global|--guild <id>|--clear]` — REST PUT applicationCommands (DEV_GUILD_ID default when set)
src/workers.ts        BullMQ Worker bootstrap for all plugin jobs + shared queues `bot-actions` (dashboard→bot requests: post role panel, send test welcome, etc.)
```

Also `apps/bot/src/host/bot-actions.ts`: processes `bot-actions` queue jobs `{ type: 'roles.postPanel' | 'welcome.test' | 'tickets.postPanel' | 'moderation.exportCases' | ... , guildId, payload }` by dispatching to `ctx.services`.

### 9.1 Message-command prefix layer

The prefix command parser (folder `src/host/prefix/`) allows every slash command to also run as a message command
with a configurable prefix, default `+`. For example: `/mod ban @user spam` can also be `+mod ban @user spam`.

- **Entry point**: `src/host/prefix/index.ts` — messageCreate event handler that detects prefix (default `+`, set by `COMMAND_PREFIX` env),
  parses the message text into a command name and arguments string, then builds a "synthetic" `ChatInputCommandInteraction`
  object and passes it to the existing `routeInteraction` pipeline (the same one used for slash commands).
- **Parser contract**: Creates a fake interaction with `isChatInputCommand() = true`, `commandName`, and parsed
  argument strings (command group + subcommand + options, space-delimited). The message author becomes the interaction user;
  the channel becomes the interaction channel; the guild becomes the interaction guild.
- **Reuse of existing checks**: Because the parser feeds into `routeInteraction`, permission checks, staff-level verification,
  cooldowns, rate limits, and all requirement validations run identically for `+` commands and slash commands — there is
  no duplicated logic. The same `CommandRequirement` applies to both forms.
- **Hard dependency on Message Content intent**: The parser must read `message.content`, which Discord blanks when the
  Message Content privileged intent is not enabled in the Developer Portal **and** `ENABLE_MESSAGE_CONTENT_INTENT=true`
  in the bot's environment. Without the intent, every message appears as an empty string and prefix parsing silently
  no-ops. This is the **only** blocking requirement: the prefix feature does not degrade gracefully if the intent is missing — it simply does nothing.
- **Silent no-op for unknown commands**: When a user types `+foo bar baz` and no command named `foo` exists, the parser
  emits no error and posts no reply. This is deliberate: many Discord bots share the `+` prefix, and broadcasting an error
  for every unknown prefix in a shared-prefix server (e.g., "I don't know what `+foo` means") creates noise. Only known
  commands reply.
- **Limitations**: (1) Commands that open a modal cannot run via `+`; the user is told to use the slash form instead.
  `showModal()` responds to a real Discord interaction token, and a chat message has none — there is no message-based
  equivalent, so the adapter throws an exposed error that the router renders as a normal "use `/name` for this one"
  reply. (2) Autocomplete is slash-only — there is no text-based equivalent for the `+` form. (3) Ephemeral
  replies become public replies over the message-command form (Discord limitation: there is no ephemeral concept for message
  replies, only slash-command interactions).
- **Configuration**: `COMMAND_PREFIX` is a single value for all guilds (not per-guild). It must be 1–3 non-alphanumeric
  characters (e.g. `+`, `!`, `$`, `>>`, `--`); the validation is enforced at bot startup via `env` schema.

## 10. API (`apps/api`)

- Fastify 5 + `fastify-type-provider-zod` (`serializerCompiler`, `validatorCompiler`, `jsonSchemaTransform` for swagger). Swagger UI at `/docs`, JSON at `/docs/json` — **registered only when `NODE_ENV !== 'production'`**; disabled in production so the exact request shape of public endpoints like `/auth/discord/login` isn't handed to anyone who looks (see `docs/SECURITY.md`). Script `openapi:export` writes `docs/openapi.json` from a dev/test run.
- Plugins: helmet, cors (`origin: [env.DASHBOARD_URL]`, `credentials: true`), cookie (signed with SESSION_SECRET), rate-limit (global 300/min per IP, auth routes 20/min; Redis-backed store, shared across api instances and survives restarts — not per-process memory), sensible.
- Session: `sid` cookie (httpOnly, sameSite `lax`, secure in prod, `domain: COOKIE_DOMAIN?`), 32-byte random id, Redis hash `pavisie:session:<sid>` TTL 7d: `{ userId, username, avatar, accessTokenEnc, refreshTokenEnc, expiresAt, csrfToken }`. `request.session` decorator. Logout deletes.
- CSRF: mutating routes require header `X-CSRF-Token` equal to session csrf token (returned by `GET /auth/me`) **and** `Origin`/`Referer` (when present) must be in the allowlist. Dashboard api client sends the header. Two session types exist (the Discord `sid` session and the creator `csid` session, §19e) and each guards ONLY its own routes: `/creator/*` routes are checked against the creator session's token, everything else against the Discord session's — decided from the matched route pattern (`request.routeOptions.url`), not the raw URL, since the router percent-decodes paths. A request carrying both cookies can therefore never satisfy one surface with the other's token.
- Auth: `GET /auth/discord/login` (state in Redis 10min, PKCE not required for Discord but include `state`), scopes `identify guilds`; `GET /auth/discord/callback` (also the redirect URI of the creator dashboard's "connect a Discord server" flow, which is told apart FIRST by its own state namespace, section 19e); `POST /auth/logout`; `GET /auth/me` → `{ user, csrfToken }`. `POST /auth/test-login` only when `E2E_TEST_MODE=true && NODE_ENV!=='production'` (creates a session for a synthetic user + synthetic guild `000000000000000000` where the user is admin) — used by Playwright.
- Guild access: `GET /guilds` → guilds where user has `MANAGE_GUILD` or `ADMINISTRATOR` or is owner (from `/users/@me/guilds` with user token, cached 60s in Redis) intersected with guilds the bot is in (`Guild` table with `botPresent=true`; the bot upserts on guildCreate/guildDelete/ready). Response marks `botPresent` so the dashboard can show an "Add bot" link (invite URL) for others. `preHandler requireGuildAccess` on `/guilds/:guildId/*` re-checks from the cached guild list (403 otherwise). All writes call `writeAudit` with `source: 'dashboard'`.
- Route files (one per feature; each exports `default async function routes(app: FastifyInstance)` registered under prefix `/guilds/:guildId`):
  - `routes/auth.ts`, `routes/guilds.ts` (list, `GET /:guildId` overview — returns `GuildOverviewDto`: `guild` (with `iconUrl`/`botPresent`, a placeholder "Unknown server" row if the bot has never synced the guild), `config`, `stats` (memberCount, pluginsEnabled/pluginCount, openTickets, pendingReviews, moderationCasesLast7d), `plugins` (via `lib/plugin-summaries.ts`'s `buildPluginSummaries`, shared with `routes/plugins.ts`), `setupIncomplete`/`setupIssues`, plus deprecated top-level `pluginCount`/`pluginsEnabled` for older consumers; `GET/PATCH /:guildId/config`)
  - `routes/plugins.ts` — `GET /:guildId/plugins` (manifest summary + enabled + availability + health), `POST /:guildId/plugins/:pluginId/enable|disable`, `GET/PUT /:guildId/plugins/:pluginId/config` (validated with the plugin's zod configSchema; `PUT` also rejects any top-level body key that isn't one of that plugin's own `configSchema` keys with a 400 `validation_error` naming the offending + valid keys — via `assertKnownConfigKeys`, also enforced as a backstop inside `GuildConfigStore.setConfig` itself — so a wrongly-shaped write, e.g. `{ config: {...} }` instead of the bare config object, fails loudly instead of a silent no-op 200 with the extra key persisted into the stored raw JSON, since zod objects strip unknown keys by default)
  - `routes/audit.ts` — `GET /:guildId/audit?cursor&limit&action&actorId`, `GET /:guildId/audit/export.csv`
  - `routes/moderation.ts` — cases list/get/update reason/export.csv, warnings, notes, appeals
  - `routes/automod.ts` — rules CRUD, events (review queue) list/resolve, dry-run toggle
  - `routes/enforcer.ts` — settings get/put, policies CRUD + test, records list/get/decide/export.csv, queue (pending flags) — see §19
  - `routes/donations.ts` (NOT under `/guilds`) — `GET /donations/config` — see §18
  - `routes/logging.ts` — settings get/put, `GET /:guildId/logs?kind&q&cursor`, export.csv
  - `routes/tickets.ts` — settings, panels CRUD, queue list, ticket get/close/assign, transcript download
  - `routes/roles.ts` — panels CRUD + `POST .../post` (enqueue bot-action), welcome/goodbye config, verification queue approve/deny
  - `routes/engagement.ts`, `routes/community.ts` — leveling config/leaderboard, giveaways/polls/suggestions lists
  - `routes/integrations.ts` — list connections, `POST /:guildId/integrations/:provider/connect` (OAuth start for the genuinely-OAuth providers — Instagram, Google/Microsoft Calendar; **refused with a 400 for `twitch`**, whose alerts need no login — see §19a-i), disconnect, webhook endpoints CRUD (secret shown once), status, `GET .../providers` (per-provider `kind`: `twitch` is `apikey`, so the dashboard shows an "Add watch" button, not an OAuth "Connect"), alert watches (`POST .../alerts` normalizes a Twitch login to lowercase and refuses a user Twitch does not know — `Twitch user "x" not found.`)
  - `routes/twitch-chat.ts` — the Discord dashboard's READ-ONLY view of the Twitch channel(s) linked to a server, under `/:guildId/integrations/twitch-chat` (§19e, phase 4): `GET` → `{ channels: [{ id, broadcasterLogin, linkedByStreamer, linkedAt, enabled, status }] }` (login and status only — never a token, Twitch user id, bridge field or credential) and `DELETE /channels/:channelId`, which UNLINKS that server from the channel (the same `unlinkChannelFromGuild` the creator-side Disconnect uses; never deletes the streamer's channel). Both need the Discord session + manage access to the guild; the `DELETE` also needs the session's CSRF token and writes an `integration.twitch_chat.discord.unlink` audit entry with the Discord user as actor. Everything else that used to live here (connect, channel PATCH, commands/timers/rewards CRUD, overlay, picker) was removed — those are creator-dashboard routes now
  - `routes/ai.ts` — settings + usage
  - `routes/analytics.ts` — `GET /:guildId/analytics?range=7d|30d|90d` (from GuildAnalyticsDaily; only if `GuildConfig.dataCollectionEnabled`)
  - `routes/privacy.ts` — retention policy get/put, `POST /:guildId/data/export` (queues job → downloadable JSON), `POST /:guildId/data/delete` (requires confirmation phrase, queues deletion), `GET /:guildId/data/requests`
  - `routes/webhooks.ts` (NOT under /guilds): `POST /webhooks/github/:endpointId`, `POST /webhooks/twitch`, `POST /webhooks/generic/:endpointId` — raw body, signature verification, idempotency via `ProcessedWebhookEvent`, then enqueue to `integrations.inbound` queue. (`POST /webhooks/stripe` was removed with the Stripe connector, §18a — GitHub's route stays wired but has no provider left to act on deliveries, see §18a.)
  - `routes/creator-auth.ts` / `routes/creator-twitch.ts` (prefixes `/creator` and `/creator/twitch`) — the creator dashboard's sign-in, session and chat-bot API, see §19e: `GET /creator/auth/twitch/login`, `GET /creator/me`, `POST /creator/logout`; `GET/PATCH/DELETE /creator/twitch/channel`, `POST /creator/twitch/channel/connect`, commands and timers CRUD under `/creator/twitch/channel/{commands,timers}`; channel points (`routes/creator-twitch-rewards.ts`, prefix `/creator/twitch/rewards`): `GET/PATCH /` (status, master switch), `POST/DELETE /authorize`, `GET/POST/PATCH/DELETE /items[/:rewardId]`, `GET /overlay`, `POST /overlay/regenerate`, `PUT/DELETE /tts-key`. Discord add-on (`routes/creator-twitch-discord.ts`, prefix `/creator/twitch/discord`, phase 3): `GET /connect` (starts the Discord sign-in), `GET /` (status), `GET /candidates`, `POST /link`, `DELETE /link`, `GET /channels`, `GET/PATCH /bridge`. All behind `requireCreatorAuth`/`requireTwitchCreator`; the sign-in *callbacks* are not routes of their own (below).
  - `routes/oauth-integrations.ts` — `/integrations/:provider/callback`, first checks whether the state belongs to a creator flow (`creator-login-state` / `creator-connect-state`, Twitch only — §19e; no Discord session needed for those) and otherwise branches on the guild flow's OAuth state `kind`: absent (the original generic per-guild connect flow, unchanged), `twitch_chat` (LEGACY — the Discord dashboard's chat-channel connect was removed in creator-dashboard phase 4, so a state it issued just before that shipped is refused with a 400 pointing at `/creator`; nothing is written), `twitch_bot` (owner-only — identifies Pavisie's own Twitch account and upserts the singleton `TwitchBotIdentity`, replacing tokens/scopes/expiry on re-auth; returns a small standalone HTML confirmation page instead of a dashboard redirect)
  - `routes/developer-reports.ts` (NOT under `/guilds`, prefix `/owner`, gated on `requireBotOwner`) — ops-console backend for the guild → developer support channel written by the `admin` plugin's `/pavisie report`; intentionally cross-guild data, which is exactly why it is bot-owner-only rather than `requireGuildAccess`: `GET /owner/developer-reports` (cursor-paginated, newest-first, filters `?status=OPEN|HANDLED&kind=BUG|FEEDBACK|QUESTION&guildId=`), `GET /owner/developer-reports/:id`, `PATCH /owner/developer-reports/:id` (`status` and/or `notes`, at least one required — `notes` is internal-only triage text never shown to the reporting guild; flipping to `HANDLED` stamps `handledAt`/`handledBy` from the session, back to `OPEN` clears both)
  - `routes/owner-metrics.ts` (NOT under `/guilds`, prefix `/owner`, gated on `requireBotOwner` like `routes/developer-reports.ts`) — read-only metrics for the local "Pavisie Dev" desktop app: `GET /owner/metrics/overview` (guild presence/growth, member totals + largest guild, developer-report counts, 7d activity), `GET /owner/metrics/guilds` (cursor-paginated, newest-joined first, `?query=&botPresent=`, per-guild plugin/case/ticket/last-activity aggregates), `GET /owner/metrics/errors` (cursor-paginated feed merged from the four models with an error column — `IntegrationConnection.lastError`, `ScheduledJob.lastError`, `WebhookDelivery.error`, `DataRequest.error`, `?source=&guildId=`), `GET /owner/metrics/growth?days=` (daily join/leave counts + running net, zero-filled, clamped 1–365)
  - `routes/twitch-bot.ts` (NOT under `/guilds`, prefix `/owner`, gated on `requireBotOwner`) — Pavisie's own Twitch chat-bot account identity, the singleton `TwitchBotIdentity` row (§19a): `GET /owner/twitch-bot` → the DTO or `{ configured: false }`, `POST /owner/twitch-bot/connect` → OAuth authorize URL (scopes `user:read:chat user:write:chat user:bot`), `DELETE /owner/twitch-bot`. Never returns the encrypted access/refresh tokens.
- Errors: `setErrorHandler` → `toPublicError` → `{ error: { code, message, details? } }`, zod errors → 400 with issues. Fastify `FST_ERR_*` client errors keep their own 4xx status with a fixed public message table (`empty_body`, `invalid_json`, `unsupported_media_type`, `payload_too_large`); `@fastify/rate-limit`'s 429 → `rate_limited`.
- Tests: `vitest` with `app.inject()` for auth guard, csrf, guild access (mock Redis via `ioredis-mock`), signature verification.

## 11. Per-guild config dashboard (lives in `apps/web`, not `apps/dashboard`)

**Merged into the main site (`pavisie.com`).** The per-guild config dashboard described below
is served by `apps/web` at `/dashboard/**` — there is no separate dashboard domain or app anymore.
`apps/dashboard` (`app.pavisie.com`) is a different, much smaller thing now — see §11a.

- Next.js 15 App Router, `apps/web/src/app/dashboard/**`. Reuses `apps/web`'s root layout/providers
  (Tailwind + `@pavisie/ui` + `next-themes` dark mode (class) + React Query + session, all mounted
  once for the whole app — see §17) rather than a per-route provider tree. Responsive sidebar
  layout (`components/dashboard/app-sidebar.tsx`) + below-`lg` tab strip
  (`components/dashboard/dashboard-tab-strip.tsx`).
- Routes (all under `apps/web/src/app/dashboard/`):
  ```
  /dashboard                         guild selector (cards; "Add to server" for guilds without bot)
  /dashboard/[guildId]               overview: stats, plugin health, quick links
  /dashboard/[guildId]/plugins       marketplace grid: enable/disable switch, availability badges, config drawer (auto-form from JSON schema of configSchema → API returns `configJsonSchema`)
  /dashboard/[guildId]/moderation    case viewer (table, filters, detail drawer, export)
  /dashboard/[guildId]/automod       rule builder (list + editor form per rule type, dry-run banner, review queue tab)
  /dashboard/[guildId]/enforcer      policies editor, flag queue with decisions, ledger table with search/filter/export, settings
  /dashboard/[guildId]/logging       log channel settings, retention, search, export
  /dashboard/[guildId]/tickets       settings, panels, queue
  /dashboard/[guildId]/roles         role panel builder (+ post), welcome/goodbye embed builder with live preview, verification queue
  /dashboard/[guildId]/engagement    leveling settings + leaderboard
  /dashboard/[guildId]/community     giveaways/polls/suggestions overview
  /dashboard/[guildId]/integrations  connection cards + connect/disconnect + webhook endpoints
  /dashboard/[guildId]/ai            settings + usage
  /dashboard/[guildId]/analytics     charts (only when data collection enabled; otherwise explain + toggle link)
  /dashboard/[guildId]/audit         audit log table + export
  /dashboard/[guildId]/privacy       retention, export/delete controls
  /dashboard/[guildId]/settings      staff roles, locale, timezone, fast actions, data collection toggle
  ```
  The dashboard's own former `/` landing page ("Login with Discord") is gone — `apps/web`'s actual
  marketing homepage (§17) has always lived at `/`, and its existing "Open dashboard" CTA now just
  links to `/dashboard` directly (same origin, no more `NEXT_PUBLIC_DASHBOARD_URL`/cross-domain
  link).
- Data layer: `apps/web/src/lib/dashboard/api.ts` — `apiFetch(path, init)` with `credentials: 'include'`, adds `X-CSRF-Token` from `/auth/me` (cached in a React context `SessionProvider`, `apps/web/src/lib/dashboard/session.tsx`), throws `ApiClientError`. React Query hooks in `apps/web/src/lib/dashboard/queries.ts` (+ one `*-queries.ts` per plugin area). Discord embed preview component `EmbedPreview` in `@pavisie/ui`.
- Auth gate: `apps/web/src/app/dashboard/layout.tsx` is a client component that calls `/auth/me`; unauthenticated → redirect `/`. A fast-path `apps/web/src/middleware.ts` checks the `sid` cookie exists and, when absent, redirects `/dashboard/*` straight to `/` before any client JS runs — same conservative "only when `COOKIE_DOMAIN` is a shared parent" caveat as before; it does not (and must not) touch `/` itself, since `/` is the marketing homepage here, not a login gate.
- Navigation: **one** top bar for the whole app (`apps/web/src/components/TopBar.tsx`, mounted once
  in the root layout) — not a dashboard-specific header. It shows the guild switcher
  (`components/dashboard/guild-switcher.tsx`) only on `/dashboard/[guildId]/**` routes, and the
  theme toggle/account menu only inside `/dashboard/**` generally. Its one hamburger menu is
  grouped: "This server" (the 16 sections above, only inside a guild) and "Pavisie" (Commands/
  Enforcer/Support/Donate, always) — this is what makes the site's marketing pages reachable from
  inside the dashboard, and vice versa, at every breakpoint. `AppSidebar`'s own mobile slide-in
  Sheet is effectively superseded by `DashboardTabStrip` (already covers below-`lg` navigation) and
  is left wired but unused rather than ripped out of a shared component.
- Playwright: `apps/web/e2e/dashboard-login.spec.ts` (unauthenticated redirect; test-login → guild selector visible), `apps/web/e2e/dashboard-config.spec.ts` (toggle a plugin, change a setting, see audit entry) — both run against `apps/web`'s own dev server now (`apps/web/playwright.config.ts`), expecting the API running with `E2E_TEST_MODE=true`, same as before.
- Support link: `apps/web/src/lib/site.ts#supportServerUrl()` reads `NEXT_PUBLIC_SUPPORT_SERVER_URL`
  (one copy now, not mirrored across two apps). Surfaced as a "Get help on Discord" row in
  `AppSidebar`'s `Sidebar` `footer` slot, and as an extra action in `ErrorState`'s "something went
  wrong" display — both render nothing when the env var is unset.

## 11a. `apps/dashboard` (`app.pavisie.com`) — legacy-link redirector today, ops console next

Not deleted — repurposed. Since the dashboard UI above moved into `apps/web`, this service's job
today is purely to keep old `app.pavisie.com/dashboard/...` links alive (bookmarks, the Top.gg
listing, a live Reddit post): its `next.config.ts` `redirects()` 308s `/`, `/dashboard`, and
`/dashboard/:path*` to the equivalent `WEB_URL` path, read server-side (not a `NEXT_PUBLIC_*`
build-time var). The redirect is deliberately **path-scoped, not a blanket catch-all** — Brandon is
building an owner-only ops console (cross-server support tickets, fleet metrics, error monitoring,
bot health) to live on this same service next, most likely on a separate `dev.pavisie.com`
domain, and a wildcard redirect would fight any `/ops/...` routes added later.

The app is kept **fully real and deployable**, not stripped to a config file: its root
`layout.tsx`/`Providers` (theme + React Query + session), `@pavisie/ui` wiring, and vitest/
Playwright test setup are all intact and covered by `apps/dashboard/test/*.test.ts`. Its current
`src/app/page.tsx` is an honest placeholder (not fake ops content) that exercises that session/
theme/UI wiring so it stays a verified baseline rather than dead scaffolding. `src/middleware.ts`
(the old cookie-based auth fast-redirect) was removed — superseded by the `next.config.ts`
redirects, since this service no longer has any dashboard auth flow of its own to fast-path.

## 12. `@pavisie/ui`

Components (all accessible, keyboard-friendly, dark-mode aware, `cn()` helper): Button, IconButton, Card, Badge, Input, Textarea, Select, Switch, Checkbox, Label, Tabs, Dialog, Sheet/Drawer, DropdownMenu, Tooltip, Table, Pagination, EmptyState, Skeleton, Alert, Toast (sonner-free simple), FormField, ColorPicker (native input), ChannelPicker/RolePicker (props: options), EmbedPreview (Discord-style), CodeBlock, StatCard, PageHeader, Sidebar/Nav, ThemeToggle. `packages/ui/src/index.ts` re-exports; `tailwind.preset.ts` (colors: brand indigo `#6366f1`, semantic tokens) consumed by both `apps/dashboard` and `apps/web`'s `tailwind.config.ts` (`presets: [preset]`, `content` includes `../../packages/ui/src/**/*.{ts,tsx}`) — `apps/web` layers its own monochrome `ink`/`grey`/`paper` tokens (§17) on top for marketing pages via the same config's `theme.extend`.

## 13. Testing conventions

- Vitest per package (`vitest.config.ts`, `test/**/*.test.ts` or `src/**/__tests__/*.test.ts`). Pure logic is separated from discord.js so tests need no gateway. Mock Redis with `ioredis-mock` where needed. Required suites: core (encryption, signatures, staff level, hierarchy, rate limiter, safe-regex, ssrf, sanitize, time), plugins (automod rule evaluators, moderation escalation + hierarchy integration, registry validation, config store merge), api (auth guard, csrf, guild access, webhook signature routes), database (schema smoke: prisma validate in CI).
- CI (`.github/workflows/ci.yml`): node 22 + pnpm 9 (`pnpm/action-setup`), `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; services postgres:16 + redis:7; step `prisma migrate deploy` + `prisma validate` against the service DB; Playwright job optional (`if: github.event_name == 'push'`) with browsers cached.

## 14. Docker

- `infra/docker/Dockerfile.{bot,api}`: `node:22-alpine`, `corepack enable && corepack prepare pnpm@9.15.9 --activate`, copy workspace manifests, `pnpm install --frozen-lockfile`, copy source, `pnpm db:generate`, `CMD ["pnpm","--filter","@pavisie/bot","start"]` (start = `tsx src/index.ts`). Non-root user. Healthcheck hits `BOT_HEALTH_PORT` / `API_PORT/health`.
- `Dockerfile.dashboard`: multi-stage `next build` with `output: 'standalone'`, `CMD ["node","apps/dashboard/server.js"]`.
- `docker-compose.yml`: `postgres` (16-alpine, volume, healthcheck), `redis` (7-alpine), `migrate` (api image, `pnpm db:migrate`, depends_on healthy postgres), `bot`, `api`, `dashboard` — all `env_file: .env`, DATABASE_URL/REDIS_URL overridden to service hostnames.

## 15. Security defaults (recap, enforced in code)

- No content logging by default (`GuildConfig.logMessageContent=false`, `dataCollectionEnabled=false`).
- All secrets encrypted with `encryptSecret` before DB; decrypted only in-process where used.
- Webhook receivers: raw body, constant-time signature check, idempotency, 5MB limit, no SSRF (outbound URLs pass `assertPublicHttpUrl`).
- Dashboard: session + csrf + origin check + guild permission check on every route; helmet; cors allowlist.
- Bot: staff level + hierarchy + bot permission checks; confirmations for destructive actions; cooldowns; global limiter.
- Regex rules validated with `validateUserRegex`; matches run on truncated content.
- HTML transcripts escaped (`escapeHtml`) and rendered with a strict CSP `<meta>`.
- Errors never leak stack/secrets to users.

## 16. Documentation set (`docs/`, `README.md`)

README (top-level): overview, features, prerequisites, Discord Developer Portal setup, OAuth redirect config, invite URL (scopes `bot applications.commands`, least-privilege permission integer), privileged intents guidance, local setup (with & without Docker), production deployment, plugin configuration guide (link PLUGINS.md), permissions matrix (link PERMISSIONS.md), privacy policy template (link), troubleshooting, roadmap (link). Every plugin's README.md is linked from PLUGINS.md.

## 17. `apps/web` (@pavisie/web)

- Next.js 15 App Router (same versions as dashboard), Tailwind 3, `next dev -p 3003`. Also serves the
  per-guild config dashboard now (§11) at `/dashboard/**`, merged in from the formerly-separate
  `apps/dashboard` app. Depends on `@pavisie/types` (still not `core`) and, since that merge, also
  `@pavisie/ui`/`@tanstack/react-query`/`next-themes` (the dashboard half's dependencies) — but
  marketing pages still use only the website's own black/grey/white-plus-gold component set under
  `src/components/`, not `@pavisie/ui`; the two component systems coexist (§11's Tailwind preset
  note) without either being forced on the other's pages.
- Palette tokens (CSS variables in `src/app/globals.css`): `--ink-0:#050505 --ink-1:#0a0a0a --ink-2:#111111
--ink-3:#171717 --ink-4:#1f1f1f --ink-5:#262626 --ink-6:#333333 --ink-7:#404040 --grey-1:#525252 --grey-2:#737373
--grey-3:#8a8a8a --grey-4:#a3a3a3 --grey-5:#bdbdbd --grey-6:#d4d4d4 --grey-7:#e5e5e5 --paper:#fafafa`, plus the
  gold accent ramp `--gold-1:#2a1806 --gold-2:#42270c --gold-3:#603b12 --gold-4:#8f5e20 --gold-5:#c7933d
--gold-6:#eec66a --gold-7:#f9db7e` (§20 has the contrast figures and role assignments). Fonts: system stack
  (`ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, sans-serif`) — no network font loading (offline
  builds must work).
- Smoke: `src/components/Smoke.tsx` renders 4–6 absolutely-positioned blurred radial-gradient blobs (`filter: blur(80px)`,
  `mix-blend-mode: screen`, opacity 0.08–0.18) animated with slow translate/scale keyframes (60–120s), disabled under
  `prefers-reduced-motion`; `Grain.tsx` overlays an SVG `feTurbulence` noise data-URI at ~4% opacity; `Glass` card =
  `bg-white/[0.03] backdrop-blur-xl border border-white/10 rounded-2xl`.
- Data: `src/data/commands.json` is generated by `pnpm --filter @pavisie/plugins export:commands`
  (`packages/plugins/scripts/export-commands.ts` walks `allPlugins`, calls `data.toJSON()` and emits
  `{ generatedAt, plugins: [{ id, name, description, category, defaultEnabled, privilegedIntents, commands: [{ name,
fullName ("/mod warn"), type: 'slash'|'user'|'message', description, staffLevel?, discordPermissions?: string[],
options: [{name, description, required, type}], subcommands: [{ name, fullName, description, options }] }] }] }`),
  written to `apps/web/src/data/commands.json` AND `docs/commands.json`. Root script `commands:export`. CI runs it and
  fails on `git diff --exit-code` (docs must be regenerated when commands change). Curated copy lives in
  `src/content/plugins.ts` (`Record<PluginId, { headline, whyGaming: string[], highlights: string[] }>`) and
  `src/content/site.ts`.
- Pages: `/`, `/features` (all plugins; anchors per plugin; `/features/[pluginId]` detail with full command table),
  `/enforcer`, `/donate`, `/support`, `/privacy`, `/terms`, `not-found`, and `/creator` (the streamer-facing creator
  dashboard, §19e — app-style chrome like `/dashboard`, and also its own public landing page when signed out).
- Donate page: reads `GET {API}/donations/config` at request time (never cached; `dynamic = 'force-dynamic'`).
  When `enabled` is true, renders an external link to the Ko-fi page (`kofiUrl`); when false, shows an
  honest "donations aren't set up on this deployment" notice.
- Support page (`/support`): the primary support destination — leads with joining the Discord server
  (`supportServerUrl()`; renders a "not linked yet" notice instead of a CTA when unset, same degrade-to-nothing
  contract as the footer), then points to the dashboard (config) and `/features` (command reference). No invented
  SLA or community-size claims. Also linked from the single site-wide top bar (`TopBar.tsx`, §11) alongside the
  existing footer link.
- Env (public): `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DISCORD_CLIENT_ID`,
  `NEXT_PUBLIC_INVITE_PERMISSIONS` (integer string; default = core `INVITE_PERMISSIONS_BITFIELD`, also exported by the
  commands export as `docs/invite.json`), `NEXT_PUBLIC_SUPPORT_SERVER_URL` (optional; one copy now — the dashboard
  UI that used to mirror this in its own `apps/dashboard/src/lib/site.ts` lives here too, see §11). Server env:
  `WEB_URL`. (`NEXT_PUBLIC_DASHBOARD_URL` is gone: the "Open dashboard" CTA and the `/support` page's dashboard
  link are now plain same-origin `/dashboard` links, not a cross-domain env-driven URL.)
- Docker: `infra/docker/Dockerfile.web` (same shape as dashboard, standalone), compose service `web` on 3003.

## 18. Donations — Ko-fi link-out

Donations moved from Stripe Checkout to a Ko-fi link-out on 2026-08-30 after a public card-testing incident
forced a Stripe account ban on 2026-08-26. Rather than defend the checkout endpoint against further abuse, the
decision was to remove it entirely — Pavisie no longer processes payments at all. Ko-fi (a third-party donation
platform) hosts the payment page and owns all fraud/abuse handling. This removes the entire card-testing attack
surface instead of just hardening one endpoint.

- Env: `KOFI_URL` (optional — full Ko-fi page URL, e.g. `https://ko-fi.com/example`). When unset, the donate page
  honestly says donations aren't set up on this deployment, the same degradation pattern as other optional features.
  No Stripe vars are needed for donations anymore (§18a notes the guild-facing Stripe **integration connector**,
  which is unchanged).
- `apps/api/src/routes/donations.ts` (public, no session):
  - `GET /donations/config` → `{ enabled: boolean, kofiUrl: string | null }`. `enabled` is `true` only when
    `KOFI_URL` is set and points to a valid URL. `kofiUrl` is the configured URL, or `null` if donations are
    not configured.
  - No POST route for checkout; no CAPTCHA, no Stripe calls, no payment processing.
- `apps/api/src/lib/donations.ts` exports nothing (the Stripe event handler is gone; see §18a for why the
  guild-facing integration connector is unchanged).
- **Donation database table left in place for now, unused.** Prisma model `Donation` exists but no code writes to
  it anymore. The table is not dropped so operator data is not destroyed, and future use (e.g. logging who donated
  at what time without storing personal data) remains possible without a migration.
- Pavisie handles **no card data, no payment secrets, and no donation webhooks**. Ko-fi handles everything.
- The `/docs` Swagger UI no longer shows any donation endpoints (no endpoints exist).

### 18a. Stripe integration connector (removed 2026-09-02)

The guild-facing **Stripe integration connector** — a feature other Discord servers used to receive their own
Stripe payment alerts in Discord — was never related to donations (it was unaffected by the donation→Ko-fi
change above). Brandon removed it, along with the GitHub and Notion connectors, on 2026-09-02: their provider
definitions, dashboard cards, and the `/webhooks/stripe` inbound route are gone; `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` are no longer read anywhere. GitHub's own inbound route (`/webhooks/github/:endpointId`)
is untouched and still verifies/accepts deliveries — there's just no provider left to act on them, so it safely
degrades to a no-op (ARCHITECTURE.md's "safely degrade if an optional integration is not configured").
`GITHUB`/`NOTION`/`STRIPE` remain in the Prisma `IntegrationProvider` enum, unused, purely so historical
`IntegrationConnection` rows keep reading correctly (schema.prisma) — do not drop them, and do not re-add a
provider file/registry entry for one without deciding whether its enum value should come back into use.

## 18b. `economy` plugin (guild wallets) and the channel-owned Twitch currency

Virtual currency feature: `/economy balance|daily|give|leaderboard|config` and `/economy admin add|remove`.
**No real-money functionality** — currency is virtual-only, cannot be purchased, cashed out, or used for wagering.

There are now **two separate currencies**, and they are never merged, linked or transferred between:

1. **The Discord server's currency** (this plugin) — wallets keyed by `(guildId, platform = DISCORD, userId)` in
   `EconomyAccount`/`EconomyTransaction`, configured with `/economy config` and the Discord dashboard.
2. **A Twitch channel's currency** (`ChannelEconomy`, below) — **owned by the Twitch channel**, configured by the
   streamer on the creator dashboard (§19e), working with **no Discord server at all**. It was moved off the guild
   in creator-dashboard phase 2a (migration `0015_channel_economy`): the guild economy no longer has any Twitch
   settings.

**Guild wallets (`EconomyAccount`/`EconomyTransaction`)**: platform is part of the unique key (`DISCORD` or the legacy
`TWITCH`) so a Discord snowflake and a Twitch id with the same digits could never collide. Historical rows: every row
existing before migration 0013 is `DISCORD`. **`platform = TWITCH` rows in these tables are LEGACY**: they were carried
over into the channel economy by migration 0015 (see below) and are now unused — deliberately left in place, unmodified,
so the migration is trivially reversible; they are dropped in creator-dashboard phase 4. Nothing reads them any more
(the Discord leaderboards filter `platform = DISCORD` explicitly).

**Ledger discipline**: Every balance change is an append-only transaction row. The balance on the wallet row is a
derived/cached total, never edited without a matching transaction. The guild ledger
(`packages/plugins/src/economy/ledger.ts`) is the only module allowed to write a guild-wallet balance:
`getOrCreateWallet` (upsert by compound key), `claimDaily` (per-wallet cooldown & streak), `give` (same-platform
only), `credit`, `adminAdjust` (add/remove; prevents negative), `getPlatformLeaderboard` (top wallets by lifetime
earned). All mutators use `prisma.$transaction` with conditional `updateMany` guards for concurrency safety (exactly
one concurrent claim/give wins, others fail atomically with no ledger row). Earned transaction types:
`['daily', 'twitch_chat_earn', 'twitch_watch_earn']` (`twitch_watch_earn` reserved for a future watch-time feature).

**Discord leaderboards**: `/economy leaderboard [platform]` with choices `global` (default), `discord`, `twitch`.
- `discord`: top 10 Discord wallets by **lifetime earned**.
- `twitch`: the Twitch viewers of the channels **linked to this server** (`TwitchChatChannel.guildId`), read from those
  channels' `ChannelWallet`s by lifetime earned, each row in its own channel's currency symbol. Only channels whose
  streamer has switched their currency **on** are shown. No linked channel (or none with a currency on) is an honest
  empty state ("No Twitch channel linked to this server has a currency switched on yet…"), never an empty-looking board.
- `global`: the top 10 by **current balance** across this server's Discord wallets and the linked channels' Twitch
  wallets (the two are ranked side by side, each in its own currency; they are not converted or merged). Twitch rows:
  escaped `displayName` (fallback "Twitch viewer") + ` (Twitch)` marker.

`/economy config` now only has the currency name/symbol, daily min/max and give min/max. The old `twitch-*` options
(and the `twitchEnabled`/`twitchEarn*` keys of the guild config schema) were removed **backward-compatibly**: the
schema is non-strict, so stale copies of those keys still in a guild's stored config are silently dropped on read and
never break config parsing; a NEW write of one through the dashboard is rejected as an unknown field. The former
cross-plugin `economy` service (`ServiceMap.economy`) had the Twitch chat runtime as its only consumer and was removed
with them.

### Channel-owned Twitch currency (`ChannelEconomy`)

- **Models** (migration 0015, `packages/database/prisma/schema.prisma`): `ChannelEconomy` — one per streaming channel,
  unique `(platform: StreamPlatform, channelUserId)`, holding the channel's currency settings: `enabled` (default
  false), `currencyName`/`currencySymbol` (Agis / ♦️), `dailyMinAmount`/`dailyMaxAmount` (50/150),
  `streakBonusPerDay`/`streakBonusMax` (10/200), `giveMinAmount`/`giveMaxAmount` (1/100000), `earnEnabled` (false),
  `earnPerMessage` (5), `earnCooldownSeconds` (60), `earnDailyCap` (200) — the same defaults and bounds as the guild
  economy. `ChannelWallet` `(economyId, viewerUserId)` unique — the viewer's Twitch id, display name, balance,
  `lastDailyAt`. `ChannelTransaction` — the append-only ledger (`walletId`, from/to viewer ids, amount, `type`, `note`),
  same `type` vocabulary as the guild ledger (`daily`, `give`, `twitch_chat_earn`, `admin_add`, `admin_remove`).
  **`StreamPlatform`** is a new enum (today `TWITCH` only) rather than a reuse of `EconomyPlatform`: that enum carries
  `DISCORD`, which is meaningless for a channel currency, and adding `KICK` to it would pollute guild wallets; a second
  platform (Kick, phase 5) adds one value here and reuses everything else.
- **Keyed by broadcaster id, not by a foreign key** to `TwitchChatChannel` (or to a guild): disconnecting or deleting
  the chat bot, unlinking a Discord server or a guild being deleted never deletes anyone's balance.
- **Created by the streamer's first save**, never by viewing: `GET /creator/twitch/economy` on a channel with no row
  returns the defaults with `configured: false` and writes nothing; the first `PATCH` upserts the row.
- **Ledger** (`packages/plugins/src/channel-economy/ledger.ts` — the only module allowed to write a `ChannelWallet`
  balance), mirroring `economy/ledger.ts` exactly: atomic `$transaction`s with conditional `updateMany` guards,
  append-only transactions, no negative balances, daily cooldown (20h) and streak (48h window) from the very same pure
  `rollDaily`, `give` inside ONE channel's currency (self / bot / min / max / insufficient checks), `credit` for
  earning, `adminAdjustChannel` for the streamer, and the lifetime-earned (`EARNED_TRANSACTION_TYPES`, shared with the
  guild ledger) and balance leaderboards. Three deliberate tightenings, none changing an outcome a caller relied on:
  amounts must be safe positive integers everywhere (`invalid_amount`, instead of a thrown `RangeError`); `give` creates
  the RECIPIENT's wallet only after every validation has passed (a rejected `!give` never stores a bystander's display
  name); `claimDaily`'s retry-after is measured against the injected `now`. Parity with the guild ledger is asserted by
  tests that run the same operation sequences against both. Settings live in
  `channel-economy/settings.ts` (Zod schema with the guild economy's bounds, `CHANNEL_ECONOMY_DEFAULTS`, cross-field
  min<=max check).
- **Carry-over (migration 0015, hand-written data copy, clearly marked in the SQL)**: for every `TwitchChatChannel`
  with a `guildId`, create its `ChannelEconomy` from that guild's stored economy plugin config (`PluginConfig.config`
  jsonb: currency name/symbol, daily, streak, give, `twitchEarn*`), falling back to the defaults for an absent or
  wrong-typed key and clamping numbers to the schema bounds; `enabled` = the guild's `twitchEnabled` AND the economy
  plugin being enabled (`PluginState`). Then copy every `EconomyAccount(platform = TWITCH)` of that guild into
  `ChannelWallet` (balance, `lastDailyAt`, display name and timestamps verbatim) and every
  `EconomyTransaction(platform = TWITCH)` into `ChannelTransaction` (amount, type, note, from/to, `createdAt` verbatim;
  `accountId` remapped to the copied wallet). Guildless channels never had wallets, so they get no row until their
  streamer saves. Ids are deterministic (`ce_<channelRowId>`, `cw_<channelRowId>_<accountId>`,
  `ct_<channelRowId>_<txId>`), so no extension is needed and every copied row is traceable. If one guild ever linked
  several broadcasters, its pooled Twitch wallets are copied into each channel's economy (nobody loses currency).
  Twitch wallets of a guild that no longer has ANY linked channel cannot be attributed and stay in the legacy tables.
  **The old rows and the guild config's stale keys are NOT modified or deleted** (rollback = redeploy the previous
  build); the drop was planned for phase 4 but is **deferred**: the owner confirms the migrated balances first, and a later
  migration removes them (the `TWITCH` value of `EconomyPlatform` stays until then).
- **Twitch chat runtime** (inside the `integrations` plugin's `twitch-chat/` — §19a): economy commands and earning run
  for ANY enabled `TwitchChatChannel`, guild-linked or guildless, against the channel's `ChannelEconomy` **when its
  `enabled` is true** (earning additionally needs `earnEnabled` and a live stream). The bot no longer reads the guild
  economy config or its enablement for Twitch. The row is read through a small in-memory cache
  (`ECONOMY_CACHE_TTL_MS`, 30s, negative results cached too), so a streamer's change on the creator dashboard reaches
  chat within about 30 seconds and a busy chat does not cost a database read per message.
- **Commands** (`integrations/twitch-chat/economy-commands.ts`, `handleEconomyChatCommand` — pure/testable, no
  `PluginContext`, talks to the currency only through an `EconomyChatPort` built over the channel ledger by
  `economy-port.ts`): `!balance`/`!bal` (the viewer's balance), `!daily` (claims), `!give <login> <amount>` (optional
  leading `@`; resolves the login to a Twitch user id via Helix `GET /users?login=` — `getUserByLogin` in `helix.ts` —
  then transfers inside the channel's currency; rejects self, the bot's own Twitch account, an unresolved login and an
  invalid/out-of-range amount), `!top` (top 5 by lifetime earned, one line). **Precedence**: `TwitchChatManager` tries
  these BEFORE `engine.handleChatMessage` for any message starting with the channel's prefix; a reserved name
  (`balance`/`bal`/`daily`/`give`/`top`, in `TWITCH_CHAT_RESERVED_COMMAND_NAMES` alongside the `commands`/`uptime`/
  `title` built-ins) is only handled here when the channel has an enabled currency AND no enabled custom command
  already owns that name — an existing custom command with a reserved name always wins. The currency row is loaded
  lazily, only once a message is known to be an economy command nothing else owns. A message this module doesn't handle
  falls through to the engine completely unchanged — never a marker string. A per-viewer, per-command 10s cooldown
  (`econ:<viewerId>:<name>`) reuses the engine's own `CommandCooldowns` class under a distinct key namespace.
  **`!give`'s login argument is validated against Twitch's own login alphabet (`^[a-z0-9_]{1,25}$`, after stripping one
  leading `@` and lowercasing) BEFORE any Helix call or any reply** — an invalid login gets a fixed rejection that never
  echoes the input, and an unresolved-but-valid-looking login also gets a fixed "couldn't find that Twitch user" reply
  with no echo either. This closes an echo-abuse hole: without it, `!give <slur or link> 5` would have made the bot
  repeat arbitrary viewer-typed text in its own voice in the streamer's chat. Every other economy reply only ever
  includes Twitch-verified display names (from the EventSub event or a Helix user lookup, never raw message text) or
  our own formatted numbers — never a raw viewer-typed argument.
- **Earning** (`integrations/twitch-chat/economy-earn.ts` + `TwitchChatManager.tryEconomyEarn`): for each non-command
  chat message (doesn't start with the channel's prefix) not from the bot, **not from the channel's broadcaster** (no
  self-farming), and **not from a well-known third-party chat bot** (`EXCLUDED_CHAT_BOT_LOGINS` — `nightbot`,
  `streamelements`, `streamlabs`, `moobot`, `fossabot`, `wizebot`, `soundalerts`, `sery_bot`, `botrixoficial`,
  `kofistreambot`, `own3d`, `pokemoncommunitygame`, `commanderroot`; matched case-insensitively against the EventSub
  event's `chatter_user_login`, never the display name; earning-only, every one of them can still run economy
  commands), while the currency is `enabled` and `earnEnabled` (and `earnDailyCap` > 0): only while the channel is
  **live** — one `getStream` lookup per broadcaster, cached in-memory for 60s (`isChannelLive`/`LIVENESS_CACHE_TTL_MS`;
  a failed lookup is cached and treated as not-live) — then a per-viewer-per-**channel** cooldown (`SET ... EX
  <earnCooldownSeconds> NX`) and a UTC-day earn budget (`reserveDailyEarnBudget`) that credits `earnPerMessage`, or a
  smaller "partial final credit" once the day's remaining budget is under that, or `0` once the cap is reached. The
  Redis keys are scoped to the channel economy's id — `pavisie:channel-economy:earn-cooldown:<economyId>:<viewerId>`
  and `…:earn-daily:<economyId>:<viewerId>:<UTC date>` (the pre-0015 guild-scoped `economy:twitchearn-*` keys are no
  longer read and expire on their own; at cutover a viewer can therefore earn up to one extra daily cap that UTC day).
  **Every write to the daily-budget key sets its value and its TTL in one atomic Redis operation** — `MULTI` for the
  `INCRBY`+`PEXPIRE` pair, `SET ... PX` for the cap-clamp — so a crash can never leave the key with no TTL. A
  successful credit goes through the channel ledger's `creditChannel(..., 'twitch_chat_earn')` — silent, no chat reply,
  never logged, and every step is best-effort (never throws into the chat pipeline).
- **Extension panel** (§19d): resolves `channel_id` → the channel's enabled `ChannelEconomy` directly (no guild, no
  linked chat-bot row needed); summary reads never create a wallet.
- **Creator dashboard** (§19e): `GET/PATCH /creator/twitch/economy`, `GET …/leaderboard`, `POST …/adjust`; UI section
  "Currency".

## 19. `enforcer` plugin

- Plugin id `enforcer` (add to `PluginId` / `PLUGIN_IDS` in `@pavisie/types`, to `allPlugins` after `automod`, and to
  the §7.1 table). Folder `packages/plugins/src/enforcer`. Category `moderation`. `defaultEnabled: false`.
  `privilegedIntents: ['MessageContent']` (automatic flagging only; manual flags via context menu work without it —
  message context-menu interactions include the resolved message content regardless of intent). Note: Message Content
  intent is a bot-wide requirement, needed by the Enforcer's automatic flagging, the prefix command layer (§9.1),
  automod rule evaluation, and message logging; it must be enabled in the Discord Developer Portal **and** in
  the bot's `ENABLE_MESSAGE_CONTENT_INTENT=true` env var, or all four features silently no-op (see §15).
  Permissions: ViewChannel, SendMessages, EmbedLinks, ReadMessageHistory (context), ManageChannels (create/lock the
  ledger + queue channels), ManageRoles (mute role), ModerateMembers/KickMembers/BanMembers (executed via the moderation
  service; listed for the audit).
- Depends on the `moderation` plugin being enabled (`/enforcer setup` refuses otherwise with an explanation) and uses
  `ctx.services.require('moderation')`. Optional: `ai` service for assistive scoring; `logging` service for mirroring.
- Commands (`/enforcer` group + one message context menu + `/enforcer appeal`):
  `/enforcer setup` (wizard: ledger channel create/pick + visibility, flag-queue channel create/pick, mute role
  pick/create, capture-context toggle, checks moderation enabled + MessageContent intent + bot permissions; writes
  config; posts a "ledger opened" entry), `/enforcer status`,
  `/enforcer policy create|list|view|edit|delete|toggle|test|import` (import packs: `invites`, `mass-mentions`,
  `scam-links`, `external-links` — no slur lists shipped; "bring your own list"),
  `/enforcer flag user:<user> reason:<text> [policy]` (manual, non-message),
  message context menu **"Flag for review"** (staff ≥ helper) → optional policy select + note → flag,
  `/enforcer search user:<user> [kind] [decision] [policy] [since:<duration>]` (staff ≥ helper; paginated ephemeral),
  `/enforcer record <number>` (detail incl. context snapshot + case link), `/enforcer history user:<user>` (counts),
  `/enforcer export [since]` (admin; CSV attachment, ephemeral),
  `/enforcer appeal record:<number>` (member; modal → `moderation.openAppeal`),
  `/enforcer mute|unmute user:<user> [duration] [reason]` (mute-role shortcuts routed through decisions).
- Config schema: `{ ledgerChannelId: string|null, ledgerVisibility: 'staff'|'everyone' = 'staff', flagChannelId:
string|null, muteRoleId: string|null, captureContext: boolean = true, contextBefore: 1..15 = 5, contextAfter: 0..10 =
3, excerptMaxChars: 50..1000 = 300, autoFlagEnabled: boolean = true, exemptStaff: boolean = true, aiAssist: boolean =
false, dmOnAction: boolean = true, defaultTimeoutMinutes: 60, defaultMuteMinutes: number|null = null (null = until
unmuted), requireReasonOn: ('warn'|'timeout'|'mute'|'kick'|'ban')[] = ['kick','ban'], allowedDecisions:
('warn'|'timeout'|'mute'|'kick'|'ban'|'dismiss')[] = all, banDeleteMessageSeconds: 0..604800 = 0 }`.
- Prisma models:
  ```
  enum PolicySeverity { LOW MEDIUM HIGH CRITICAL }
  enum EnforcerRecordKind { FLAG DECISION APPEAL_OPENED APPEAL_DECIDED NOTE }
  enum EnforcerFlagStatus { PENDING ACTIONED DISMISSED EXPIRED }
  enum EnforcerSource { AUTO MANUAL AI_ASSIST DASHBOARD }
  enum EnforcerDecision { WARN TIMEOUT MUTE UNMUTE KICK BAN DISMISS }
  model EnforcerPolicy { id cuid; guildId; name; description String; enabled Boolean @default(true); severity PolicySeverity @default(MEDIUM);
    matchers Json  // [{type:'keyword'|'phrase'|'regex'|'link_domain'|'invite'|'mention_count'|'attachment_ext'|'ai_category', value: string|string[]|number, caseSensitive?: bool, wholeWord?: bool}]
    channelIds String[]; exemptRoleIds String[]; exemptChannelIds String[]; suggestedAction EnforcerDecision?; createdBy; updatedBy?; deletedAt?; createdAt; updatedAt; records EnforcerRecord[]; @@index([guildId, enabled]) }
  model EnforcerRecord { id cuid; guildId; recordNumber Int; kind EnforcerRecordKind; status EnforcerFlagStatus?; userId; channelId?; messageId?; messageJumpUrl?;
    policyId? → EnforcerPolicy (onDelete: SetNull); policyName?; matcherSummary?; riskScore Float?; aiExplanation?; excerpt?; contextSnapshot Json?; source EnforcerSource;
    flaggedBy?; decision EnforcerDecision?; decidedBy?; decidedAt?; decisionReason?; durationMs Int?; caseId? → ModerationCase (SetNull); parentRecordId?; ledgerMessageId?; flagMessageId?; createdAt;
    @@unique([guildId, recordNumber]) @@index([guildId, userId, createdAt]) @@index([guildId, kind, createdAt]) @@index([guildId, status]) @@index([guildId, policyId]) }
  ```
  Ledger record numbers are per guild (`#E-<n>`), allocated like case numbers (retry on unique violation).
- Policy engine `src/enforcer/engine.ts` (pure, unit-tested): `evaluate(message: NormalizedMessage, policies:
Policy[], opts) → Match[]` where `NormalizedMessage = { content, authorId, authorRoleIds, channelId, mentionsCount,
attachments: {name, contentType?}[], links: string[], invites: string[], isStaff }`; keyword (word-boundary
  case-insensitive by default), phrase, regex (via core `validateUserRegex` at save time and `safeTest` at run time),
  link_domain (hostname suffix match), invite, mention_count (>=), attachment_ext; respects scope + exemptions;
  returns the highest-severity match first. Excerpt = `sanitizeEmbedText(truncate(content, excerptMaxChars))` with
  mentions stripped of pings (`stripMentions` → plain text `@name`).
- Flow (per SPEC §N): auto flag on `messageCreate` (skip bots/webhooks/system, skip exempt, skip staff if exemptStaff,
  cooldown 1 flag / user / policy / 60s via Redis, and dedupe by messageId) → create FLAG record (PENDING; excerpt +
  `contextSnapshot` of the previous `contextBefore` messages `{authorId, at, excerpt}` fetched via
  `channel.messages.fetch({ before, limit })` when captureContext) → post ledger entry (kind FLAG) → post flag-queue
  embed with buttons `enforcer:decide:<recordId>:<decision>` (Warn/Timeout/Mute/Kick/Ban/Dismiss; hidden if not in
  allowedDecisions), `enforcer:context:<recordId>` (View context: live fetch `contextBefore` before + `contextAfter`
  after the flagged message; falls back to snapshot; ephemeral), `enforcer:history:<recordId>` (Suspect history:
  counts + last 5 records ephemeral). All buttons `ownerOnly: false`, requirement staffLevel `moderator` (Dismiss and
  View context: `helper`). Decision click → Redis lock `pavisie:enforcer:lock:<recordId>` (NX PX 30000) + status check
  → for timeout/mute/kick/ban (and warn when required) open a modal (`enforcer:decide-modal:<recordId>:<decision>`
  fields reason (required per config), duration for timeout/mute (parseDuration), banDeleteMessages days for ban) →
  execute via moderation service (`warn` / `timeout` / `kick` / `ban` / for MUTE add `muteRoleId` role through
  `moderation.createCase({type:'ROLE_ADD', metadata:{enforcerMute:true}})` + role add with hierarchy checks; UNMUTE
  reverse) → create DECISION record (parentRecordId = flag, caseId, decidedBy, reason, durationMs) → update FLAG
  (status ACTIONED/DISMISSED, decision fields) → edit flag-queue message (buttons disabled, footer "Decided by <mod>
  at <t>") → ledger entry (kind DECISION) → emit `enforcer.decided`. The suspect is only ever contacted by the bot
  (moderation service DM with case + record numbers + `/enforcer appeal <n>` instructions).
- Ledger channel: created by setup as `#mod-ledger` (or chosen). Overwrites: `@everyone` deny SendMessages,
  SendMessagesInThreads, CreatePublicThreads, CreatePrivateThreads, AddReactions (and deny ViewChannel when visibility
  = staff); each configured staff role: allow ViewChannel + ReadMessageHistory; bot: allow ViewChannel, SendMessages,
  EmbedLinks, ReadMessageHistory. Setup re-applies overwrites (`/enforcer setup` → "repair channel"). Ledger embed
  fields: `Record #E-n`, `User <@id> (id)`, `When <t:..:F>`, `Action`, `Decided by`, `Policy`, `Case #`, `Context`
  (excerpt + `[Jump]` link), footer with source. Ledger posts never ping (allowedMentions: parse []).
- Mute-role overwrite upkeep: the deny SendMessages/SendMessagesInThreads/Speak/AddReactions overwrite for the
  configured mute role is kept in sync by two paths sharing one implementation (`applyMuteRoleToChannel` in
  `channels.ts`) — the bulk `applyMuteRoleToChannels` (used by `/enforcer setup`'s initial role creation and by
  `EnforcerService.repairChannels`, which now also returns `{ muteApplied, muteFailed }` alongside re-applying the
  ledger/flag-queue overwrites) and a `channelCreate` listener (`events/channel-create.ts`) that applies it to a
  single newly-created channel. Both paths cover categories as well as text/voice channels — a category is
  neither text- nor voice-based but still holds its own overwrites, so leaving it out of the bulk path would mean
  a category that existed before setup/repair never got the deny while one created afterward did; applying it
  consistently in both places means a category's current children AND any future ones inherit the deny. Both
  paths no-op silently when no mute role is configured or the configured role no longer resolves
  (`guild.roles.fetch` failure); the listener also never throws (best-effort, logs at `warn`) and relies on the
  host's standard `guildIdOf`-based plugin-enablement gating like every other Enforcer event handler.
- Cross-plugin contract additions:
  - `ServiceMap.moderation` MUST also expose `openAppeal({ guildId, userId, caseNumber?, caseId?, content, source }):
Promise<{ appealId: string }>` and `getCaseByNumber(guildId, caseNumber)`; the moderation plugin emits
    `moderation.appealOpened` and `moderation.appealDecided`.
  - `ServiceMap.enforcer`: `{ decide(input: { guildId, recordId, decision, moderatorId, reason?, durationMs?,
banDeleteMessageSeconds? }): Promise<{ recordNumber }>; flag(input): Promise<{ recordId; recordNumber }>;
search(...) }` — used by the bot-action `enforcer.decide` (dashboard decisions) and by other plugins.
  - `PlatformEventMap` additions: `'moderation.appealOpened': { guildId; appealId; caseId; caseNumber; userId }`,
    `'moderation.appealDecided': { guildId; appealId; caseId; caseNumber; userId; accepted: boolean; reviewerId }`,
    `'enforcer.flagged': { guildId; recordId; recordNumber; userId; policyId?; source }`,
    `'enforcer.decided': { guildId; recordId; recordNumber; userId; decision; moderatorId; caseId? }`.
  - bot-actions: `enforcer.decide`, `enforcer.repairChannels`.
- API `apps/api/src/routes/enforcer.ts` (under `/guilds/:guildId/enforcer`): `GET/PUT settings` (via store),
  `GET/POST policies`, `GET/PUT/DELETE policies/:id`, `POST policies/:id/test` (runs the engine on sample text),
  `GET records?userId&kind&decision&policyId&status&since&cursor`, `GET records/:recordNumber`,
  `POST records/:recordNumber/decide` (enqueue bot-action `enforcer.decide`), `GET records/export.csv`, `GET queue`
  (pending flags).
- Dashboard `/dashboard/[guildId]/enforcer`: tabs Overview/Setup status · Policies (table + matcher builder editor +
  test box) · Queue (pending flags with decision buttons + reason/duration dialog) · Ledger (search/filter table, detail
  drawer with context snapshot, CSV export) · Settings.
- Website `/enforcer` page explains the workflow (from `src/content/enforcer.ts`).

## 19a-i. Twitch stream-live alerts (inside the `integrations` plugin)

What a server admin sets up to get a "going live" post in a channel. **No one signs into Twitch for this**: Helix user /
stream lookups and the EventSub webhook subscriptions all use the bot's own client-credentials **app token**
(`getTwitchAppToken`, `packages/plugins/src/integrations/providers/twitch.ts`). So the provider is `kind: 'apikey'` (set up
like YouTube/Reddit/Steam), not `'oauth'`:

- `/integration connect provider:twitch target:<login> channel:#x` and `/integration alerts add provider:twitch ...` both
  call `createAlertConnection` (`connections.ts`), which normalizes the login (`Shroud`, `@shroud`, `twitch.tv/shroud` ->
  `shroud`), looks it up on Helix and answers `Twitch user "x" not found.` for an unknown one (a Twitch outage during
  that check does not block saving — the poll retries). Dashboard: Integrations -> Twitch card -> **Add watch** (login +
  channel), `POST /guilds/:id/integrations/alerts`, same validation. Only Instagram and the two calendars still reply
  with / show an OAuth link.
- The shared OAuth redirect (`/integrations/twitch/callback`, `routes/oauth-integrations.ts`) is untouched and still
  serves the owner-only bot identity (`twitch_bot`), the creator-dashboard sign-in / connect / channel-points flows
  (§19e) and the legacy `twitch_chat` refusal. None of those start from the per-guild Integrations page.
- **Delivery**: with `PUBLIC_WEBHOOK_BASE_URL` (or `API_BASE_URL`) + `TWITCH_EVENTSUB_SECRET` set, one `stream.online`
  EventSub **webhook** subscription per broadcaster, callback `${base}/webhooks/twitch`; otherwise `poll-twitch` polls
  Helix `/streams` every 2 minutes. The receiver (`routes/webhooks.ts`) verifies the HMAC signature only and is not
  domain-specific, so deliveries are accepted on both `api.pavisie.com` and the retired `api.entrophybot.com`.
- **`ensureTwitchEventSub`** (run by `poll-twitch` every 2 minutes for each alert, and immediately on creation) no longer
  trusts "409 = already exists": it lists the app's `stream.online` subscriptions (`GET /eventsub/subscriptions?type=
  stream.online`, paginated; ONE list per poll run, cached 60s in-process and kept in step with its own creates/deletes),
  keeps a webhook subscription for the broadcaster whose callback equals the current one and whose status is `enabled`
  (or `webhook_callback_verification_pending`, i.e. just created), and **deletes every other** webhook subscription for
  that broadcaster (old callback domain, `*_failed`, `authorization_revoked`, `notification_failures_exceeded`, ...)
  before creating a fresh one. A create answered 409 is still success; a list that cannot be read falls back to a plain
  create and never deletes blind. A 429 backs the whole path off until Twitch's `Ratelimit-Reset`. A missing Twitch user
  marks the connection `ERROR` ("Twitch user "x" not found.") and the poll no longer overwrites that with "synced".
- **`twitch-eventsub-cleanup`** job (every 30 minutes): deletes `stream.online` **webhook** subscriptions that point at a
  `/webhooks/twitch` receiver (any domain) whose broadcaster has no active alert connection in any guild (not
  soft-deleted, not `DISCONNECTED`, not chat-kind, with a target). Connections with no recorded broadcaster id are
  resolved by login first; if the list or that lookup can't be read, nothing is deleted. WebSocket-transport
  subscriptions (the chat bot's, §19a) and every other subscription type are never touched. Logs counts only.

## 19a. Twitch chat bot (inside the `integrations` plugin)

Pavisie joining a streamer's Twitch chat to answer commands — a distinct feature from the `integrations`
plugin's Twitch stream-live alerts (§J), sharing only the `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` env vars.
No 15th plugin: lives in `packages/plugins/src/integrations/twitch-chat/` (`helix.ts`, `socket.ts`, `manager.ts`,
`engine.ts`, `timers.ts`) plus the `twitch-chat-tick` job. **Since creator-dashboard phase 4 (§19e) there is no `/twitch`
slash command and no Discord dashboard UI for any of this**: the chat bot belongs to the streamer and is managed ONLY from
`/creator`; the Discord side of the `integrations` plugin is notifications/alerts only. What remains in this plugin is the
runtime (below).

- **Identity model**: ONE global `TwitchBotIdentity` row — Brandon authorizes Pavisie's own Twitch account once
  (owner-only `POST /owner/twitch-bot/connect`, scopes `user:read:chat user:write:chat user:bot`). Every chat
  read/send runs on this token, never a broadcaster's. A streamer's channel is linked ONLY from the creator dashboard
  (§19e; scope `channel:bot`, plus `channel:read:redemptions` when they enable channel points) — no Discord server needed;
  it upserts a `TwitchChatChannel` row (status `PENDING` until the manager subscribes it). (The Discord dashboard's own
  connect flow, `POST /:guildId/integrations/twitch-chat/connect`, was removed in phase 4; a `twitch_chat` OAuth state issued
  by it just before that shipped is refused by the callback with a pointer to `/creator`.) There is at most ONE row per Twitch channel (`broadcasterUserId` is globally unique),
  and its `guildId` is optional (§19e).
- **Transport**: the official EventSub WebSocket (`wss://eventsub.wss.twitch.tv/ws`), using Node 22's built-in
  global `WebSocket` — no new runtime dependency. `EventSubSocket` (`socket.ts`) is a thin frame classifier
  (`session_welcome`/`session_keepalive`/`session_reconnect`/`notification`/`revocation`) with a keepalive
  watchdog (no keepalive/notification within `timeout+5s` → treat the socket as dead) and exponential-backoff
  reconnect (1s→60s, jittered). A brand-new session invalidates all subscriptions (recreated on the next
  reconcile); a `session_reconnect`-follow session carries them over automatically.
- **`TwitchChatManager`** (module-level singleton instantiated in `integrations/index.ts`, so the same instance
  backs both the job and the registered service) owns the socket and reconciles desired vs. actual
  `channel.chat.message` v1 EventSub subscriptions every minute via the `twitch-chat-tick` job (cron
  `* * * * *`): desired = every enabled `TwitchChatChannel` row, guild-linked or not (each runs on its own
  `enabled` flag, §19e; **no per-guild `integrations` plugin gate since phase 4** — see "Ownership and the guild plugin
  switch" below), capped at 300 (one WebSocket session's zero-cost-subscription limit — excess channels are left unsubscribed
  with a warning log). Replies go out through Helix `POST /helix/chat/messages` (`sendChatMessage`, client-side
  throttled to 1 send/sec/broadcaster; anything beyond that is dropped, never queued). On `revocation` (e.g. the
  broadcaster revoked `channel:bot`) the channel is marked `ERROR` with `lastError`.
- **Bot-identity token refresh**: Twitch user tokens expire (~4h) and Twitch **rotates the refresh token on every
  use** — the new one must be persisted or the next refresh fails outright. `helix.ts`'s `getBotAccessToken`
  refreshes proactively once the token has less than 10 minutes left, under a short Redis lock
  (`redisKey('integrations','twitchchat','refreshlock')`, TTL 15s) so the bot and api processes don't both spend
  the one-time-use refresh token at once; a failed refresh marks the identity `ERROR` with `lastError`.
- **Command engine** (`engine.ts`, pure/testable — no `PluginContext`, no Prisma, no network): prefix match on
  the channel's `commandPrefix` (default `!`); self-ignore (messages from the bot's own user id); chatter level
  resolved from the EventSub event's badges (`everyone < subscriber < vip < moderator < broadcaster`) gating a
  command's `minLevel`; per-`(channelId, commandName)` in-memory cooldown; `{user}`/`{channel}` templating only
  (no other interpolation). Built-ins `!commands` (lists enabled custom command names), `!uptime` (via Helix
  `GET /streams`), `!title` (via Helix `GET /channels`) — reserved names a NEW custom command can never take
  (`commands`/`uptime`/`title`, plus the channel currency's `balance`/`bal`/`daily`/`give`/`top` — §18b — all in
  `TWITCH_CHAT_RESERVED_COMMAND_NAMES`, enforced at the API layer, on the creator dashboard's routes).
  Unlike the built-ins, the economy names are tried by a separate module BEFORE the engine even sees the
  message (`integrations/twitch-chat/economy-commands.ts` — §18b) — the engine itself has no economy knowledge
  and an EXISTING custom command with a reserved name still wins. `timers.ts` fires enabled `TwitchChatTimer`s
  whose interval has elapsed, only into channels the manager currently holds a live subscription for.
- **API**: the creator dashboard's routes (`/creator/twitch/*`, §19e) and the owner-only bot-identity routes under
  `/owner/twitch-bot` — see §10. **Dashboard**: `/creator` (§19e). The Discord dashboard's `/dashboard/[guildId]/integrations`
  keeps only a read-only notice (the Twitch channel(s) linked to the server, a link to `/creator`, an Unlink button).
  *(Before phase 4 the API was guild-scoped CRUD under `/:guildId/integrations/twitch-chat` and the UI a 4th "Twitch chat"
  tab on that page.)*
- **Privacy contract**: chat message text is parsed **in memory only**, to match a command, and is **never
  persisted or logged**. Pino logs may include a channel login and a command *name*, never message text or
  chatter identity. The one carve-out: the streamer can opt a channel linked to their Discord server into the Discord <-> Twitch chat bridge
  (below), which — only for the direction(s) they explicitly turn on, off by default — relays plain chat/message
  text to the *other* platform. That relayed text is still never persisted or logged by Pavisie; it is only ever
  held in memory for the length of one relay call. Once relayed, though, it becomes an ordinary message on the
  destination platform and is stored there under that platform's own terms — deleting the original does not
  delete the relayed copy. **A second carve-out** (§18b/§19e): when a streamer turns on their channel's virtual currency (Agis by default —
  they can rename it; configured on the creator dashboard, working with or without a Discord server), Pavisie stores a
  Twitch wallet held **per Twitch channel** — Twitch user id, display name, balance, and an append-only
  transaction history — for each viewer who runs an economy chat command, earns from chat, or receives currency
  from another viewer via `!give` (a `!give` recipient gets a wallet only once the give succeeds). The streamer can also
  add to or remove from a viewer's balance (recorded with their reason). Chat message *text* is still never stored;
  only the reserved economy commands' resolved arguments (a login to resolve, an amount) are ever used, in memory, to
  make a ledger call, and are not logged. No Twitch-side moderation actions (ban/timeout/delete) ship in v1 — no moderator
  scopes are requested.
- **Discord <-> Twitch chat bridge** (`twitch-chat/bridge-format.ts`, `bridge-webhook.ts`, `bridge-metrics.ts`,
  `bridge-discord-handler.ts`; `TwitchChatManager`'s `runBridgeReconcile`/`relayTwitchToDiscordIfBridged`; configured on
  `/creator` only): each linked `TwitchChatChannel` can point at ONE Discord text channel, with two independent
  toggles, both **off by default**. **Discord -> Twitch**: a `messageCreate` handler formats the message as
  `[Discord] <display name>: <text>` (mentions resolved to plain names, `@everyone`/`@here` neutralized, markdown
  escaped, truncated to fit) and sends it via the existing bot-identity `sendChatMessage` Helix call/throttle. A
  short delay-then-recheck (~2s) lets the independent `automod` plugin's own `messageCreate` handler delete the
  message first if it's going to — there's no synchronous "automod is about to act" signal available, so this is
  a best-effort gate, not a guarantee. **Twitch -> Discord**: the bot creates (once, lazily) a Discord channel
  webhook named "Pavisie Twitch Bridge" in the bridge channel (webhook id + token persisted, token encrypted at
  rest the same way `overlayTokenEnc` is) and posts through it as `<name> (Twitch)` — no Twitch avatar fetching.
  Safety measures on both directions: self-ignore (never relay the bridge's own messages back), a command-prefix
  skip (`+`/`/`-prefixed text isn't relayed), `allowedMentions: { parse: [] }` plus text-level `@everyone`/`@here`
  neutralization, and reuse of the existing 1-send/sec/broadcaster Discord->Twitch throttle (drops are counted
  in-memory via `bridge-metrics.ts`, never logged with content). A reconcile-pass access check
  (View Channel/Send Messages/Manage Webhooks) surfaces failures via `TwitchChatChannel.bridgeLastError`. The bridge is
  configured only by the streamer, from `/creator`, for a server they connected there (section 19e; validation in
  `apps/api/src/lib/integrations/twitch-bridge-shared.ts`). The bridge acts inside a Discord server, so it (both directions,
  the webhook provisioning and the "now bridged" announcements) only runs while that server has the `integrations` plugin
  enabled — the Discord->Twitch `messageCreate` handler through the loader's per-guild plugin gate, the Twitch->Discord
  relay and the reconcile pass through `isGuildIntegrationsOn`; with the plugin off they are skipped quietly (the chat bot
  itself is not affected) and resume when it is back on.
- **Startup resilience**: `TwitchChatManager.start` never throws and never gives up. On a deploy the bot can boot before
  the api's pre-deploy migration finishes, so the first database read may fail ("column does not exist"); that is logged
  and retried on a capped backoff (5s doubling to 60s, forever, until `stop()`), and the minute `twitch-chat-tick`
  reconcile independently retries the connect as well. A failing bot-identity lookup counts as a failed startup (it is
  no longer mistaken for "owner setup pending").
- **Degrades gracefully**: with `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` unset, or before a `TwitchBotIdentity`
  row exists, the manager stays idle and reports why (`TwitchChatService.status()`), surfaced on the
  creator dashboard and in the plugin's `health()` — no crash, no error spam. Every `twitch-chat-tick` tick
  retries, so completing owner setup later brings the manager up with no bot restart.
- **Ownership and the guild plugin switch** (phase 4): the chat bot, commands, timers, channel currency and SOUND/CHAT/TTS
  channel-point rewards belong to the STREAMER, so they run for every enabled `TwitchChatChannel` regardless of the
  `integrations` plugin's state in a linked Discord server (`computeDesiredChannels` no longer calls `ctx.isEnabled`). Before
  phase 4 a server admin turning the plugin off silently stopped a linked streamer's chat bot, which contradicted that.
  What still respects the server's plugin switch is only what acts INSIDE the server: the bridge and the DISCORD reward
  action (`TwitchChatManager.isGuildIntegrationsOn`: needs a linked server AND the plugin on; a lookup failure counts as
  "off"). Because nothing then depends on it for the chat bot, linking a server from `/creator` no longer switches the
  server's `integrations` plugin on (it used to, as a side effect); the creator dashboard reports `integrationsEnabled` so it
  can say the bridge and Discord posts are paused while it is off.
- **Shutdown**: `apps/bot/src/index.ts`'s `shutdown()` calls `host.services.get('twitchChat')?.stop()` (closing
  the socket and clearing in-memory state) before `redis.quit()`/`prisma.$disconnect()`, mirroring how the
  plugin job workers are closed.

## 19b. Twitch channel-point rewards (inside the `integrations` plugin)

A channel-point reward (something a Twitch viewer buys with channel points in chat) triggers an action in
Pavisie: playing a sound on the streamer's OBS overlay, speaking text via TTS, posting to Twitch chat, or
posting to a Discord channel. Live inside `integrations/twitch-chat/` (`rewards.ts`, `tts.ts`, `manager.ts`,
`broadcaster-token.ts`) plus API routes and dashboard UI. Since creator dashboard phase 2b (§19e) everything here except
the DISCORD action works for a channel with **no Discord server**, and since phase 4 it is managed ONLY from the creator
dashboard (there is no `/twitch reward` command and no Discord dashboard tab any more).

- **Identity model**: each enabled `TwitchChatChannel` row carries an optional `rewardsEnabled` boolean (default
  `false`) and an `overlayTokenEnc` capability-token field. Rewarding starts only when both: the channel has
  rewards enabled, AND the broadcaster has granted `channel:read:redemptions` scope (a broadcaster's own token,
  not the bot's). That token lives in **`TwitchBroadcasterToken`**, keyed by the Twitch chat CHANNEL
  (`channelId` unique, `onDelete: Cascade`) — not by a Discord guild — so a guildless channel can hold one
  (phase 2b; before it, the token sat in the guild-scoped `IntegrationConnection`'s `OAuthToken`, which a guildless
  channel has no way to own). Encrypted at rest (`encryptSecret`: `accessTokenEnc`, `refreshTokenEnc`), with
  `scopes`, `expiresAt`, `rotatedAt`, and a `status`/`lastError` that goes `ERROR` after a terminal refresh
  failure (for a guild-linked channel that state is mirrored, best-effort, onto its `IntegrationConnection`, a leftover
  of the removed Discord-side flow that the Discord dashboard hides). It is written by exactly one flow now, via `storeBroadcasterToken`
  (`apps/api/src/lib/creator/broadcaster-token.ts`): the creator dashboard's "enable channel points" (§19e); the Discord
  dashboard's connect/re-link callback that used to write it was removed in phase 4. A grant without the scope (or
  without a refresh token/expiry) is never stored, and re-authorizing replaces the row wholesale. Migration
  `0016_creator_channel_rewards` **moved** every existing guild-linked channel's token from `OAuthToken` into it
  (verbatim ciphertext, only tokens carrying the scope, then deleted from `OAuthToken` — moved rather than copied
  because Twitch rotates the refresh token on every use, so a leftover old row could be refreshed by a bot
  still running the previous build and strand the copy), so existing streamers do not re-authorize. The manager's
  reconcile checks the token/scope every tick and surfaces a plain-language error in `lastError` rather than
  silently failing.
- **EventSub subscription model**: one unfiltered `channel.channel_points_custom_reward_redemption.add` v1 subscription
  per enabled channel (never one per reward, which would exhaust Twitch's 300-subscription limit). Matching of a
  redemption event to configured `TwitchChatReward` rows happens in application code (`rewards.ts`): by `rewardId`
  when populated (from the dashboard's "list rewards from Twitch" picker), else by case-insensitive `rewardTitle`.
  Multiple rows can match the same redemption title (e.g. one row SOUND, one row DISCORD), each with independent
  cooldown. Disabled rows or rows failing the cooldown gate contribute nothing.
- **Subscription capacity**: the bot's ONE EventSub WebSocket session supports 300 zero-cost subscriptions. Since
  each linked channel can now carry **two** subscriptions (chat + rewards), the channel cap dropped from 300 to 150
  (worst case: every channel has rewards enabled).
- **Overlay delivery** (SOUND + TTS actions): the redemption arrives in the `bot` process, but the overlay browser
  connects to the `api` process. The bot publishes the action over Redis (`pavisie:overlay:<channelId>`) and the
  `api` process subscribes via a **second, dedicated ioredis client in subscriber mode** — a subscriber-mode client
  cannot run normal Redis commands and the shared client is already in use by BullMQ + rate limiting. This design
  works with multiple `api` replicas: each replica receives every message and writes only to its own connections.
- **TTS synthesis**: OBS's embedded browser ships no speech voices, so `window.speechSynthesis` is unavailable. TTS
  is therefore synthesized server-side using `OpenAI`'s `/v1/audio/speech` endpoint, trying `gpt-4o-mini-tts` first
  and falling back to `tts-1` if the model is unknown. It is **bring-your-own-key** — there is no platform-wide
  TTS key and no cost to the operator. **Key precedence** (`tts.ts` `resolveTtsApiKey`): (1) the channel's own
  key, `TwitchChatChannel.ttsOpenAiKeyEnc` (encrypted, set from the creator dashboard, write-only in the API —
  never returned, only "set / not set"; the only option for a guildless channel); (2) otherwise, for a channel
  linked to a Discord server, that **guild's own configured OpenAI key** (the `ai` plugin's, as before). The
  channel key wins when both exist; a channel key that no longer decrypts means no TTS (it does NOT silently fall
  through to the guild's key). A channel with neither, or a guild with a non-OpenAI provider (Anthropic), simply
  gets no TTS; when this happens, the TTS action logs a warning and is skipped silently, reported honestly (not an
  error).
  Synthesis never blocks the redemption — any failure leaves other configured actions for the same redemption free
  to run.
- **Sound effects**: admin-supplied public HTTPS URLs, validated at write time by the existing SSRF guard
  (`assertPublicHttpUrl`). No file upload or blob storage — the platform has no place to store arbitrary audio files.
- **Text templating**: TTS and chat/Discord actions support `{user}` (redeemer's display name), `{input}` (viewer's
  optional text input for a reward requiring it), and `{reward}` (the reward title) — no other interpolation. TTS
  caps final text at 200 chars; chat/Discord cap at 300 chars, both **after** templating (so an oversized `{input}`
  cannot smuggle an over-length string past the limits). Control characters are stripped, whitespace is collapsed,
  and the text is trimmed before final text is queued.
- **Privacy contract**: the viewer's redemption input text is **never persisted or logged** — same stance as chat
  message handling. Only the reward title and action kind appear in logs, never the templated text or the
  redeemer's name. The overlay URL (`:token`) is a capability token, encrypted at rest, and can be regenerated
  without changing the channel — treat the URL like a password.
- **Per-reward cooldown** (`cooldownSeconds`, default 0): independent in-memory cooldown per `(channelId,
  rewardRowId)` pair, keyed by the reward row's database id (not the Twitch reward id), so a channel with two
  actions configured for the same reward title can have different cooldowns.
- **Overlay as browser source**: the overlay is a simple HTML page the `api` serves at `/overlay/:token`, held
  open by the browser via Server-Sent Events. Every SOUND/TTS action is queued to play in sequence (FIFO); the
  overlay dedupes by the action's unique `id` field (uuid) so a reconnecting browser does not replay already-played
  sounds. Volume is clamped 0-100 (default 80). The overlay page has a strict CSP (`default-src: none`, media from
  `https:` + `self` + data: URIs), contains **no user input or attack surface**, and serves a simple "link expired"
  page when the token is invalid. It is keyed to the channel row (not a guild), so it works unchanged for a guildless
  channel; the creator dashboard shows/rotates it through `lib/overlay-token.ts` (`issueOverlayToken`, shared with
  the creator dashboard's overlay routes).
- **Dashboard**: the "Channel points" section of `/creator` (§19e). Config is per-reward with write validation: `action`
  kind determines which payload fields are required (soundUrl for SOUND, ttsTemplate for TTS, chatTemplate for
  CHAT, both discordChannelId + discordTemplate for DISCORD). Rows are created with a `rewardTitle` and matched to
  redemptions by title, case-insensitively (a `rewardId` column exists for an id match, but nothing currently fills it: the
  "List rewards from Twitch" picker never shipped and its Helix helper was removed in phase 4).
- **Degrades gracefully**: with `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` unset, or before a `TwitchBotIdentity` row
  exists, the manager's rewarding reconcile passes are skipped and the channel reports `rewardsEnabled: false`. If
  rewards ARE enabled but the broadcaster's token lacks `channel:read:redemptions`, the channel's `lastError` field
  reports the scope gap plainly instead of silently failing. TTS synthesis degrades when neither the channel nor its
  guild has an OpenAI key — actions are logged and skipped, never errors. A bad `soundUrl` or invalid
  `discordChannelId` causes that action to be skipped (logged), while other actions for the same redemption run
  normally.

## 19c. `gamestats` plugin — Steam leaderboards

Plugin id `gamestats` (§7.1) — the platform's 15th plugin, category `community`, `defaultEnabled: false`. Folder
`packages/plugins/src/gamestats/`. `requiredEnv: ['STEAM_API_KEY']` — unavailable (see `/plugin status`) without it,
same "declare it, degrade honestly" pattern as `media`'s `MEDIA_PROVIDER` gate. No privileged intents; no per-guild
`dashboard` entry (config drawer only — every setting is a member's own link and not configurable per guild).

- **Opt-in linking, self-reported and unverified, self-service removal**: `/dbd link account:<text>` accepts a
  pasted SteamID64, profile URL, or vanity name, resolves it (`ISteamUser/ResolveVanityURL/v1` when needed),
  verifies stats are actually fetchable with a live (cache-bypassing) call, and upserts a `GameAccountLink` row.
  There is no Steam sign-in, so the bot cannot confirm the linking member actually owns the account — the only
  enforcement is `GameAccountLink`'s `@@unique([guildId, provider, externalId])` constraint plus a proactive
  `findFirst` check in `handleLink`: an account already linked by another member in the same guild is rejected
  with a friendly error (and the constraint's P2002 catches the race between the check and the write). `/dbd
  unlink` deletes that link and the member's stat snapshots in this guild immediately — no staff approval, and
  (matching the community plugin's birthdays) not audited, since it is the member's own opt-in data.
- **Curated snapshot only, no history**: `ISteamUserStats/GetUserStatsForGame/v2` for Steam appid `381210` (Dead by
  Daylight — the first and only game in v1) is filtered down to the game descriptor's named stat keys
  (`packages/plugins/src/gamestats/games/dbd.ts`) via `getGameStats`'s `keepKeys` option BEFORE the result is
  cached or returned — the provider's full stats payload never touches Redis or Prisma. Each refresh overwrites
  the `GameStatSnapshot` row; `lastError` (e.g. `private`) is surfaced back to the member instead of a stale or
  blank card.
- **Refresh job**: `gamestats-refresh`, cron `*/30 * * * *`, iterates `GameAccountLink` rows in guilds where the
  plugin is enabled and re-fetches each linked member's curated stats, isolating one member's failure from the
  rest (per-row try/catch). No-ops entirely without `STEAM_API_KEY`. `/dbd refresh` calls the same
  `refreshMemberStats` with `bypassCache: true` so a member forcing a refresh always sees Steam's current state,
  never a stale Redis hit.
- **No resurrecting a deleted link**: `refreshMemberStats` re-checks the `GameAccountLink` row still exists
  (`findUnique` by id) immediately before writing a `GameStatSnapshot`, skipping the write if the member unlinked
  while the Steam call was in flight.
- **Steam-only, honestly labeled**: no public stats API exists for console platforms, so command copy and the
  plugin README say so plainly rather than guessing or scraping. A private Steam profile ("Game details" not
  Public) produces a guided error naming the exact fix (Steam profile → Edit Profile → Privacy Settings → Game
  details → Public), not a silent failure. Steam's `GetUserStatsForGame` returns a 403 when Game details truly
  isn't Public, but also returns a generic 500 for its own transient hiccups — a 500 is cross-checked against
  `GetPlayerSummaries`' visibility before deciding `private` vs. a distinct `transient` reason, so a passing Steam
  outage never sends a member to check a privacy setting that isn't the problem.
- **Game-pluggable**: built around a `GameDescriptor` (`games/` folder, `GAMES` registry) rather than a hardcoded
  game, so a second title is a new descriptor file, not a new architecture.
- **Data export**: `GameAccountLink` and `GameStatSnapshot` rows are included in the guild data-export path
  (`apps/bot/src/host/data-requests.ts`) and deleted with the guild's data (cascade), same as every other
  guild-scoped model.

## 19d. Twitch Extension — the Agis panel (EBS in `apps/api`, front-end `apps/twitch-extension`)

A Twitch panel extension shown under a streamer's video: the channel's currency name/symbol, the viewer's
wallet balance, a "Claim daily" button (same rules/streak as `!daily`), and the channel's leaderboard
(lifetime earned, top 10). Reuses the channel-owned currency (`ChannelEconomy`/`ChannelWallet`, §18b) — this
is a second *client* of the same data the chat bot already reads/writes, not a new data model. A viewer's wallet is
`{ economyId: <the channel's ChannelEconomy>, viewerUserId: <real Twitch user id> }` — never linked to a Discord
wallet, never linked across channels. Since phase 2a the panel needs **no Discord server**: it is resolved from the
channel's own currency alone.

- **EBS routes** (`apps/api/src/routes/twitch-ext.ts`, prefix `/twitch-ext`): `GET /summary` (read-only —
  `{ enabled, currencyName?, currencySymbol?, identityShared?, wallet?, leaderboard? }`, bigints as decimal
  strings) and `POST /daily` (claims through the ledger, `{ ok, amount?, streak?, retryAfterMs? }`). Both 503
  `extension_not_configured` while either `TWITCH_EXTENSION_CLIENT_ID`/`TWITCH_EXTENSION_SECRET` is unset —
  same "declare it, degrade honestly" pattern as every other optional integration.
- **Auth**: every request carries `Authorization: Bearer <Twitch Extension Helper JWT>`, verified HS256-only
  (`apps/api/src/lib/twitch-ext/jwt.ts`, `verifyTwitchExtensionJwt` — a standalone, framework-free, hand-rolled
  verifier over `node:crypto`, not a JWT library: the signing key is the extension's shared secret, base64-
  decoded per Twitch's own spec). Rejects any `alg` other than `HS256` (including `none`) BEFORE ever comparing
  a signature, a bad/tampered signature (constant-time `timingSafeEqual`), an expired `exp`, and any malformed
  token — all as a generic 401 with no detail leakage (the verifier's specific rejection `reason` is for
  logs/tests only, via `apps/api/src/lib/twitch-ext/auth.ts`'s `requireTwitchExtensionAuth`, never echoed to
  the caller). Extracts `channel_id`, `opaque_user_id` (always present), `user_id` (present only once the
  viewer has shared identity via `Twitch.ext.actions.requestIdShare()`), and `role`.
- **Channel -> currency -> enablement** (`apps/api/src/lib/twitch-ext/context.ts`,
  `resolveTwitchExtChannelContext`): `channel_id` is looked up directly as the channel's `ChannelEconomy`
  (`platform = TWITCH`, `channelUserId = channel_id`) and must be `enabled`. No `TwitchChatChannel` row, no guild and
  no guild economy plugin are involved — a streamer who only uses the creator dashboard (§19e) is fully supported.
  Any failure (no currency set up, or the streamer switched it off) is `{ enabled: false }` — a normal 200, never an
  error — so the panel shows a plain "not enabled for this channel" message instead of an error state.
- **Never creates a wallet just for viewing**: `GET /summary` reads `ChannelWallet`/`ChannelTransaction`
  directly (`apps/api/src/lib/twitch-ext/wallet-summary.ts`) rather than calling the ledger's
  `getOrCreateChannelWallet` (which upserts) — a viewer who never claims/earns/receives currency leaves no row behind
  just from opening the panel. An absent wallet reads as a zero balance, claimable-now, streak 0. Balance
  **writes** (`POST /daily`) go through `packages/plugins/src/channel-economy/ledger.ts`'s `claimChannelDaily`
  only, same as every other channel-economy mutation path (that ledger is the only module allowed to write a
  `ChannelWallet` balance) — the leaderboard read reuses its `getChannelEarnedLeaderboard` rather than a second
  query.
- **CORS**: `/twitch-ext/*` is served to `https://<TWITCH_EXTENSION_CLIENT_ID>.ext-twitch.tv` — a different
  origin than the dashboard's `@fastify/cors` registration in `app.ts` (which stays `[DASHBOARD_URL, WEB_URL]`,
  unwidened) — with no `Access-Control-Allow-Credentials` (bearer-token auth only, no cookies ever sent).
  Hand-rolled per-route (`twitch-ext.ts`'s own `onRequest` hook + explicit `OPTIONS` routes, each with
  `config: { cors: false }` to opt out of the root `@fastify/cors` plugin) rather than a second
  `@fastify/cors` registration: that plugin is wrapped with `fastify-plugin`, so a second registration's
  auto-generated preflight route would still run the ROOT registration's hook first (parent hooks always run
  before a child scope's) and that hook replies to every `OPTIONS` request itself before a nested instance gets
  a turn — silently breaking the extension's preflight. See the long comment at the top of `twitch-ext.ts` for
  the full reasoning.
- **CSRF**: `/twitch-ext/` is in `lib/csrf.ts`'s `EXEMPT_PREFIXES` — bearer-JWT authenticated, no dashboard
  session/cookie in play, so there is no CSRF token to check (belt-and-suspenders: `csrfProtection` already
  no-ops on any request with no `request.session`, which a cross-origin bearer-only call always is).
- **Rate limiting**: per `opaque_user_id` (`apps/api/src/lib/twitch-ext/auth.ts`'s `twitchExtensionRateLimitKey`,
  wired via each route's `config.rateLimit.keyGenerator`), not per-IP — many viewers of the same stream can
  share a broadcaster-adjacent CDN/proxy pool.
- **Env**: `TWITCH_EXTENSION_CLIENT_ID` / `TWITCH_EXTENSION_SECRET` (`packages/core/src/env.ts`), both optional,
  a different credential pair from `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` (those belong to the Twitch
  *application* behind the chat bot/stream alerts; these belong to the Twitch *Extension* itself — Twitch dev
  console -> Extensions -> your extension -> Extension Secrets). See `.env.example` and `infra/DEPLOYMENT.md` §6.
- **Front-end** (`apps/twitch-extension`, workspace package `@pavisie/twitch-extension`): plain HTML/CSS +
  TypeScript compiled straight to a browser-native ES module — no framework, no bundler (Twitch's review
  rejects both a bundler-introduced pattern it can't statically verify and any third-party script host besides
  Twitch's own `extension-files.twitch.tv/helper/v1/twitch-ext.min.js`, the one remote script this package
  loads). `src/panel.ts`'s pure helpers (`formatCountdown`, `formatAmount`, `msUntil`) are unit-tested directly;
  all `document`/`window`/`Twitch.ext` access is guarded behind `typeof window !== 'undefined'` so importing
  the module under `vitest` never touches the DOM. States: loading; `enabled:false` -> "Agis isn't enabled for
  this channel yet."; identity not shared -> the balance area is replaced with a "Share your Twitch identity"
  button (`Twitch.ext.actions.requestIdShare()`), leaderboard still shown; normal -> balance, streak, claim
  button (disabled with a live countdown while on cooldown), leaderboard. Text is always set via `textContent`,
  never `innerHTML`. Brand: gold-and-black (§20), panel width fixed at 318px (Twitch's own panel constraint).
  `scripts/build.mjs` compiles `src/*.ts` (via a dedicated `tsconfig.build.json`) and copies `public/*.{html,css}`
  into `dist/` — exactly the files to zip and upload. `config.html` (the broadcaster-facing settings page) has
  nothing to configure — it says setup happens in the Pavisie dashboard and links nowhere external.
- **Review/hosting flow** (`apps/twitch-extension/README.md` has the click-by-click version): upload the zipped
  `dist/` contents as a new Extension version in the Twitch dev console, set the Panel component's viewer path
  to `panel.html` and config path to `config.html`, turn on **Request Identity Link**, add the API origin to
  **Allowlist for URL Fetching Domains**, set the Extension Secret on the API's Railway env, run **Hosted Test**
  against a real/test channel end-to-end, then submit for Twitch's review.

## 19e. Creator dashboard — streamers without a Discord server (Phase 1)

Pavisie is being split in two: the Discord dashboard keeps moderation/community/alerts, and a NEW, separate
**creator dashboard** (`/creator` on the web app, `/creator/*` on the API) lets a streamer sign in with their
streaming-platform account (Twitch now, Kick later) and use Pavisie's streaming features with **no Discord
server**. Everything is built with a `platform` discriminator (`CreatorSessionData.platform`, URL shapes like
`/creator/auth/twitch/...` and `/creator/twitch/...`) so a second platform plugs in beside Twitch.

**Phase plan** (phases 1, 2a, 2b, 3 and 4 are built; 4 minus the deferred old-row drop):
1. *(this section)* Creator sign-in with Twitch, guildless Twitch chat channels, the creator dashboard's chat
   bot section (connect/disconnect, prefix, commands, timers).
2. Split in two:
   - **2a (DONE)** — the currency becomes **channel-owned** (not guild-owned): `ChannelEconomy`/`ChannelWallet`/
     `ChannelTransaction`, carry-over migration `0015_channel_economy`, economy commands/earning/the extension work
     for guildless channels, a "Currency" section on the creator dashboard (settings, top viewers, manual balance
     adjust). The old guild-scoped Twitch rows and config keys are kept, unused, until phase 4 (§18b).
   - **2b (DONE)** — channel-point rewards, the OBS overlay and bring-your-own-key TTS move to the creator dashboard
     and work for a guildless channel: the broadcaster token now lives per channel (`TwitchBroadcasterToken`, §19b),
     a creator-side "enable channel points" authorize, rewards CRUD / master switch / overlay URL / TTS key routes and
     a "Channel points" section (see "Channel points" below), migration `0016_creator_channel_rewards`. The DISCORD
     reward action came with phase 3.
3. **(DONE)** An OPTIONAL "connect a Discord server" flow from the creator dashboard: the streamer signs into Discord to
   prove they manage a server where Pavisie is a member, picks it, and the channel is linked (`TwitchChatChannel.guildId`).
   That verified connection is what unlocks the Discord <-> Twitch chat bridge (configured on `/creator`), the DISCORD
   reward action, and the pointer to the server's combined leaderboard (`/economy leaderboard platform:global`; wallets
   are never merged). Migration `0017_creator_discord_link` (two audit columns). See "Connect a Discord server" below.
4. **(DONE, except the deferred old-row drop)** The Twitch chat features are gone from the Discord side: the `/twitch` slash
   command, the Discord dashboard's "Twitch chat" tab, the guild-scoped chat routes and the guild-linked connect flow are
   removed; the Discord side of the `integrations` plugin is notifications/alerts only (stream-live alerts, YouTube, Reddit,
   Steam, calendars, Instagram, generic webhooks). What the Discord dashboard keeps: a read-only notice on
   `/dashboard/[guildId]/integrations` (a pointer to `/creator`, and which Twitch channel is linked to the server) with an
   **Unlink** button — a server admin can always disconnect THEIR server from a channel (Discord session + manage access +
   CSRF + an audit entry, `unlinkChannelFromGuild`). The chat bot no longer depends on the server's `integrations` plugin
   (§19a "Ownership and the guild plugin switch"), and linking no longer switches that plugin on. **Not done, on purpose:**
   dropping the old guild-scoped `TWITCH` `EconomyAccount`/`EconomyTransaction` rows (and the `TWITCH` value of the
   `EconomyPlatform` enum) kept, unused, since phase 2a — the owner confirms the migrated balances first, and a later
   migration removes them. No migration shipped in phase 4.
5. Kick as a second platform.

- **Sign-in** (`apps/api/src/lib/creator/oauth.ts`, `routes/creator-auth.ts`): `GET /creator/auth/twitch/login`
  stores a random single-use `state` in Redis (`redisKey('creator-login-state', state)`, 10 min), binds it to the
  browser with a signed, httpOnly, `sameSite: 'lax'` pre-login cookie `creator_login_state` (same reasoning as the
  Discord login's `oauth_state`, §10: the callback is a top-level GET redirect), and 302s to Twitch's authorize URL
  with **no scopes** (identity only — Helix "Get Users" works with a scope-less user token).
- **Callback branching** — the redirect URI is the ALREADY-REGISTERED `${API_BASE_URL}/integrations/twitch/callback`
  (nothing new to register in the Twitch console). `routes/oauth-integrations.ts`'s pre-handler
  (`detectCreatorCallback`) looks the returned `state` up in the creator namespaces first: a creator-login state
  (or a signed pre-login cookie matching it, so an expired/replayed state gets a proper message) runs
  `completeTwitchCreatorLogin`; a `creator-connect-state` runs `completeTwitchCreatorConnect`; anything else falls
  through to the original guild flows with the Discord-session gate (`requireAuth`) and behaviour unchanged. The
  creator branches never need a Discord session. Only Twitch has creator flows.
- **Login completion**: browser-binding check first (a wrong browser does NOT consume the state), then the
  single-use Redis state, then the code exchange (`exchangeProviderCode`), one Helix Get Users call
  (`identifyTwitchUser`, now also returning `profile_image_url`), and the token is **discarded — never stored** —
  and revoked best-effort (`revokeTwitchToken`). A fresh creator session is created (the browser's previous one is
  destroyed) and the browser is redirected to `${WEB_URL ?? DASHBOARD_URL}/creator`.
- **Creator session** (`lib/creator/session.ts`): SEPARATE from the Discord session — cookie `csid` (signed,
  httpOnly, same `sameSite`/`secure`/`COOKIE_DOMAIN` rules as `sid`), Redis `pavisie:creator-session:<sid>`, 7-day
  sliding TTL, data `{ platform: 'twitch', platformUserId, login, displayName, avatarUrl, csrfToken }` (no
  token). `request.creator` (decorated in `app.ts`) is what `requireCreatorAuth` / `requireTwitchCreator`
  (`lib/creator/auth.ts`) check; a Discord `sid` never authenticates a creator route nor vice versa.
  `GET /creator/me` → `{ creator, csrfToken }` (401 without a session); `POST /creator/logout` destroys it.
- **CSRF**: every mutating `/creator/*` request needs `X-CSRF-Token` = the creator session's token **and** an
  allowlisted `Origin`/`Referer` — `lib/csrf.ts` picks the session from the matched route (see §10), so the two
  session types cannot be crossed.
- **Ownership rule**: the creator whose Twitch user id equals `TwitchChatChannel.broadcasterUserId` owns that row,
  whether or not it has a `guildId`. The channel is never addressed by id in a creator URL — it is always looked up
  from the session — so the owner's existing guild-linked channel simply appears in their creator dashboard, and
  someone else's channel is unreachable; a missing channel, or a command/timer id belonging to another channel, is
  a **404** (never 403). Every route is rate limited (60/min; sign-in 20/min).
- **Guildless channels** (data + bot): `TwitchChatChannel.guildId` is optional and `broadcasterUserId` is globally
  unique (migration `0014_creator_guildless_twitch_channels`; `TwitchChatCommand.guildId` / `TwitchChatTimer.guildId`
  are optional too — they mirror their channel's guild). An existing row keeps its `guildId`, which now means "the
  linked Discord server". `TwitchChatManager` runs EVERY channel purely on its own `enabled` flag (since phase 4 there is no
  `ctx.isEnabled` gate for guild-linked channels either; only the bridge and DISCORD rewards still respect the server's
  plugin switch). For a guildless channel
  custom commands, timers and the built-ins (`!commands`, `!uptime`, `!title`) work; **skipped cleanly** (never a
  crash, never an error message into Twitch chat): the Discord bridge and the DISCORD reward action. **Channel-point
  rewards DO run** for a guildless channel (phase 2b — SOUND, CHAT and TTS on the channel's own OpenAI key, below).
  **Economy commands
  and chat earning DO run** for a guildless channel (phase 2a) — the currency is owned by the channel, not by a guild
  (§18b) — as does the Twitch extension panel. The Discord-side routes/commands filter by `guildId`, so guildless
  channels never show up in a guild's dashboard. A Discord
  server can never attach itself to a creator's channel: attaching a guild is done only by the creator themselves, from
  the creator dashboard (phase 3's connect-a-Discord-server flow below); the Discord dashboard's own connect flow that once
  did it was removed in phase 4.
- **Connect the bot** (`POST /creator/twitch/channel/connect`): returns the Twitch authorize URL for scope
  `channel:bot` only, with a `creator-connect-state` naming the signed-in creator. The callback requires the
  creator session, requires the state to have been issued to THAT creator, and requires the Twitch user who
  authorized **to be the signed-in creator** (otherwise it writes nothing and redirects to
  `/creator?error=twitch-account-mismatch`); it then upserts the channel by `broadcasterUserId` (new: guildless,
  `PENDING`; existing: re-armed in place — `enabled`, `PENDING` — keeping its `guildId`, connection and settings) and
  nudges the bot's reconcile (`nudgeTwitchChatReconcile`). For a plain chat connect the broadcaster token is discarded (channel points
  are a separate, explicit authorize — "Channel points" below). `DELETE /creator/twitch/channel` deletes a guildless row
  (commands/timers cascade, as the Discord dashboard's old channel delete did) but only **disables** a guild-linked one
  (`enabled=false`, `DISCONNECTED`) so the Discord side keeps its data.
- **Other routes**: `GET /creator/twitch/channel` (`{ botConfigured, botLogin, envConfigured, channel | null }`; the
  channel DTO carries `discordLinked`, never the guild id), `PATCH` (`enabled`, `commandPrefix` only — bridge/reward
  fields are rejected), commands (max 50) and timers (max 10) CRUD with the same schemas and reserved-name rules as
  the Discord routes (`lib/integrations/twitch-chat-schemas.ts`, shared helpers in `twitch-chat-shared.ts`,
  economy names included). No audit-log rows: the audit log is per Discord guild and a creator action has no Discord
  actor.
- **Channel currency** (phase 2a; `routes/creator-twitch-economy.ts`, prefix `/creator/twitch/economy`, same creator
  session + CSRF rules, 60/min — 20/min for `adjust`): the streamer's OWN `ChannelEconomy` (§18b), always looked up as
  (TWITCH, the session's Twitch user id) — there is no id in any URL or body (unknown body keys such as a smuggled
  `channelUserId`/`economyId` are a 400), so another channel's currency is unreachable by construction. It needs no
  Discord server and no chat-bot connection.
  - `GET /` → `{ configured, settings }`; with no row it returns the defaults with `configured: false` and **writes
    nothing** (viewing never creates a row).
  - `PATCH /` (partial, strict, Zod-validated with the guild economy's bounds; min<=max checked against the merged
    settings, error code `invalid_economy_settings`): the FIRST save upserts the row from the defaults + the patch (a
    native upsert on the unique key, so two racing first saves cannot both insert); an empty patch changes nothing and
    creates nothing. `enabled` is the master switch.
  - `GET /leaderboard?limit=` → `{ configured, earned[], balance[] }` (lifetime earned and current balance, amounts as
    decimal strings); empty arrays, not an error, before setup or before anyone has earned.
  - `POST /adjust` `{ login, direction: 'add'|'remove', amount, reason }` — the streamer's manual balance change:
    the login is checked against Twitch's own alphabet, then resolved to a stable user id via Helix with the shared
    **app** (client-credentials) token (`lib/creator/twitch-users.ts`; a Helix outage is a 502, never "no such user");
    `reason` is required (≤200 chars) and stored as the transaction's note; a remove can never take a balance below
    zero (409 `would_go_negative`); a channel that has not saved its currency yet is a 404. It writes an
    `admin_add`/`admin_remove` ledger row through `adminAdjustChannel`; no audit-log row (no Discord actor).
- **Channel points** (phase 2b; `routes/creator-twitch-rewards.ts`, prefix `/creator/twitch/rewards`, creator session +
  CSRF, 60/min — 20/min for `authorize`, `overlay/regenerate` and `tts-key`): the streamer's OWN channel, always looked
  up from the session (no channel id in any URL or body; smuggled keys are a 400), so another channel is unreachable
  and a foreign reward id is a 404. No audit rows (no Discord actor).
  - `GET /` → `CreatorRewardsStatusDto` (`channelExists`, `channelEnabled`, `rewardsEnabled`, `authorized`,
    `authorizationError`, `hasOverlay`, `ttsKeyConfigured`, `discordLinked`, `maxRewards`) — flags only, never a secret;
    `PATCH /` `{ rewardsEnabled }` (strict; turning ON is a 409 `channel_points_not_authorized` until a working token
    exists).
  - `POST /authorize` → `{ url }`: the reused redirect URI and a `creator-connect-state` whose payload now carries
    `purpose: 'channel-points'` (absent = a plain chat connect, so states issued before this shipped still work) and
    scopes `channel:bot channel:read:redemptions`. The callback (`lib/creator/oauth.ts`) still requires the creator
    session, a state issued to THAT creator, and the authorizing Twitch account to BE the signed-in creator
    (otherwise nothing is written, that token is revoked, and it redirects to `/creator?error=twitch-account-mismatch`);
    a grant missing the scope/refresh token is revoked and redirects to `?error=channel-points-scope-missing`. On
    success it stores the token (`storeBroadcasterToken`), creates the guildless channel row if there is none, and
    leaves an EXISTING row's `enabled`/`status` alone (authorizing must not switch a bot the creator turned off back
    on); rewards stay OFF until the creator flips the switch. `DELETE /authorize` forgets the token and turns rewards
    off (rewards, overlay URL and TTS key are kept).
  - `GET/POST/PATCH/DELETE /items[/:rewardId]` — the same schemas, SSRF guard on `soundUrl`, resulting-state check,
    duplicate 409 and 25-per-channel limit the Discord dashboard's routes used to enforce (shared helpers in
    `twitch-chat-shared.ts`). A reward's `guildId` copies the channel's (null for a guildless channel). **The DISCORD
    action is not offered from the creator dashboard, even on a Discord-linked channel**: posting into a Discord
    channel is authorized by Discord permissions, which a signed-in Twitch creator does not have (they may not be an
    admin of the linked server), so create/edit of it is a 400 and an existing Discord-post reward (made before phase 4 from the
    Discord dashboard) is listed read-only. Phase 3 (below) lifts this ONLY for a channel whose Discord server the
    creator connected from the creator dashboard (`discordLinkedBy` set): then create/edit/delete of it works, the
    target channel is validated against THAT server's channel list (text/announcement only, bot-token read), and `discordVerified` is
    reported by `GET /`. Without a verified connection (guildless, or linked from a server's own dashboard) it stays a 400.
  - `GET /overlay` → `{ url, hasToken }` and `POST /overlay/regenerate`: the OBS overlay URL is a capability secret,
    shown only to its owner (`Cache-Control: no-store`, never logged); reset rotates it (the old URL resolves to 410
    at once). `GET` never creates one.
  - `PUT /tts-key` `{ apiKey }` / `DELETE /tts-key` → `{ ttsKeyConfigured }`: the channel's own OpenAI key, `sk-…`
    shape-checked, stored encrypted (`ttsOpenAiKeyEnc`), write-only — no route ever returns it.
  Guildless channels can therefore run SOUND, CHAT and TTS rewards (TTS only with their own key); DISCORD needs a
  connected Discord server (phase 3).
- **Connect a Discord server** (phase 3; `lib/creator/discord-link.ts`, `routes/creator-twitch-discord.ts`, prefix
  `/creator/twitch/discord`). Streaming features never need it; it is an optional add-on the streamer connects FROM `/creator`.
  - *Sign-in that proves control*: `GET /connect` (creator session required, 20/min) stores a single-use state under
    `creator-discord-state:<state>` (payload: the creator's platform + id), binds it to the browser with a signed,
    httpOnly, `sameSite: lax` cookie `creator_discord_state`, and 302s to Discord's authorize URL with `prompt=consent`
    and the login's own scopes, **`identify guilds` only**. It REUSES the already-registered Discord redirect URI
    (`DISCORD_OAUTH_REDIRECT_URI` = `/auth/discord/callback`; nothing new to register in the Developer Portal):
    `routes/auth.ts`'s callback first asks `detectCreatorDiscordCallback` (state in the creator namespace, or a matching
    signed cookie so an expired/replayed state gets a proper message) and hands a hit to `completeDiscordCreatorConnect`;
    anything else is the dashboard login, byte-for-byte unchanged.
  - *Callback order* (mirrors the Twitch connect): browser binding first (a wrong browser is a 400 and does NOT consume the
    state), then the creator session (`csid`; none = 401), then the single-use state, which must have been issued to THAT
    creator (403 otherwise), then the code exchange. It never creates or touches a Discord `sid` session. The token is used
    for exactly two reads (`/users/@me`, `/users/@me/guilds`), revoked best-effort (`revokeDiscordToken`) and **never stored**.
  - *Candidate list*: the user's guilds filtered to those where they have Manage Server / Administrator / are owner
    (`hasManageAccess`, the Discord dashboard's own rule) AND the bot is a member (`Guild.botPresent`, the table the bot keeps
    in sync; the same check `requireGuildAccess` uses). It is stashed in Redis for 10 minutes under
    `creator-discord-candidates:<creator session id>` (with the Discord user id) and the browser is sent to
    `/creator?discord=pick`. `GET /candidates` returns `{ pending, candidates[] }` (an empty list is honest: no matching servers).
  - *Link* (`POST /link { guildId }`, 20/min, creator CSRF, strict body): the guild id must be IN the stashed list for THIS
    session (never trusts the client; another session or creator holds no stash), else 403; no stash = 409
    `discord_sign_in_required`. It re-checks bot presence (404 if the bot left), refuses a channel already linked to a
    DIFFERENT server (409 `discord_already_linked`: disconnect first), then: (1) leaves the server's **Integrations plugin** exactly
    as its admin set it (phase 4; before it, linking switched the plugin on because the chat bot stopped whenever it was off —
    that coupling is gone, and only the bridge and Discord reward posts still need the plugin on in the server). (2) sets `guildId`, `discordLinkedBy` (the Discord user
    id) and `discordLinkedAt`, resetting the bridge; (3) mirrors `guildId` onto the channel's commands/timers/rewards; (4)
    writes `integration.twitch_chat.discord.link` to the SERVER's audit log (actor = that Discord user). The stash is then
    consumed (one Discord sign-in proves one link). Re-linking the same server is idempotent (and upgrades an unverified link).
    Not transactional: the channel row is written first and the mirrors after; a retry repairs it.
  - *Verified vs unverified*: `discordLinkedBy` set = the creator proved control (**verified**). A `guildId` with no
    `discordLinkedBy` is a link a Discord admin made from the Discord dashboard before phase 4 removed that flow; it keeps working, but the creator dashboard
    reveals no server details for it (`server: null`) and refuses the bridge / picker / Discord rewards (409
    `discord_link_unverified`) until the creator disconnects and reconnects it. The Discord dashboard can no
    longer attach a server to a channel at all (phase 4).
  - *Unlink* (`DELETE /link`, 20/min, CSRF; works for either kind of link, since it is the creator's own channel): the bridge
    webhook is deleted from Discord best-effort; the bridge is cleared and switched off; **DISCORD-action rewards are DELETED**
    (their target channel id only means something in the unlinked server, and a leftover disabled reward the creator could
    neither edit nor use would be dead weight; a guildless channel never holds one; the confirm dialog says so); the
    commands/timers/rewards drop their guild mirror; `guildId`/`discordLinkedBy`/`discordLinkedAt` are cleared (the channel row,
    the marker, is written LAST so a failed attempt can be retried); `integration.twitch_chat.discord.unlink` is written to the
    server's audit log (actor `twitch:<id>`). Commands, timers, currency, other rewards, overlay and the TTS key are kept. The
    Discord dashboard's **Unlink** (`DELETE /guilds/:guildId/integrations/twitch-chat/channels/:channelId`, phase 4) runs the
    SAME unlink for ANY channel linked to that server — verified or not, actor = the Discord user, audit `unlinkedBy: 'discord'` —
    and never deletes the channel (before phase 4 it deleted a channel linked from the Discord dashboard; the streamer's channel
    is not the server admin's to delete).
  - *Bridge* (`GET/PATCH /bridge`, 60/min, verified link only): `{ discordChannelId, discordToTwitch, twitchToDiscord, lastError }`,
    strict body, both directions off by default. The PATCH validates (`prepareBridgeUpdate`: the channel must exist in the linked server and be text/announcement, a direction cannot be on
    without a channel, changing the channel deletes the old webhook best-effort) and writes
    `integration.twitch_chat.discord.bridge.update` to the server's audit log. `GET /channels` lists the linked server's channels
    for the pickers (bot-token read, cached 60s; no guild id accepted from the client).
  - *Known limits*: if a server admin turns the server's Integrations plugin off, the bridge and Discord reward posts pause
    until it is back on (the status shows `integrationsEnabled: false` and the UI says so); the chat bot, commands, currency
    and other rewards are NOT affected (phase 4 removed that coupling, §19a). Control is verified at link time only: the Discord token is discarded, so a later loss of
    Manage Server is not noticed; server admins can disconnect the channel from their own dashboard at any time.
  - *Combined leaderboard*: no data is merged. `/creator`'s Top viewers card shows the channel's own Twitch leaderboard and, when
    a server is linked, a note that the server's `/economy leaderboard platform:global` shows both, each in its own currency.
  - *Privacy*: a Discord user id, link date and bridge settings are stored; the Discord token and server list are not (the short
    candidate list is dropped on link/expiry/logout); see `apps/web/src/content/legal.ts`.
- **Web** (`apps/web/src/app/creator/**`, `components/creator/*`, `lib/creator/*`): `/creator` signed out is a short
  "Use Pavisie on your stream — no Discord server needed" page with **Sign in with Twitch**; signed in it shows the
  Twitch avatar/name + sign out, a "Chat bot" section (status, connect/disconnect, prefix, commands, timers) and a
  "Currency" section (`components/creator/creator-currency.tsx`: enable switch, name/symbol, daily + streak, give limits,
  earning settings, a top-viewers table with Most earned / Highest balance tabs, and an "Adjust a balance" dialog; honest
  empty states — "not set up" until the first save, "no one has earned anything yet" — and form limits pinned to the API
  schema by a test) and a "Channel points" section (`components/creator/creator-channel-points.tsx`: connect / disconnect
  channel points with the master switch, the rewards table (`components/dashboard/integrations/twitch-chat-rewards-table.tsx`, fed through
  `TwitchChatRewardsBackend`), with "Send to Discord" offered only for a verified server, the OBS overlay link, hidden until revealed, with
  copy and a confirm-guarded reset, and the write-only TTS key field) and an optional "Discord server" section
  (`components/creator/creator-discord.tsx`: not connected = "Connect a Discord server" button and what it unlocks; after the
  Discord sign-in (`?discord=pick`) a pick screen listing only servers you manage where Pavisie is a member, with an honest empty
  state and an "Add Pavisie" link; connected = server name/icon, a "bridge and Discord posts are paused" warning when the Integrations plugin is
  off, a confirm-guarded Disconnect, and the bridge card (`TwitchChatBridgeCard`) fed by the creator routes; the reward dialog gets "Send to Discord" through `CreatorDiscordChannelSelect` only for a verified server).
  Its own session provider (`CreatorSessionProvider`, mounted in `app/creator/layout.tsx`, `GET /creator/me`) and
  `creatorFetch` (attaches the creator token, never the Discord one). The commands/timers/rewards tables and dialogs live in
  `components/dashboard/integrations/twitch-chat-*.tsx` (their old home, before phase 4 removed the Discord-side tab that also used
  them) and stay data-source-agnostic through `lib/dashboard/twitch-chat-backend.ts` (hooks passed as a `backend` prop;
  today only the creator implementation exists, in `lib/creator/queries.ts`). `apps/web/src/middleware.ts` only gates
  `/dashboard`, so `/creator` (the public landing) is untouched.
- **Privacy**: a creator session holds the Twitch id/login/display name/avatar for up to 7 days (sliding); the
  sign-in token is never stored (`apps/web/src/content/legal.ts`). A streamer's channel currency (phase 2a) keeps
  per-viewer wallets (Twitch id, display name, balance, transaction history) per Twitch channel, whether or not a
  Discord server is linked. If the creator enables channel points (phase 2b) Pavisie also keeps the broadcaster token
  for `channel:read:redemptions` (encrypted, per channel) until they disconnect it, the channel's rewards, the overlay
  link (encrypted) and — only if they add one — their own OpenAI key for TTS (encrypted, never shown again); viewers'
  redemption text is used in memory only and never stored or logged. No new env vars.

## 20. Brand tokens: gold-and-black

The brand is gold-and-black (not monochrome — see §O): black/grey/white surfaces and structure, with a gold
accent ramp for the primary action/brand colour. `packages/ui/src/styles.css`: surfaces black→grey scale;
`--primary` = `#fafafa` on dark / `#0a0a0a` on light; `--ring` grey; keep `--success/--warning/--destructive`
semantic tokens (dashboard only). Dashboard charts use greyscale series with dashed/dotted differentiation
(a legibility choice, not a brand claim).

**Gold accent ramp** (sampled from the logo, hue 30-45°, darkest to lightest), defined as `--gold-1`..`--gold-7`
in `apps/web/src/app/globals.css` (hex) and `packages/ui/src/styles.css` (HSL triple), and wired to
`text-gold-N`/`bg-gold-N`/`border-gold-N` Tailwind classes in `apps/web/tailwind.config.ts` the same way
`ink`/`grey`/`paper` are:

| Token      | Hex       | HSL                 | Verified contrast                       | Role                                                    |
| ---------- | --------- | ------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `--gold-1` | `#2a1806` | `30 75% 9.4%`       | —                                        | Dark/decorative only (borders, subtle fills on black)   |
| `--gold-2` | `#42270c` | `30 69.2% 15.3%`    | —                                        | Dark/decorative only                                    |
| `--gold-3` | `#603b12` | `32 68.4% 22.4%`    | —                                        | Dark/decorative only                                    |
| `--gold-4` | `#8f5e20` | `34 63.4% 34.3%`    | 5.31:1 on `--paper` (`#fafafa`) — AA     | **Primary accent, light theme**                         |
| `--gold-5` | `#c7933d` | `37 55.2% 51%`      | 7.44:1 on `--ink-0` (`#050505`) — AAA    | **Primary accent, dark theme**                          |
| `--gold-6` | `#eec66a` | `42 79.5% 67.5%`    | —                                        | Bright emphasis on black only                           |
| `--gold-7` | `#f9db7e` | `45 91.1% 73.5%`    | —                                        | Bright emphasis on black only                           |

Role assignments are fixed: never use gold-5/6/7 as text on the light theme, or gold-1/2/3 as text on the dark
theme — both fail contrast. `BRAND.color = 0xc7933d` (gold-5) in core constants (embeds); success/error embeds
keep green/red.

**Where gold is allowed (the fill-vs-edgeline rule).** Gold *fill* is reserved for the single emphasis action on
a view — the `primary` button variant (`bg-gold-5`, `text-ink-0`, brightening to gold-6 on hover). Everywhere
else gold appears only as an *edgeline or text accent*, to mark "you are here" or "this is hoverable": the
dashboard tab strip's selected tab (`border-gold-5` + `bg-gold-5/10` + `text-gold-5`, hover hint at
`border-gold-5/40`), the `secondary`/`outline` button borders on hover, marketing nav links on hover, and focus
rings. The point is that the accent stays scarce enough to actually direct attention; if everything is gold,
nothing is. Surfaces, body copy and chrome stay black/grey/white.

Because `html.light` overrides `--gold-5` to the gold-4 value, a component written as `text-gold-5` or
`border-gold-5` automatically steps down to the AA-safe stop on the light theme — so components never need a
light-mode gold variant of their own.

## 21. Cloud hosting (production target)

Production runs on a cloud host, not a home machine. Deliverables and rules:

- **Recommended path: Railway** (always-on services; managed Postgres + Redis; deploy from GitHub; per-service
  Dockerfile). Ship `infra/railway/README.md` (exact click-path: New Project → Deploy from GitHub → add 4 services from
  the same repo (bot, api, dashboard, web) each with Root Directory `/` and Dockerfile path
  `infra/docker/Dockerfile.<app>` → add Postgres + Redis plugins → set variables (reference `${{Postgres.DATABASE_URL}}`
  and `${{Redis.REDIS_URL}}`) → generate public domains for api/dashboard/web → set OAuth redirect in the Discord
  Developer Portal → run migrations (the `api` image runs `pnpm db:migrate` as a pre-deploy command or a one-off
  `railway run pnpm db:migrate`) → `commands:register`) and `infra/railway/<app>.railway.json` files
  (`{"$schema":"https://railway.app/railway.schema.json","build":{"builder":"DOCKERFILE","dockerfilePath":"infra/docker/Dockerfile.<app>"},"deploy":{"healthcheckPath":"/health","restartPolicyType":"ON_FAILURE"}}` —
  bot uses `BOT_HEALTH_PORT` for its healthcheck; web/dashboard healthcheck `/`).
- **Alternative: Render Blueprint** — root `render.yaml` declaring: `api` (web, docker, healthCheckPath /health,
  preDeployCommand `pnpm db:migrate`), `dashboard` (web, docker), `web` (web, docker), `bot` (worker, docker),
  `pavisie-postgres` (database), `pavisie-redis` (keyvalue/redis). Env vars wired with `fromDatabase`/`fromService`
  and `sync: false` for secrets. Note that free tiers sleep — bots need a paid always-on worker.
- **Alternative: any VPS** with the existing `docker-compose.yml` (document Caddy/Traefik TLS in front).
- Cross-site cookies: PaaS-provided subdomains (`*.up.railway.app`, `*.onrender.com`) are on the Public Suffix List, so
  the API and dashboard are _cross-site_ unless custom domains under one apex are used. Add env
  `SESSION_COOKIE_SAMESITE=lax|none` (default `lax`; when `none`, the cookie is `Secure` and the API refuses to start
  without HTTPS-looking `API_BASE_URL`), and `COOKIE_DOMAIN` for the custom-domain case. CSRF remains protected by the
  `X-CSRF-Token` header + Origin allowlist (`DASHBOARD_URL`, `WEB_URL`). Document both setups with the recommended
  option = custom domain (`api.example.com`, `app.example.com`, `example.com`, `COOKIE_DOMAIN=.example.com`).
- Public URLs needed by features: `API_BASE_URL` (OAuth redirect `${API_BASE_URL}/auth/discord/callback`,
  Twitch EventSub/generic webhooks `${PUBLIC_WEBHOOK_BASE_URL}` = API base), `DASHBOARD_URL`, `WEB_URL`.
- Operations docs (`infra/DEPLOYMENT.md`, cloud-first): first deploy checklist, env var table with where each value
  comes from, running migrations, registering commands, rotating secrets, viewing logs, backups (managed Postgres
  snapshots), updating (push to main → auto-deploy), rollback (redeploy previous build), and rough monthly cost
  guidance with a "check current pricing" caveat. GitHub Actions CI stays as the gate before auto-deploy.

## 21a. Production domain: pavisie.com

Brandon owns `pavisie.com`. Canonical production layout (use these everywhere docs need a concrete example, and
ship `.env.production.example` pre-filled with them, secrets blank):

| Surface                                     | URL                                                                                                        | Env                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Website + config dashboard (§11)           | `https://pavisie.com` (+ `www` → redirect to apex; dashboard UI at `/dashboard/**`, no separate domain) | `WEB_URL=https://pavisie.com`                                                            |
| Legacy dashboard redirector / ops console (§11a) | `https://app.pavisie.com` — 308s `/` and `/dashboard/*` to the website above; other paths reach the real (currently placeholder) app | `DASHBOARD_URL=https://pavisie.com` (same value as `WEB_URL` now), plus `WEB_URL`/`NEXT_PUBLIC_API_URL` set on this service itself (see §11a) |
| API                                         | `https://api.pavisie.com`                                                                              | `API_BASE_URL=https://api.pavisie.com`, `NEXT_PUBLIC_API_URL`, `PUBLIC_WEBHOOK_BASE_URL` |
| Cookies                                     | shared apex                                                                                                | `COOKIE_DOMAIN=.pavisie.com`, `SESSION_COOKIE_SAMESITE=lax` (default; `none` not needed) |
| Discord OAuth redirect                      | `https://api.pavisie.com/auth/discord/callback`                                                        | `DISCORD_OAUTH_REDIRECT_URI`                                                                 |
| Twitch EventSub / generic webhooks          | `https://api.pavisie.com/webhooks/...`                                                                 | —                                                                                            |
| Brand links                                 | `BRAND.siteUrl = 'https://pavisie.com'`, embed icon `https://pavisie.com/brand/pavisie-skull.png` | `WEB_URL`                                                                                    |
| Contact in policy templates                 | `contact@pavisie.com` (confirmed 2026-08-24, monitored), operator name "Pavisie"                        | —                                                                                            |

DNS (documented in `infra/DEPLOYMENT.md`, cloud-first): at the registrar create `CNAME app` / `CNAME api` /
`CNAME www` → the host's per-service targets, and apex `pavisie.com` via ALIAS/ANAME (or the host's apex
instructions); the host provisions TLS automatically. CORS allowlist = `[DASHBOARD_URL, WEB_URL]` — both now the
same origin (`https://pavisie.com`) post-merge, so this allowlist has one effective entry in practice, not two.

## 22. Brand assets (logo = bot avatar)

The Pavisie logo and bot avatar is a gold laurel-wreath medallion with a skull, on pure black, square,
1024×1024, used everywhere: website, dashboard, bot embed icon, and Discord avatar. Canonical file:
`assets/brand/pavisie-skull.png` (present in the repo, lossless PNG; takes precedence over the `.jpg` when both
exist). `assets/brand/pavisie-skull.jpg` is the same art re-encoded as JPEG, kept only so any URL or cached
reference that still names the `.jpg` file keeps serving the current art instead of 404ing or showing stale art. The
sync script copies every existing shared candidate (both `.png` and `.jpg`, when present) into each app's
`public/brand/`, and writes `public/brand/manifest.json` with `logo` naming the preferred one
(`{ "logo": "/brand/pavisie-skull.png" }`) so pages reference the right extension. If no shared file is present,
everything below must degrade gracefully — never fail a build because it is missing.

- `assets/brand/README.md` documents the expected files and how they are consumed.
- Website: `apps/web/public/brand/pavisie-skull.png` + `.jpg` (copied at build by `scripts/sync-brand.mjs`, root
  script `brand:sync`, run automatically as `prebuild`/`predev` of web and dashboard; the script is a no-op when the
  source is missing) used in the header, hero, Open Graph image (`opengraph-image` route rendering the skull on
  black) and `src/app/apple-icon.png`. The `Logo` component (`apps/web/src/components/Logo.tsx`) reads the
  build-time copy of the manifest at `apps/web/src/data/brand.json` (git-tracked, written by the sync script) rather
  than fetching `public/brand/manifest.json` at runtime, so the logo path is known at build time in every
  environment including the Docker standalone runner.
- Dashboard: same sync into `apps/dashboard/public/brand/pavisie-skull.png` + `.jpg`; the sidebar wordmark
  (`apps/dashboard/src/components/brand-wordmark.tsx`) reads its own build-time manifest copy at
  `apps/dashboard/src/data/brand.json` (git-tracked, same pattern as the web app's) rather than hard-coding the
  path, and falls back to a text wordmark when the image 404s (`<img onError>` → hide) or when the manifest has no
  logo.
- Browser-tab favicons: `apps/web/src/app/icon.png` and `apps/dashboard/src/app/icon.png` (256×256, resized from
  `assets/brand/pavisie-skull.png`, black background kept) are committed static files picked up by Next's
  app-router file convention — `sync-brand.mjs` does not generate or touch them, and no `icons` entry is needed in
  either app's `metadata`. Regenerate both by hand (see `assets/brand/README.md` "Regenerating favicons") whenever
  the canonical skull PNG changes.
- Bot: `pnpm --filter @pavisie/bot set-avatar [--file assets/brand/pavisie-skull.png]` (`apps/bot/src/set-avatar.ts`,
  one-off CLI: logs in, `client.user.setAvatar(buffer)`, exits; warns about Discord's avatar-change rate limit) and
  `BRAND.iconUrl = ${WEB_URL}/brand/pavisie-skull.png` used as embed author/footer icon when `WEB_URL` is set (core
  `constants.ts` exports `brandIconUrl(env)`, default path `/brand/pavisie-skull.png`, overridable via
  `BRAND_LOGO_PATH`).
- Also list `assets/brand/pavisie-skull.png` in the README "Discord Developer Portal setup" step (upload as the App
  Icon and Bot avatar) — the Portal upload is manual.
- Website-only override (optional, currently unused): `assets/brand/pavisie-skull-web.png`/`.jpg`, if ever added,
  would be a variant used by the public website's header/hero/`apple-icon` only, resolved from web-specific
  candidates before falling back to the shared candidates above. No such file exists in the repo today — the shared
  logo already is the clean/bright art the website wants — but the sync script still supports it: on fallback,
  `apps/web/public/brand/manifest.json` and `apps/web/src/data/brand.json` gain a `sharedLogo` key alongside `logo`
  (`{ "logo": "/brand/pavisie-skull.png", "sharedLogo": "/brand/pavisie-skull.png" }` while unused — both point at
  the same shared file); `logo` is "whatever the website displays" and `sharedLogo` always points at the shared file
  for any website code that needs the canonical/bot-avatar image specifically. The dashboard manifest, the bot's
  `set-avatar` script, and `brandIconUrl` (core `constants.ts`) are untouched by this override and always read the
  shared `pavisie-skull.<ext>` — never the web-only variant.
