# Design notes: the next round of features

Written against `main` at `81eb5ff`. Each note is a short proposal grounded in the code as it stands today. Nothing here is built. Sizes: S = days, M = one to two weeks, L = several weeks or touches several services. Where I am not sure of something (mostly Discord's and Twitch's APIs), the note says so rather than guessing.

Dependencies between items: 2 and 3 both need a verified Discord-to-Twitch identity link, so build that once. 1 and 4 interact because the Twitch chat manager only lives in the gateway process. 5 is a prerequisite for any "analytics" premium offer in 6.

---

## 1. Post-stream recap to Discord

**Goal.** When a linked streamer's stream ends, post one embed in a chosen Discord channel: duration, peak viewers, top chatters, channel-point redemptions, clips, and an optional AI-written summary.

**How it fits.** Nothing records a stream session today. Go-live alerts are a `stream.online` EventSub webhook (`packages/plugins/src/integrations/providers/twitch.ts`, received in `apps/api/src/routes/webhooks.ts`) that only posts an alert. There is no `stream.offline` handling, and the subscription code (`ensureTwitchEventSub`, `cleanupOrphanedTwitchEventSubs`) is hard-wired to the `stream.online` type, so adding offline there means generalising it. The simpler route is the one-minute `twitch-chat-tick` job (`integrations/jobs/twitch-chat-tick.ts`): extend it to call Helix `GET /streams` once for all linked channels (Helix accepts many ids per call), open and close a session, and sample `viewer_count`. `getStream` in `twitch-chat/helix.ts` currently reads only `started_at`. Chatter and redemption counts come from `handleChatMessageNotification` and `handleRewardRedemptionNotification` in `twitch-chat/manager.ts`: count into a Redis hash per session, never store message text or reward input. Clips come from Helix `GET /clips` over the session window. Post with `postAlert`. The AI summary calls `ctx.services.get('ai').complete(...)` (`ai/service.ts`) with aggregate stats only; the service does not check that the `ai` plugin is enabled, so the recap must (`ctx.isEnabled(guildId, 'ai')`). It spends the server's own key and budget.

**Data.** New `TwitchStreamSession` (channel id, Twitch stream id, start/end, peak viewers, top chatters and redemption counts snapshotted at the end, `recapPostedAt`). New `TwitchChatChannel` columns: `recapEnabled`, `recapDiscordChannelId`, `recapAi`.

**Risks and open questions.**
- Only guild-linked channels can post (`TwitchChatChannel.guildId`), the same rule as the bridge and DISCORD rewards. Tie consent to that streamer-verified link (`discordLinkedBy`), not to alert connections, which any server admin can create for any streamer.
- Redemption counts exist only when `rewardsEnabled` and a broadcaster token are present; chat counts only while the bot is connected. Label partial data.
- Per-user chat counts are new data collection: update the privacy text and delete the Redis hash after posting.
- Short stream drops should merge into one session.

**Size.** M.

---

## 2. One shared points wallet and leaderboard across Discord and Twitch

**Goal.** A person who is both a Discord member and a Twitch viewer of a linked channel has one balance, usable from `/economy` and from `!balance` and `!daily` in chat, and appears once on the leaderboard.

**How it fits.** Today there are two currencies that are deliberately never merged (`docs/ARCHITECTURE.md` section 18b). The guild wallet is `EconomyAccount` keyed `(guildId, platform, userId)`, written only by `economy/ledger.ts`. The Twitch currency is channel-owned (`ChannelEconomy`, `ChannelWallet`, `ChannelTransaction`), keyed by broadcaster and viewer Twitch id, written only by `channel-economy/ledger.ts`. A channel reaches a server through `TwitchChatChannel.guildId`, set from the creator dashboard (`linkChannelToGuild` in `apps/api/src/lib/creator/discord-link.ts`). `/economy leaderboard global` ranks Discord rows and linked-channel Twitch rows side by side (`economy/commands/economy.ts`, `handleLeaderboard`). No viewer-level link between a Discord user and a Twitch user exists anywhere; the Discord login asks only for `identify guilds` (`apps/api/src/lib/discord.ts:10`) and the creator Twitch login discards its token.

**Proposal.** Add a verified `LinkedIdentity` (also needed by item 3), then an opt-in `ChannelEconomy.sharedGuildId`. In shared mode the guild `EconomyAccount` is the single source of truth for linked viewers: the Twitch chat port (`integrations/twitch-chat/economy-port.ts`) calls the guild ledger instead of the channel ledger, and the guild's currency settings win. Unlinked viewers keep their `ChannelWallet`. Linking moves any existing channel balance into the guild account with ledger rows (`link_merge`) and zeroes the old wallet.

**Data.** `LinkedIdentity`; `ChannelEconomy.sharedGuildId`; `ChannelWallet.mergedIntoAccountId`. Add a `source` to `EconomyTransaction` so rows say where they came from. Leave the legacy `platform = TWITCH` rows alone.

