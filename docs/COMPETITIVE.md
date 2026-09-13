# Pavisie — Competitive position (2026-08)

Honest comparison of Pavisie against the seven Discord bots most servers pick from: MEE6, Dyno, Carl-bot, Wick,
ProBot, Sapphire, Arcane. Written from a research pass over the competitors' official docs/pricing pages plus
top.gg / third-party reviews (MEE6, Dyno, Carl-bot in depth; Wick partially; ProBot / Sapphire / Arcane from
general product knowledge — see the caveat in §1) and from reading Pavisie's actual code
(`packages/plugins/src/*/manifest.ts`, `docs/commands.json`, `apps/api/src/routes`, the dashboard pages) — not
from the marketing copy. Where Pavisie is missing something, it says so.

Companion to `ROADMAP.md`. Implementation specs for the top gaps live outside the repo (see §5).

---

## 1. Feature matrix

Legend: ✅ has it · ⚠️ partial / with caveats · ❌ missing · 💰 competitor gates it behind a paid tier
(per-server premium unless noted). "Pavisie" reflects code on `main` today, not plans.

Caveat: the MEE6 / Dyno / Carl-bot columns are from a full read of their docs and pricing tables. The Wick column
covers moderation/anti-raid (the part of the research payload that arrived intact). ProBot / Sapphire / Arcane are
from general knowledge and should be re-verified before quoting externally (marked †).

### Moderation

| Feature                                | Pavisie                                                       | MEE6      | Dyno   | Carl-bot | Wick   | ProBot† | Sapphire† | Arcane† |
| -------------------------------------- | -------------------------------------------------------------- | --------- | ------ | -------- | ------ | ------- | --------- | ------- |
| Core commands (warn/timeout/kick/ban…) | ✅ `/mod *` + context menus                                    | ✅ 💰     | ✅     | ✅       | ✅     | ✅      | ✅        | ✅      |
| Case numbers + mod-log channel         | ✅ per-guild `ModerationCase`, embeds, export CSV              | ⚠️        | ✅     | ✅       | ✅     | ⚠️      | ✅        | ⚠️      |
| Warn escalation ("3 warns → timeout")  | ✅ escalation rules                                            | ✅ 💰     | ✅     | ✅       | ✅ pts | ✅      | ✅        | ⚠️      |
| Confirmations before destructive acts  | ✅ default; `fastActions` opt-out                              | ❌        | ❌     | ❌       | ❌     | ❌      | ❌        | ❌      |
| Hierarchy checks (owner/bot/higher)    | ✅ `checkModerationTarget`, unit-tested                        | ✅        | ✅     | ✅       | ✅     | ✅      | ✅        | ✅      |
| Appeals workflow                       | ✅ in-Discord modal + staff review; DM includes how to appeal  | ❌        | ✅ web | ❌       | ✅ web | ❌      | ⚠️        | ❌      |
| Mod notes                              | ✅ `/mod note`                                                 | ❌        | ✅     | ✅       | ✅     | ❌      | ⚠️        | ❌      |
| Purge with filters                     | ⚠️ count / user / contains                                     | ✅ 💰     | ✅ 15+ | ✅       | ✅     | ✅      | ✅        | ⚠️      |
| Per-channel lock/unlock, slowmode      | ✅                                                             | ❌        | ✅     | ✅       | ✅     | ✅      | ✅        | ❌      |
| Server-wide manual lockdown            | ⚠️ automod auto-lockdown on raid only; no `/mod lockdown`      | ❌        | ✅     | ✅       | ✅     | ❌      | ⚠️        | ❌      |
| Hands-off "flag → review → act" ledger | ✅ **enforcer** (unique)                                       | ❌        | ❌     | ⚠️ Drama | ⚠️     | ❌      | ❌        | ❌      |
| Message reports by members             | ⚠️ staff context menu only; no member `/report`                | ❌        | ❌     | ✅       | ✅     | ❌      | ⚠️        | ❌      |
| Per-moderator stats                    | ⚠️ derivable from export; no `/modstats`                       | ❌        | ✅     | ✅       | ✅     | ❌      | ❌        | ❌      |

### Automod / anti-raid

