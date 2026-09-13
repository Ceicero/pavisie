# Pavisie — Product Requirements Specification

Pavisie is a production-ready, modular, "all-in-one" Discord bot platform. The goal is to provide the core feature categories commonly found across large Discord bots while remaining compliant with Discord's Developer Terms, Developer Policy, API rate limits, privacy expectations, and server permission model.

(This is the authoritative requirements document. Architecture and coding conventions live in `ARCHITECTURE.md`; the two must be read together.)

## IMPORTANT NON-NEGOTIABLE RULES

1. Use only official Discord APIs, approved OAuth flows, webhooks, and legitimate public APIs.
2. Do not automate user accounts, self-bots, token scraping, token storage, token sharing, mass-DM activity, spam, raiding, evasion of Discord restrictions, CAPTCHA bypassing, or execution of other bots' slash commands.
3. Do not request Administrator permission by default. Use a least-privilege invite permission set and document optional permissions per feature.
4. Never log message contents, user data, API keys, passwords, Discord bot tokens, OAuth secrets, or moderation evidence unless the feature explicitly needs it and the server administrator enables it.
5. Add rate limiting, audit logging, permission checks, input validation, error handling, database migrations, and secure secret handling.
6. Build all features as modular plugins that can be enabled or disabled per Discord server.
7. Use slash commands and context-menu commands as the primary interface. Include buttons, select menus, and modals where useful.
8. Include a clear README, setup instructions, Docker support, tests, and an admin configuration dashboard.
9. Never hardcode credentials. Use environment variables and provide `.env.example`.
10. Before each destructive moderation action, use confirmation buttons or a modal unless an administrator explicitly enables a fast-action setting.

## TECH STACK

- Node.js 22+
- TypeScript with strict mode
- discord.js v14 or latest stable compatible version
- PostgreSQL with Prisma ORM
- Redis for cache, rate limiting, queues, cooldowns, and temporary data
- BullMQ for background jobs
- Fastify for the API/dashboard backend
- Next.js for the web dashboard
- Tailwind CSS plus a clean accessible component system
- Zod for validation
- Pino for structured logging
- Vitest for unit tests
- Playwright for dashboard end-to-end tests
- Docker Compose for local development
- GitHub Actions CI workflow for lint, typecheck, test, and build

## ARCHITECTURE

Monorepo with:

- apps/bot: Discord gateway bot and interaction handlers
- apps/api: Fastify REST API and OAuth callback handlers
- apps/dashboard: Next.js admin dashboard
- packages/core: config, permission logic, errors, logging, shared utilities
- packages/database: Prisma schema, client, migrations, seed scripts
- packages/plugins: modular Discord features
- packages/ui: reusable dashboard components
- packages/types: shared TypeScript types
- infra: Docker, deployment notes, CI configuration

Plugin registry with:

- plugin metadata
- required bot permissions
- required Discord intents
- required environment variables
- command registration
- configuration schema
- enable/disable state per guild
- health status
- migration hooks if a plugin requires data changes

The bot must safely degrade if an optional integration is not configured.

## CORE PLATFORM FEATURES

### A. SERVER SETUP AND ADMINISTRATION

- `/setup wizard` guided server configuration
- `/config view`
- `/config set`
- `/plugin enable`
- `/plugin disable`
- `/plugin status`
- `/permissions audit`
- `/health`
- Per-guild configuration stored in PostgreSQL
- Role-based access control using Discord permissions plus configurable staff roles
- Owner override only where appropriate
- Full admin audit trail for configuration changes

### B. MODERATION PLUGIN

Implement: `/warn`, `/warnings`, `/clearwarns`, `/timeout`, `/untimeout`, `/kick`, `/ban`, `/unban`, `/softban`, `/purge`, `/lock`, `/unlock`, `/slowmode`, `/nick`, `/role add`, `/role remove`, `/modnote`, `/case`, `/cases`
(In Pavisie these live under the `/mod` command group — see ARCHITECTURE.md.)

Requirements:

- Case IDs and immutable audit metadata
- Optional reason field for all actions
- Evidence links only; do not store sensitive content by default
- Moderator hierarchy checks
- Prevent action against server owner, bot owner, higher-ranked roles, or the bot itself
- Confirmation workflow for kick, ban, softban, purge, and bulk role actions
- Optional DM notification to the affected user, with graceful failure handling
- Mod-log channel with rich embeds and case IDs
- Configurable escalation rules, such as three warnings causing a timeout
- Expiration jobs for temporary punishments
- Appeals workflow through a modal and private staff channel
- Exportable moderation cases for server administrators