**Risks and open questions.** Needs the streamer and a server admin both to agree. The Redis earn caps are keyed by `economyId` (`economy-earn.ts`) and would need a shared key or one platform could double the daily cap. The extension panel (`apps/api/src/lib/twitch-ext/wallet-summary.ts`) only sees a real Twitch id when the viewer shares identity. The `economy` plugin may be disabled in the guild, so shared mode must fall back cleanly. Merges are one-way in practice. Unique one-to-one links are needed to stop alt-farming.

**Size.** L.

---

## 3. Cross-platform moderation ("ban everywhere")

**Goal.** A ban or timeout on Discord also bans or times out the linked Twitch account in the linked channel, and the reverse, including unbans.

**How it fits.** Every Pavisie ban goes through `ModerationServiceImpl.ban/unban/timeout` (`moderation/service.ts`), which funnel into `createCase` and emit `moderation.caseCreated`: one hook covers `/mod`, automod, enforcer and the dashboard. Bans made directly in Discord's UI produce no case today (no `guildBanAdd` handler exists), so catching those needs a new handler and the non-privileged moderation intent. The Twitch side has no moderation code at all (`docs/ROADMAP.md:68`: none ship in v1). The pair to act on is `TwitchChatChannel.guildId` plus a `LinkedIdentity` (see 2) for the target.

**Twitch scopes (from memory; check the Helix reference).** Ban and timeout (`POST /moderation/bans`, timeout length capped at 14 days) and unban (`DELETE /moderation/bans`) need a user token with `moderator:manage:banned_users`, whose user is the broadcaster or a channel moderator. Our tokens do not have it: the bot identity has `user:read:chat user:write:chat user:bot` (`apps/api/src/routes/twitch-bot.ts:12`) and the streamer grants `channel:bot`, optionally plus `channel:read:redemptions` (`lib/creator/oauth.ts:52,58`). Cleanest: ask the streamer for the extra scope and store it on `TwitchBroadcasterToken`, which needs no manual `/mod`. The reverse direction uses EventSub `channel.ban` and `channel.unban`, with their own scope requirement.

**Data.** `LinkedIdentity`; per-channel opt-ins on `TwitchChatChannel` (`syncBansToTwitch`, `syncBansFromTwitch`); a sync marker on the case `metadata` to break echo loops.

**Risks and open questions.** Most troublemakers will not have linked accounts, so reach is small and the pitch must say so. Loop prevention is essential. Discord timeouts go to 28 days, Twitch to 14. Appeals and unban propagation need rules. Only mirror ban, unban and timeout, not warns or kicks. The link must be consented to and added to data export and delete (`apps/bot/src/host/data-requests.ts`). Probably default off, per server and per channel.

**Size.** L.

---

## 4. Background jobs in their own Railway service

**Goal.** Run BullMQ workers in a separate `worker` service so heavy jobs do not compete with the Discord gateway process.

**How it fits.** `startWorkers` (`apps/bot/src/workers.ts`) already takes `{ plugins, ctxFactory, connection }` and its header says it was built to be split. Today it is called from `apps/bot/src/index.ts:173`, using contexts built by `loadPlugins`. Repeat schedulers are upserted in `loader.ts:204`, which is idempotent, so two processes doing it is harmless. Producers (`ctx.queue(...).add`) can stay in the bot because the queue lives in Redis.

**What blocks a plain split.**
- Several jobs read the gateway cache: `birthday-announce.ts:157` and `stats-refresh.ts:159` iterate `ctx.client.guilds.cache`. A worker needs either a minimal gateway login (Guilds intent only, no event handlers) or those jobs rewritten to iterate `Guild` rows in Postgres.
- The Twitch chat manager is a module-level singleton (`integrations/index.ts:29`) holding the EventSub WebSocket, and `twitch-chat-tick` drives it. That job and the manager must stay in the gateway process, so `PluginJob` needs a `runIn: 'gateway' | 'worker'` flag. Two WebSocket sessions would double-handle chat.
- `onLoad` registers cross-plugin services that jobs use (`host`, `logging`, `roles`); the worker needs a variant that skips side effects such as `twitchChatManager.start`.
- The `bot-actions` and `data-requests` workers need gateway services and stay put.

**Changes.** A `ROLE=gateway|worker` entrypoint (or `apps/bot/src/worker.ts`), a `worker.railway.json` and start command, a health port or none, and the same env vars as `bot`. Postgres connections roughly double; check the pool size.

**Risks.** `plugin.error` and `moderation.*` platform events are in-process, so a job's events reach only that process's subscribers. A restarting worker leaves jobs in flight; the existing `Worker.close` handles shutdown.

**Size.** M.

---

## 5. Fixing the daily analytics job, which never runs

**Finding: there is no analytics job to run.** Nothing in the repository ever writes `GuildAnalyticsDaily`.