| Feature                                        | Pavisie                                                | MEE6  | Dyno | Carl-bot | Wick    | ProBot† | Sapphire† | Arcane† |
| ---------------------------------------------- | ------------------------------------------------------- | ----- | ---- | -------- | ------- | ------- | --------- | ------- |
| Word/regex/link/invite/mention/caps/dupe rules | ✅ rule types, safe-regex validated                     | ✅ 💰 | ✅   | ✅       | ✅ heat | ✅      | ✅        | ⚠️      |
| Per-rule actions + exemptions                  | ✅                                                      | ✅ 💰 | ✅   | ✅       | ✅      | ⚠️      | ✅        | ⚠️      |
| **Dry-run by default**                         | ✅ (on by default)                                      | ❌    | ❌   | ❌       | ❌      | ❌      | ❌        | ❌      |
| False-positive review queue                    | ✅ `/automod review` + dashboard tab                    | ❌    | ❌   | ✅ 💰    | ⚠️      | ❌      | ❌        | ❌      |
| Account-age gate                               | ✅                                                      | ❌    | ✅   | ❌       | ✅      | ⚠️      | ✅        | ❌      |
| Raid detection (join bursts) + auto response   | ✅ raise verification / quarantine new joins            | ❌    | ⚠️   | ❌       | ✅      | ⚠️      | ✅        | ❌      |
| Anti-nuke (watch admin actions, revert)        | ❌                                                      | ❌    | ❌   | ❌       | ✅      | ⚠️      | ⚠️        | ❌      |
| Quarantine role                                | ✅                                                      | ❌    | ❌   | ❌       | ✅      | ❌      | ⚠️        | ❌      |
| Honeypot channel                               | ❌                                                      | ❌    | ❌   | ✅       | ⚠️      | ❌      | ❌        | ❌      |
| Per-rule log channel / custom response         | ⚠️ single log kind                                      | ❌    | 💰   | ⚠️       | ✅      | ❌      | ⚠️        | ❌      |

### Logging

| Feature                                | Pavisie                                                | MEE6     | Dyno   | Carl-bot | Wick | ProBot† | Sapphire† | Arcane† |
| -------------------------------------- | ------------------------------------------------------- | -------- | ------ | -------- | ---- | ------- | --------- | ------- |
| Per-kind log channels                  | ✅ 16 kinds, per-kind routing                           | ⚠️ 1 ch  | ✅     | ✅       | ⚠️   | ✅      | ✅        | ⚠️      |
| Message content capture                | ⚠️ **off by default**, opt-in + redaction rules         | ✅ 💰    | ✅     | ✅       | ⚠️   | ✅      | ✅        | ⚠️      |
| Retention controls                     | ✅ configurable                                         | ❌       | ❌     | ❌       | ❌   | ❌      | ❌        | ❌      |
| Searchable dashboard log + CSV export  | ✅                                                      | ❌       | ✅     | ⚠️ 100   | ❌   | ❌      | ⚠️        | ❌      |
| Invite-use attribution on join         | ✅ logged per join                                      | ✅ 💰    | ❌     | ✅       | ❌   | ✅      | ✅        | ❌      |
| Invite leaderboard / `/invites`        | ❌                                                      | ✅ 💰    | ❌     | ❌       | ❌   | ✅      | ✅        | ❌      |
| Bot error / webhook-failure logs       | ✅                                                      | ❌       | ❌     | ❌       | ❌   | ❌      | ❌        | ❌      |

### Tickets / support

| Feature                          | Pavisie                                                | MEE6  | Dyno   | Carl-bot | Wick | ProBot† | Sapphire† | Arcane† |
| -------------------------------- | ------------------------------------------------------- | ----- | ------ | -------- | ---- | ------- | --------- | ------- |
| Button ticket panels             | ✅ channel or private-thread mode                       | ✅ 💰 | ✅ 1   | ❌       | ❌   | ⚠️      | ✅        | ❌      |
| Intake form (modal)              | ✅                                                      | ❌    | ✅     | ❌       | ❌   | ❌      | ✅        | ❌      |
| Transcripts (HTML/JSON)          | ✅ + retention                                          | ✅ 💰 | ✅     | ❌       | ❌   | ⚠️      | ✅        | ❌      |
| SLA / assignment / tags / reopen | ✅                                                      | ❌    | ⚠️     | ❌       | ❌   | ❌      | ⚠️        | ❌      |
| Web forms builder                | ❌                                                      | ❌    | ✅     | ❌       | ⚠️   | ❌      | ⚠️        | ❌      |