### C. AUTOMOD AND ANTISPAM PLUGIN

Configurable rules:

- Excessive message frequency
- Duplicate messages
- Excessive mentions
- Invite-link filtering
- Scam/phishing keyword and domain lists
- Regex word filters with safeguards against catastrophic regex patterns
- Caps and repeated-character rules
- Attachment and filename controls
- Optional NSFW channel enforcement
- New-account or low-account-age restrictions
- Raid detection based on join bursts
- Quarantine role and verification channel support

Requirements:

- Per-rule actions: warn, delete, timeout, quarantine, alert staff, or ignore
- Exempt roles, channels, users, and trusted domains
- Rule cooldowns and rate limits
- Dry-run mode that logs what would happen without taking action
- False-positive review queue
- Never claim AI detection is definitive; label AI-based risk scoring as assistive only

### D. LOGGING PLUGIN

Configurable log channels for:

- Member joins/leaves
- Message edits/deletes, with privacy-aware content capture disabled by default
- Role changes
- Channel and server setting changes
- Moderation actions
- Voice channel joins/leaves
- Invite usage if available and permitted
- Bot errors and plugin failures
- Webhook delivery failures

Include: retention configuration, redaction rules, searchable dashboard audit log, CSV export for administrators.

### E. TICKETS AND SUPPORT PLUGIN

- `/ticket open`, `/ticket close`, `/ticket add`, `/ticket remove`, `/ticket transcript`, `/ticket panel create`
- Category, support role, SLA, and transcript settings
- Button-driven ticket creation
- Optional modal intake form
- Private channel or private thread mode
- Close confirmation and reopen flow
- HTML and JSON transcript generation
- Transcript retention settings
- Staff assignment and ticket tags
- Dashboard ticket queue

### F. ROLE, ONBOARDING, AND VERIFICATION PLUGIN

- Reaction/button/select-menu role panels
- Self-assignable role groups with max-selection rules
- Welcome and goodbye messages
- Onboarding checklist
- Rules acknowledgement
- Verification through button + modal, configurable questions, and staff approval queue
- Optional CAPTCHA integration only through a trusted external provider and only if the admin configures it
- Auto-role for verified users
- Account-age gate and membership screening support where Discord exposes it
- Role persistence option for returning members, clearly disclosed to admins

### G. COMMUNITY AND ENGAGEMENT PLUGIN

- Leveling/XP with anti-farming controls
- Leaderboards
- Reputation system with cooldowns and abuse prevention
- Polls with anonymous or public options
- Giveaways with eligibility rules
- Scheduled announcements
- Reminders
- Suggestions with voting and staff status workflow
- Starboard/highlight board
- Custom welcome embeds
- Temporary voice channels
- Event RSVP and reminders
- Optional economy plugin, disabled by default, with no real-money functionality

### H. UTILITY PLUGIN

`/help`, `/userinfo`, `/serverinfo`, `/avatar`, `/banner`, `/roleinfo`, `/channelinfo`, `/timestamp`, `/poll`, `/remind`, `/translate` (approved translation API adapter), `/timezone`, `/embed builder`, `/afk`, `/calculator`, `/weather` (configurable approved weather API adapter), `/status` for bot/plugin health

### I. MUSIC AND MEDIA PLUGIN

Do not implement methods that bypass licensing or platform restrictions. Instead:

- Create an adapter interface for legal, user-authorized audio sources or streaming providers where their API and terms permit use
- Implement playlists, queue management, skip, pause, resume, volume, loop, and DJ role permissions
- If no compliant provider is configured, disable the plugin and explain why in `/plugin status`
- Include no YouTube scraping, stream ripping, or copyright bypassing

### J. INTEGRATIONS PLUGIN

Secure connector framework for optional integrations:

- Twitch: stream-live alerts using official API/webhooks where available, plus an opt-in chat bot — a dedicated Twitch bot account (owner-authorized once) joins a streamer's chat, per guild, once the streamer links their channel from the dashboard (OAuth `channel:bot`); it runs custom `!commands`/timers and built-ins over the official EventSub WebSocket + Helix Send Chat Message API, with no chat message content ever persisted and no Twitch-side moderation actions (ban/timeout/delete) in v1; plus opt-in per-channel channel-point reward actions (SOUND/TTS/CHAT/DISCORD) requiring broadcaster re-link with `channel:read:redemptions` scope, with TTS synthesis via the guild's own OpenAI key (or unavailable if none), sound URLs SSRF-validated, and viewer reward-input text never persisted
- YouTube: upload/live alerts through supported APIs
- Instagram: own-account-only OAuth connect (Instagram API with Instagram Login) posts the connected account's
  own new media into a channel — never an arbitrary username lookup, which Meta's API no longer supports
  (Basic Display API shut down Dec 2024)
- Reddit: approved API integration
- Steam: publicly available game/server status where permitted
- Google Calendar or Microsoft 365 Calendar: OAuth-based event notifications
- OpenAI/Anthropic-style AI provider interface for opt-in assistance features
- Generic webhook receiver and outbound webhook notifications
- GitHub, Notion and Stripe (role-reward) connectors were removed 2026-09-02 (owner decision); their Prisma
  enum values are retained for historical rows only — see `docs/ARCHITECTURE.md` §18a. Do not re-add them
  without asking.

Integration security: OAuth tokens encrypted at rest; token refresh support; scope minimization; signed webhook verification; secret rotation documentation; retry queue with exponential backoff; per-guild integration enablement; clear setup page and connection status; no impersonation of users; no access to data outside explicitly approved OAuth scopes.

### K. AI ASSISTANT PLUGIN

Optional, disabled-by-default AI helper:

- `/ask`, `/summarize` (restricted to messages the invoking user can access), `/draft`, `/mod-assist` (suggests, never automatically performs, moderation decisions)
- Per-server opt-in; per-channel allowlist; per-user cooldowns and token budgets
- Prompt-injection-resistant system architecture
- Content redaction before provider calls where possible
- No training on server data by default
- Clear disclosure that AI responses can be inaccurate
- Admin-configurable provider and model keys
- Do not expose private channel content or user data to unauthorized users

### L. DASHBOARD

Authenticated web dashboard using Discord OAuth:

- Verify the user's guild management permissions before allowing configuration
- Guild selector
- Plugin marketplace-style enable/disable controls
- Moderation case viewer
- Automod rule builder
- Log settings
- Ticket settings and ticket queue
- Role panel builder
- Welcome/embed builder with live preview
- Integration connection management
- Analytics: member growth, moderation volume, message activity only when data collection is enabled
- Audit log
- Data retention and privacy settings
- Export/delete server data controls
- Responsive design and dark mode

### M. PUBLIC WEBSITE & DONATIONS

Pavisie ships a public marketing website (separate from the admin dashboard).

Requirements:

- **Theme: black, grey and white only.** No colour accents anywhere on the website — status/hover states are expressed
  through luminance, borders and blur. "Smoky UI": layered soft radial-gradient smoke that drifts slowly (CSS only,
  respects `prefers-reduced-motion`), frosted-glass cards (`backdrop-blur`, hairline white/10 borders), a faint grain
  overlay, generous whitespace, thin clean type. Sleek and clean; no clutter.
- Pages: Home (hero, "Add to Discord", "Open dashboard", feature overview, why-gaming-communities section, trust &
  compliance section, donation CTA, footer), **Features & Commands** (every plugin: what it does, _why it's great for
  gaming communities_, and a table of every command/subcommand with description, who can use it and an example),
  **Enforcer** spotlight page (how flag → decision → ledger → appeal works, and the privacy/transparency claims),
  **Donate** (Ko-fi link-out), Privacy (template), Terms (template).
- **Donations**: Handled entirely by Ko-fi (a third-party donation platform). The donate page links to the operator's
  Ko-fi page when configured, or explains that donations are not set up when the Ko-fi URL is missing. Clear disclosure:
  donations are voluntary, fund hosting/development, are one-time, non-refundable, grant no perks or in-game advantages,
  and are not tax-deductible unless the operator states otherwise. Pavisie stores no donor information (names, emails,
  payment details) — Ko-fi's own privacy policy governs what they collect. If Ko-fi is not configured the page says so
  instead of failing.