**Evidence.**
- The table is `packages/database/prisma/schema.prisma:1635`. Its only users: reads in `apps/api/src/routes/analytics.ts:37` and `apps/api/src/routes/owner-metrics.ts:322,334`, and a delete in `packages/database/src/retention.ts:104`. A search for `create`, `upsert`, `update` or raw SQL against it finds nothing.
- The only plugin `jobs:` arrays are admin, automod, community, engagement, gamestats, integrations, logging, moderation, roles and tickets, and none rolls up analytics. The nearest daily jobs purge: `retentionSweepJob` (`packages/plugins/src/admin/jobs/retention-sweep.ts:16`, `0 4 * * *`, registered at `admin/index.ts:23`) deletes old analytics rows, and `logging/jobs/retention.ts:12` purges log events.
- The scheduling machinery is fine: `loader.ts:204` upserts the schedulers and `index.ts:173` starts the workers, and other repeat jobs rely on both.
- The repo says so itself: `docs/ROADMAP.md:50-54` ("no collection job yet") and `:109-111` list it as unbuilt v1 work. No such job appears in the git history either.

**Second gate.** The API refuses to return data unless `GuildConfig.dataCollectionEnabled` is true (`analytics.ts:24`), default false (`schema.prisma:361`, `sdk/config-store.ts:53`). Even a working job should skip guilds that have not opted in.

**Proposed fix.**
- New `analytics-rollup` job in the always-loaded `admin` plugin, next to the retention sweep. Hourly, for each `botPresent` guild with `dataCollectionEnabled`, it upserts today's row (and finalises yesterday's). `moderationActions`, `automodTriggers` and `ticketsOpened` are counted from `ModerationCase`, `AutomodEvent` and `Ticket` by `createdAt`; `memberCount` comes from `client.guilds.cache`.
- `joins`, `leaves` and `messages` have no durable source. Add small event handlers that `HINCRBY` a per-guild, per-UTC-day Redis hash (only when collection is on) and have the job flush it. `joins` and `leaves` need the privileged GuildMembers intent; without it, leave them null rather than recording a false zero.
- Add a test with a fake Prisma, as the retention sweep has.

**Size.** M (S if the three event-derived columns are deferred). Fixing it also lights up the owner fleet-usage page.

---

## 6. Premium per server through Discord App Subscriptions

**Goal.** An optional per-server subscription (about $4-5 a month) sold through Discord, with core moderation always free.

**Discord's model, as I understand it. Verify all of this against current Discord docs before building.** SKUs are created in the Developer Portal. A recurring subscription SKU can be scoped to a server rather than a user. A purchase produces an entitlement with `sku_id`, `guild_id`, `starts_at` and `ends_at`. The gateway sends `ENTITLEMENT_CREATE`, `ENTITLEMENT_UPDATE` (renewals, new `ends_at`) and `ENTITLEMENT_DELETE`. I believe delete is only for refunds or removals, not for expiry or cancellation, so access must be decided from `ends_at`. Interaction payloads carry the entitlements for their context, and a REST list endpoint exists for reconciliation. The repo locks discord.js 14.27.0 (`pnpm-lock.yaml:2284`); I believe it exposes all of this but have not checked its typings. **Not sure of:** whether $4-5 is an available price point, Discord's revenue share, eligibility rules (team ownership, country, payouts), and the current way to prompt a purchase (a premium-style button versus the older premium-required response).

**Where gating lives.**
- Commands, components and autocomplete share `pluginGateFailure` (`apps/bot/src/host/router.ts:207`). Events are gated separately at `loader.ts:169-172`. Jobs have no per-guild gate, so each premium job must check.
- The API builds its registry from manifests only (`apps/api/src/lib/config-store.ts`), so add `tier: 'free' | 'premium'` to `PluginManifest` (`sdk/types.ts`) and have `GuildConfigStore.isEnabled` and the enable route (`apps/api/src/routes/plugins.ts:34`) respect it. Add a `hasPremium(guildId)` helper on the `host` service for per-feature checks.
- Proposed free: moderation, automod, logging, roles, tickets, enforcer, admin, utility. Proposed premium: features that cost the operator, such as item 1 recaps, item 5 analytics history, extra alert slots, longer retention, and the cross-platform sync of items 2 and 3. This is an owner decision.

**Data.** `GuildEntitlement` (Discord entitlement id, `guildId`, `skuId`, `startsAt`, `endsAt`, `deleted`), written by bot gateway handlers plus an hourly REST reconcile, read by the API. Cache the derived premium state in Redis like plugin enablement. With no SKU configured, everything is unlocked so self-hosters are not locked out.

**Risks.** This contradicts the stated positioning: `docs/COMPETITIVE.md:162,182` say "Free forever; donations grant no perks", and `docs/ROADMAP.md:135` says no decision was made that premium is wanted. That needs a product decision and doc updates first. Downgrades must switch features off, never delete data. Decide a grace period.

**Size.** L.