### Roles / onboarding / verification

| Feature                                | Pavisie                                                | MEE6  | Dyno   | Carl-bot | Wick | ProBot† | Sapphire† | Arcane† |
| -------------------------------------- | ------------------------------------------------------- | ----- | ------ | -------- | ---- | ------- | --------- | ------- |
| Button / select / **reaction** panels  | ✅ all three styles (`RolePanelStyle`)                  | ✅ 💰 | ✅ 3   | ✅ react | ❌   | ✅      | ✅        | ❌      |
| Role groups w/ max-selection           | ✅                                                      | ❌    | ⚠️     | ✅ modes | ❌   | ⚠️      | ✅        | ❌      |
| Elevated-role safety guard             | ✅ refuses roles with dangerous perms by default         | ❌    | ❌     | ❌       | ⚠️   | ❌      | ❌        | ❌      |
| **Auto-role on join** (no verify)      | ❌ (only `verifiedRoleId` after verification)           | ✅ 💰 | ✅ 3   | ✅       | ⚠️   | ✅      | ✅        | ❌      |
| Welcome / goodbye (text/embed/DM)      | ✅ + live preview in dashboard                          | ✅ 💰 | ✅     | ✅       | ❌   | ✅      | ✅        | ⚠️      |
| Welcome image cards                    | ❌                                                      | ✅ 💰 | ✅ 💰  | ❌       | ❌   | ✅      | ⚠️        | ❌      |
| Verification (button/modal/captcha)    | ✅ + staff queue + account-age                          | ❌    | ⚠️     | ⚠️       | ✅   | ❌      | ✅        | ❌      |
| Onboarding checklist / rules-agree     | ✅                                                      | ❌    | ❌     | ❌       | ❌   | ❌      | ⚠️        | ❌      |
| Role persistence on rejoin             | ✅ (disclosed, opt-in, elevated roles excluded)         | ❌    | ✅     | ✅       | ❌   | ❌      | ✅        | ❌      |
| Timed / temp roles                     | ❌                                                      | ❌    | ✅     | ✅ 💰    | ⚠️   | ❌      | ⚠️        | ❌      |
| Voice-role links                       | ❌                                                      | ❌    | 💰     | 💰       | ❌   | ❌      | ⚠️        | ❌      |

### Leveling / engagement

| Feature                        | Pavisie                                     | MEE6    | Dyno  | Carl-bot | Wick | ProBot† | Sapphire† | Arcane† |
| ------------------------------ | -------------------------------------------- | ------- | ----- | -------- | ---- | ------- | --------- | ------- |
| XP / levels / leaderboard      | ✅ free, anti-farm cooldowns                 | ✅ 💰   | 💰    | 💰       | ❌   | ✅      | ✅        | ✅      |
| Level role rewards             | ✅ stack or replace, `/level rewards sync`   | ✅ 💰   | 💰    | 💰       | ❌   | ✅      | ✅        | ✅ 💰   |
| Rank card customization        | ❌ (embed only)                              | ✅ 💰   | 💰    | 💰       | ❌   | ✅      | ⚠️        | ✅ 💰   |
| Public web leaderboard         | ❌                                           | ✅      | ✅    | ❌       | ❌   | ✅      | ⚠️        | ✅      |
| Reputation                     | ✅                                           | ❌      | ❌    | ❌       | ❌   | ⚠️      | ❌        | ❌      |
| Starboard                      | ✅                                           | ✅      | ✅    | ✅       | ❌   | ❌      | ✅        | ❌      |
| Temp voice channels            | ✅                                           | ✅ 💰   | ⚠️    | ❌       | ❌   | ✅      | ⚠️        | ❌      |
| Economy (virtual only)         | ✅ daily/give/leaderboard, no shop/minigames | ✅ shop | ✅ ads| ❌       | ❌   | ✅      | ⚠️        | ❌      |
| Achievements                   | ❌                                           | ✅      | ❌    | ❌       | ❌   | ❌      | ❌        | ❌      |
| Highlights (keyword DM)        | ❌ (needs content intent; not planned)       | ❌      | ⚠️    | ✅       | ❌   | ❌      | ❌        | ❌      |

### Community