- Command documentation on the website is **generated from the real plugin registry** (never hand-maintained lists) so it
  cannot drift from the bot.
- Responsive, accessible (WCAG AA contrast within the monochrome palette), dark-by-default (the palette is dark; a light
  variant is optional and also monochrome).

### N. ADMIN ENFORCER (POLICY-DRIVEN, HANDS-OFF MODERATION)

Goal: the bot is an **admin enforcer for moderators** — moderators' hands stay off the suspect's screen. Given a server
policy, the bot flags possible violations; a moderator reviews the exact chat context and tells the bot what to do; the
bot performs the action and communicates with the user; **everything is bookkept** in a read-only ledger channel and in
the database, searchable and appealable. Motivations: privacy (moderators never DM or confront the suspect directly),
transparency (a complete, immutable-by-policy record), and professional, consistent moderation for any server.

Requirements:

- Server admins define **policies** (name, plain-language description shown to mods and to the user on action, severity,
  matchers: keywords/phrases/regex (validated for catastrophic patterns)/link domains/invites/mention counts/attachment
  types, optional AI category (assistive only), scope channels, exemptions, suggested action).
- **Automatic flagging** of messages matching a policy (requires the Message Content privileged intent; without it the
  plugin runs in manual mode). **Manual flagging** by staff via a message context-menu command ("Flag for review") and
  `/enforcer flag` for non-message behaviour.
- Each flag creates a **pending record** and posts an embed to a staff-only flag-queue channel with buttons:
  Warn · Timeout · Mute · Kick · Ban · Dismiss · View context · Suspect history. Timeout/Mute/Kick/Ban open a modal
  for reason (and duration where relevant). Decisions are executed **through the moderation plugin** (cases, hierarchy
  checks, DM notice with record id + how to appeal). Two moderators cannot act on the same flag twice.
- **View context** shows the messages around the flagged one (live fetch when still available; a stored snapshot taken
  at flag time as fallback) so the moderator can read that exact chat.
- **Bookkeeping ledger**: a read-only channel (bot writes; nobody else can post) receives an entry for **every flag and
  every action**: record number, user ID, time, action taken, who decided, policy matched, and context (sanitised
  excerpt + jump link). Ledger visibility is staff-only by default, optionally server-wide for transparency. Records are
  also stored in the database (source of truth) with retention following the moderation-case policy.
- `/enforcer search` (by user, kind, decision, policy, since) and `/enforcer record <#>` over the ledger data;
  `/enforcer history <user>` summary; CSV export for admins.