| Feature                         | Pavisie                                   | MEE6  | Dyno   | Carl-bot | Wick | ProBot† | Sapphire† | Arcane† |
| ------------------------------- | ------------------------------------------ | ----- | ------ | -------- | ---- | ------- | --------- | ------- |
| Polls (anon option)             | ✅                                         | ✅ 💰 | ✅     | ✅       | ❌   | ✅      | ✅        | ❌      |
| Giveaways (eligibility, reroll) | ✅                                         | ✅ 💰 | ✅ web | ✅       | ❌   | ✅      | ✅        | ❌      |
| Suggestions w/ staff workflow   | ✅ + threads + DM on decision              | ❌    | ❌     | ✅       | ❌   | ❌      | ✅        | ❌      |
| Scheduled / recurring announce  | ✅ cron + timezone                         | ✅ 1  | ✅ 1   | ✅       | ❌   | ⚠️      | ✅        | ❌      |
| Reminders (list/cancel)         | ✅                                         | ❌    | ⚠️     | ✅       | ❌   | ❌      | ⚠️        | ❌      |
| Events + RSVP + reminders       | ✅ native Discord event optional           | ❌    | ❌     | ❌       | ❌   | ❌      | ⚠️        | ❌      |
| **Birthdays**                   | ❌                                         | ✅ 💰 | ❌     | ✅       | ❌   | ⚠️      | ✅        | ❌      |
| **Sticky messages**             | ❌                                         | ❌    | ❌     | ✅ 💰    | ❌   | ❌      | ✅        | ❌      |
| **Auto-publish announcements**  | ❌                                         | ❌    | ❌     | ❌       | ❌   | ❌      | ✅        | ❌      |
| Auto-threads per channel        | ❌ (suggestions only)                      | ❌    | ❌     | ❌       | ❌   | ❌      | ⚠️        | ❌      |
| Server discovery / bump         | ❌ (not planned)                           | ❌    | ✅     | ✅ 💰    | ❌   | ❌      | ❌        | ❌      |

### Utility

| Feature                                  | Pavisie                                     | MEE6   | Dyno   | Carl-bot   | Wick | ProBot† | Sapphire† | Arcane† |
| ---------------------------------------- | -------------------------------------------- | ------ | ------ | ---------- | ---- | ------- | --------- | ------- |
| **Custom commands / tags**               | ❌                                           | ✅ 💰  | ✅ 25  | ✅ TagScript| ❌   | ⚠️      | ✅        | ❌      |
| **Auto-responders (trigger → reply)**    | ❌                                           | ⚠️     | ✅ 10  | ✅ 50      | ❌   | ⚠️      | ✅        | ❌      |
| Embed builder (dashboard + slash)        | ✅ live preview, JSON in/out                 | ✅ 💰  | ✅ 3   | ✅ clunky  | ❌   | ✅      | ✅        | ❌      |
| **Server-stats counter channels**        | ❌                                           | ✅ 💰  | ❌     | ❌         | ❌   | ✅      | ✅        | ❌      |
| Info commands (user/server/role/channel) | ✅                                           | ⚠️     | ✅     | ✅         | ⚠️   | ✅      | ✅        | ⚠️      |
| Timestamps / timezone                    | ✅                                           | ❌     | ❌     | ❌         | ❌   | ❌      | ⚠️        | ❌      |
| AFK                                      | ✅ plain (no "leave a message" buttons)     | ❌     | ✅+    | ⚠️ tag     | ❌   | ❌      | ⚠️        | ❌      |
| Translate / weather (approved adapters)  | ✅ opt-in providers                          | ❌     | ❌     | ❌         | ❌   | ⚠️      | ⚠️        | ❌      |
| `/help` generated from registry          | ✅ can't drift                               | ⚠️     | ⚠️     | ⚠️         | ⚠️   | ⚠️      | ⚠️        | ⚠️      |
| Diagnose command                         | ⚠️ `/plugin status` + `/permissions audit`   | ❌     | ✅     | ✅         | ⚠️   | ❌      | ❌        | ❌      |

### Integrations / AI / media

| Feature                                | Pavisie                                                  | MEE6         | Dyno  | Carl-bot | Wick | ProBot† | Sapphire† | Arcane† |
| -------------------------------------- | --------------------------------------------------------- | ------------ | ----- | -------- | ---- | ------- | --------- | ------- |
| Twitch / YouTube alerts                | ✅ official APIs (EventSub / Data API)                    | ✅ 💰 10 nets| 💰    | ✅ 2/5   | ❌   | ⚠️      | ✅        | ❌      |
| GitHub / generic webhooks (in+out)     | ✅ signed, SSRF-guarded                                   | ❌           | ❌    | ❌       | ❌   | ❌      | ⚠️        | ❌      |
| Reddit / Steam / calendars / Notion    | ⚠️ connector framework; providers vary                    | ✅ 💰        | ✅    | ❌       | ❌   | ❌      | ⚠️        | ❌      |
| Stripe role rewards                    | ⚠️ webhook plumbing; donations only shipped               | ✅ takes cut | ❌    | ❌       | ❌   | ❌      | ❌        | ❌      |
| Music                                  | ❌ by policy (adapter only, no scraping)                  | ❌ removed   | ❌    | ❌       | ❌   | ✅      | ❌        | ❌      |
| AI (ask/summarize/draft/mod-assist)    | ✅ opt-in, BYO key, assistive only, redaction             | ✅ 💰 sep.   | ❌    | ❌       | ❌   | ❌      | ⚠️        | ❌      |
| White-label / custom bot               | ❌ (not planned)                                          | 💰           | 💰    | 💰       | 💰   | 💰      | 💰        | ❌      |

### Dashboard / trust / pricing

| Feature                                   | Pavisie                                                        | MEE6            | Dyno         | Carl-bot     | Wick        | ProBot†   | Sapphire† | Arcane†  |
| ----------------------------------------- | --------------------------------------------------------------- | --------------- | ------------ | ------------ | ----------- | --------- | --------- | -------- |
| Web dashboard, per-plugin toggles         | ✅                                                              | ✅              | ✅           | ✅           | ✅          | ✅        | ✅        | ✅       |
| Auto-generated config forms from schema   | ✅ every plugin gets a form for free                            | ❌              | ❌           | ❌           | ❌          | ❌        | ❌        | ❌       |
| **Admin audit trail of config changes**   | ✅ every write, actor + source (bot/dashboard), CSV             | ❌              | ✅ 3 months  | ⚠️ weblogs   | ⚠️          | ❌        | ⚠️        | ❌       |
| Least-privilege invite (no Administrator) | ✅ documented per feature + `/permissions audit`                | ⚠️              | ❌ recommends Admin | ⚠️     | ⚠️          | ⚠️        | ⚠️        | ⚠️       |
| Privacy: retention, export, delete        | ✅ per guild                                                    | ❌              | ❌           | ❌           | ❌          | ❌        | ❌        | ❌       |
| Public commands docs from registry        | ✅ `docs/commands.json` → website                               | ⚠️              | ✅           | ✅           | ⚠️          | ⚠️        | ⚠️        | ⚠️       |
| Price                                     | Free; donations only, no perks                                  | ~$12/mo/server  | $6–13/mo     | $8+/mo       | premium     | premium   | premium   | premium  |
| Paywall trend                             | none                                                            | expanding       | broad        | creeping     | moderate    | moderate  | moderate  | moderate |
| Track record / install base               | ❌ new; single operator; no scale history                       | 20M+ servers    | 11.5M        | 14.9M        | ~1M         | large     | large     | large    |

---

## 2. Where Pavisie already wins

These are real, in the code, and none of the seven competitors does all of them. They are the product's moat and
every new feature should reinforce them rather than dilute them.

1. **Transparency ledger (enforcer).** Every flag and every decision — from Discord or the dashboard — is a
   permanent `EnforcerRecord` plus a read-only ledger channel post, searchable (`/enforcer search|record|history`),
   exportable (CSV), and appealable. Carl-bot's "Drama Watcher" and Wick's cases come closest; neither gives the
   community a read-only, optionally server-visible record of what moderation did and why.
2. **Hands-off moderation.** Moderators decide from a queue with exact chat context; the bot performs the action and
   is the only party that talks to the user (DM with case + record number + how to appeal). Nobody else structures
   moderation this way.
3. **Compliance as a feature.** No music scraping (adapter-only media plugin that stays unavailable without a
   compliant provider), no gambling/real-money economy, no NFT/Web3, no wagering, no self-bot tricks, AI is opt-in,
   BYO-key, redacts before sending, and is labelled assistive-only. Free forever; donations grant no perks. MEE6's
   history (NFT promo, music removal, expanding paywall) is the cautionary tale — Pavisie has structurally opted out.