- **Appeals**: `/enforcer appeal <record #>` (and the moderation plugin's `/appeal <case #>`) open an appeal through
  the moderation plugin's appeal workflow; appeal opened/decided entries are written to the ledger.
- Optional AI assistance only annotates a flag with a risk score/explanation labelled _assistive — not a decision_;
  it never decides or acts.
- Privacy: message excerpts/context snapshots are stored only because this feature needs them; this is disclosed in
  `/plugin status`, the dashboard, and the plugin README; captureContext can be turned off (then only jump links).
- Dashboard: policies editor, flag queue with the same decisions, ledger table with search/filter/export, settings.

### O. MONOCHROME BRAND

The product brand is monochrome (black/grey/white). The dashboard uses the same monochrome tokens for surfaces and
primary actions; semantic status colours (success/warning/destructive) remain for usability in the admin dashboard
only. Discord embeds use a light-grey brand colour bar; success/error embeds keep green/red.

### P. GAME STATS PLUGIN (STEAM LEADERBOARDS)

Per-guild leaderboards comparing members' stats in a shared game, built on **publicly available Steam data only** —
the same scoping already stated for the Steam connector in §J ("publicly available game/server status where
permitted"). First (and, for now, only) supported game: Dead by Daylight.

- **Member opt-in only, self-reported and unverified.** A member links a Steam account by pasting a SteamID64,
  profile URL, or vanity name (`/dbd link`) — there is no Steam sign-in, so the bot cannot confirm the account
  actually belongs to that member. The bot never enumerates, scrapes, or auto-discovers a guild's members' game
  libraries or Steam friends. The only enforcement against one account being claimed by multiple members is a
  same-guild duplicate guard: a Steam account already linked by another member in the guild is rejected.
- **Self-removal.** `/dbd unlink` deletes the member's link and their stored stat snapshot immediately — no staff
  approval, no delay.
- **Data minimization.** Store only the linked SteamID64, a cached persona display name, and the curated stat keys
  the supported game defines for display — never the account's full public profile, friends list, inventory, or
  game library. Only the latest stat snapshot is kept; no history.
- **No console support.** There is no public stats API for console platforms, so this plugin never claims to
  support them; command replies and the plugin README say so plainly instead of guessing.
- Disabled by default; unavailable (`/plugin status`) until the operator configures a Steam Web API key.

## DATABASE DESIGN

Prisma models for at least: Guild, GuildConfig, PluginState, UserProfile, ModerationCase, ModerationWarning, ModerationNote, AutomodRule, AutomodEvent, AuditLog, Ticket, TicketParticipant, TicketTranscript, RolePanel, RolePanelOption, ScheduledJob, Reminder, Giveaway, Poll, PollVote, Suggestion, LevelProfile, ReputationEvent, IntegrationConnection, OAuthToken, WebhookEndpoint, DataRetentionPolicy.

Include: indexes for frequent guild and user lookups; foreign keys and cascading behavior reviewed carefully; soft delete where appropriate; tenant isolation by guild ID; data-retention jobs; migration and seed scripts.

## SECURITY REQUIREMENTS

- Validate every command and API payload with Zod
- Permission checks on every sensitive command and dashboard endpoint
- Encrypt OAuth tokens and integration credentials at rest using an application-managed encryption key
- Store Discord bot token only in environment variables or managed secret storage
- API rate limits, command cooldowns, and per-guild quotas
- Verify Discord interaction signatures if using HTTP interactions
- Verify all external webhook signatures
- Protect dashboard routes with secure sessions, CSRF protection where applicable, secure cookies, and authorization checks
- Security headers and CORS allowlists
- Prevent SSRF in webhook and URL features
- Sanitize embeds, markdown, filenames, and HTML transcripts
- Structured error responses without leaking secrets
- Idempotency keys for webhook and payment event processing
- Document incident response and secret rotation procedures

## DISCORD PERMISSIONS AND INTENTS

Permissions matrix in the README listing each feature, required Discord permission, why it is required, whether it is optional, and fallback behavior if missing. Use privileged intents only when necessary. Message-content-dependent features are optional and clearly documented as requiring the Message Content intent and approval/eligibility from Discord.

## COMMAND DESIGN

- Command groups such as `/mod`, `/config`, `/ticket`, `/automod`, `/roles`, `/level`, `/giveaway`, `/integration`, and `/utility`
- Autocomplete for users, roles, channels, case IDs, and configuration values where appropriate
- Ephemeral responses for configuration, sensitive moderation details, errors, and confirmation interfaces
- Public responses only for appropriate community features
- Localized error messages through an i18n-ready translation layer

## DELIVERABLES

1. Full monorepo folder structure
2. All source files needed for a working MVP
3. Prisma schema and initial migrations
4. `.env.example` with documented variables
5. `docker-compose.yml` for PostgreSQL, Redis, bot, API, and dashboard
6. Dockerfiles for each deployable app
7. GitHub Actions CI
8. README with: prerequisites; Discord Developer Portal setup; OAuth redirect configuration; required bot invite scopes `bot` and `applications.commands`; recommended least-privilege permissions; enabling privileged intents only if needed; local setup; production deployment guidance; plugin configuration guide; data/privacy policy template; troubleshooting
9. Unit tests for permission checks, automod rules, moderation hierarchy, and encryption utilities
10. End-to-end test scaffolding for OAuth dashboard login and a configuration workflow
11. Example seed data
12. API documentation using OpenAPI for dashboard/backend endpoints
13. A clear roadmap separating MVP, v1, and future modules

## IMPLEMENTATION ORDER

- Phase 1: Monorepo, database, Redis, bot startup, slash command registration, dashboard login, guild config, plugin system, logging, permission utilities, audit trail.
- Phase 2: Moderation, cases, warnings, mod logs, automod dry-run, ticketing, role panels, welcome messages.
- Phase 3: Leveling, polls, giveaways, suggestions, scheduling, reminders, analytics, integration framework.
- Phase 4: OAuth integrations, AI assistant, compliant media adapter, advanced dashboard configuration, retention exports/deletion.