4. **Dashboard audit trail.** Every config write from either surface (`/config set` or the dashboard) is an
   `AuditLog` row with actor, before/after, and source; visible on `/dashboard/[guildId]/audit` and exportable.
   Only Dyno approaches this (3-month web audit log).
5. **Least privilege, documented and checkable.** `INVITE_PERMISSIONS` never includes Administrator; every
   plugin manifest lists each permission with the feature it serves and the fallback when missing;
   `/permissions audit` diffs against reality. Dyno's docs recommend Administrator.
6. **Privacy defaults.** Message content capture is off by default in logging, redaction rules exist, retention is
   configurable, and per-guild export/delete are first-class. Automod ships in dry-run. No competitor exposes
   retention or deletion controls to admins.
7. **Confirmations by default** on destructive actions with an explicit `fastActions` opt-out.
8. **Docs that cannot drift**: `/help`, the website's command tables, and `docs/commands.json` are generated from
   the plugin registry; CI fails if they are stale.
9. **Zero-cost auto forms**: any plugin's `configSchema` becomes a dashboard form via JSON Schema — new features
   get a settings UI without hand-building one.

Weaknesses to say out loud: no install base or uptime history; single operator; feature breadth in the
"quality of life" bucket (custom commands, sticky, auto-role, birthdays, stats channels, welcome images) is behind
every competitor; no public web surfaces (leaderboard, appeals page, forms); no white-label (deliberately).

---

## 3. Gap list, ranked

Score = demand (1–3, from how many competitors ship it and how often reviews mention it) × fit with Pavisie's
compliance-first/transparent positioning (1–3) × effort factor (S=3, M=2, L=1). Verified against code: none of
the ❌ items exist on `main` today.

| #   | Gap                                                          | Demand | Fit | Effort | Score | Notes / status                                                                                     |
| --- | ------------------------------------------------------------ | ------ | --- | ------ | ----- | -------------------------------------------------------------------------------------------------- |
| 1   | Auto-role on join (independent of verification)              | 3      | 3   | S      | 27    | Only `verification.verifiedRoleId` exists. **Spec CG-01**                                          |
| 2   | Custom commands / tags + auto-responders                     | 3      | 3   | M      | 18    | Nothing exists. MEE6 gates it, Dyno caps at 25, Carl-bot has TagScript. **Spec CG-02**             |
| 3   | Sticky messages                                              | 2      | 3   | S      | 18    | Carl-bot premium; Dyno lacks it. **Spec CG-03**                                                    |
| 4   | Auto-publish for announcement channels (+ auto-threads)      | 2      | 3   | S      | 18    | Neither MEE6/Dyno/Carl offer auto-publish; cheap win. **Spec CG-04**                               |
| 5   | Server-stats counter channels                                | 2      | 3   | S      | 18    | MEE6 premium. Rate-limit-aware (2 renames / 10 min / channel). **Spec CG-05**                      |
| 6   | Birthdays                                                    | 2      | 2   | M      | 8     | MEE6 premium, Carl-bot free. Store month/day only. **Spec CG-06**                                  |
| 7   | Manual server-wide lockdown (`/mod lockdown`)                | 2      | 3   | M      | 12    | ⚠️ automod already auto-locks on raid; manual, ledgered lockdown is next-up.                        |
| 8   | Per-moderator stats (`/mod stats`) + modlog highscores       | 1      | 3   | S      | 9     | Data exists in `ModerationCase`; a query + embed. Next-up.                                         |
| 9   | Auto-threads (per channel)                                   | 1      | 3   | S      | 9     | Folded into CG-04.                                                                                 |
| 10  | Log settings bootstrap (`/logs setup-all` creating channels) | 1      | 3   | S      | 9     | Carl-bot `log aio`. Next-up.                                                                       |
| 11  | Invite leaderboard / `/invites`                              | 2      | 2   | M      | 8     | Attribution already logged; would add an `InviteJoin` table + command. Disclose in privacy notes.  |
| 12  | Member `/report message` (non-staff)                         | 2      | 3   | S      | 9     | Fits enforcer: `/report` creates a MANUAL flag with `flaggedBy` = reporter. Next-up.               |
| 13  | Purge filters (links/images/bots/embeds)                     | 2      | 2   | S      | 12    | `/mod purge` has count/user/contains; add links/images/bots/embeds. Keep confirmation. Next-up.    |
| 14  | Welcome image cards                                          | 3      | 2   | L      | 6     | Needs an image renderer dependency (`@napi-rs/canvas`) + font shipping; deferred.                  |
| 15  | Web appeal page                                              | 2      | 3   | L      | 6     | Pavisie has in-Discord appeals; a public form needs auth-less signed links. Deferred.             |
| 16  | Forms builder (Dyno)                                         | 2      | 3   | L      | 6     | Ticket intake forms exist; general forms are a new plugin. Deferred.                               |
| 17  | Timed / temp roles + voice-role links                        | 1      | 2   | M      | 4     |                                                                                                    |
| 18  | Public web leaderboard                                       | 2      | 2   | L      | 4     | Requires a public read API + privacy toggle. Deferred.                                             |
| 19  | Rank card customization                                      | 2      | 1   | M      | 4     | Cosmetic; competitors monetize it. Low fit.                                                        |
| 20  | Achievements                                                 | 1      | 2   | M      | 4     |                                                                                                    |
| 21  | Automations rule builder (MEE6)                              | 2      | 2   | L      | 4     | Partly covered by automod actions + enforcer policies.                                             |
| 22  | Highlights (keyword DM)                                      | 1      | 2   | M      | 4     | Content-intent dependent; low priority.                                                            |
| 23  | Anti-nuke (Wick)                                             | 2      | 2   | L      | 4     | Would need audit-log polling + permission reverts; big and risky. Deferred.                        |
| —   | Music, gambling/shop economy, NFT gating, white-label bot    | —      | 0   | —      | 0     | Excluded by policy (SPEC.md rules 1–2, §I).                                                        |

---

## 4. "Do it better" notes for the top gaps

- **Auto-role (CG-01).** Competitors just add the role. Pavisie: refuse roles that carry elevated permissions
  (reuse `checkRoleAssignable`), never assign while membership screening is pending, optional delay via a job so a
  role can gate a first-hour "newcomer" period, a separate list for bots, and an audit row per assignment. The
  dashboard shows the exact reason a role was refused instead of failing silently.
- **Tags / auto-responders (CG-02).** MEE6 gives 3–5 free; Dyno 25; Carl-bot's TagScript is powerful but a
  learning curve. Pavisie: unlimited plain-text/embed tags with the same safe `{user}`/`{server}` variables the
  welcome engine already uses (no code execution, no recursion), staff-restrictable per tag, every create/edit is an
  audit row, `/tag list` is public so members can see what commands exist. Auto-responders are opt-in per tag and
  only run when the Message Content intent is on; the plugin says so in `/plugin status`.
- **Sticky (CG-03).** Carl-bot paywalls it. Pavisie: free, one per channel, cooldown so it never floods, and the
  sticky is stored as a normal message payload (text or embed JSON) — no message-content reading required.
- **Auto-publish + auto-threads (CG-04).** Nobody in the top three offers auto-publish. Pavisie: per-channel
  allowlists in the plugin config (auto-form for free), skips messages the bot can't publish and logs why once,
  never touches non-announcement channels.
- **Stats channels (CG-05).** MEE6 charges for it. Pavisie: rate-limit-aware refresh (Discord allows two channel
  renames per 10 minutes) with a `/statschannel refresh` that explains the wait, templates limited to counts the
  bot already has (members, humans, bots, online is *not* offered — it needs the Presence intent), and a clear
  "channel must be a voice/category channel members can see but not join" hint.
- **Birthdays (CG-06).** Store month + day only (no year, no age), member opt-in and self-removable, no DM without
  consent, announcement at a guild-local hour, optional 24h birthday role, and included in guild data export/delete
  by cascade. Say all of this in `privacyNotes` and the privacy template.

---

## 5. Specs

Implementation specs (self-contained, for a Sonnet engineer) for CG-01…CG-06 plus the polish item CG-07
(channel-picker kind filtering, Fastify `FST_ERR_*` status preservation, `/setup status` wording) are written to
the orchestrator's scratchpad, not the repo. When a spec ships, add the feature to `PLUGINS.md`, the plugin
README, regenerate `docs/commands.json` (`pnpm commands:export`), and flip the row in §1 from ❌ to ✅.
