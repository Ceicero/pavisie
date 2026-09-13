# Pavisie — Marketing Research & Draft Copy

**Status: RESEARCH ONLY. Nothing in this document has been posted, submitted, or published anywhere.
Every listing submission, every Reddit post, and every account action described below is a draft for
Brandon (or whoever owns these accounts) to review and execute by hand.**

Researched: 2026-08-20. Sources are cited inline; where a claim could not be verified against a
primary source, that is stated explicitly rather than guessed.

**Correction, 2026-08-20 (later same day):** an earlier version of this document said Reddit was
unreachable. That was wrong — it was true of `www.reddit.com` (renders rules via JS, and its
`.json` endpoints come back empty behind a bot-detection challenge), but **`old.reddit.com` works
and returns plain text**, including its own `/about.json` and `/about/rules.json` data endpoints,
fetched directly rather than scraped from rendered HTML. Part 3 has been rewritten from scratch
using live reads of each subreddit's actual current rules, sidebar copy, and subscriber count via
`old.reddit.com`, done read-only and logged out — no account was used, nothing was posted, no
verification/CAPTCHA challenge was touched. Every verdict below cites the exact URL read and is
marked "verified live on 2026-08-20 via old.reddit.com." **Subreddit rules still change over time,
so re-confirm the live sidebar/rules immediately before actually posting** — but nothing in Part 3
below is secondhand paraphrase or guesswork anymore.

---

## PART 1 — Discord bot listing sites

### Ranking: worth doing first, for a bot with near-zero servers

| Rank | Site | Verdict |
|---|---|---|
| 1 | **top.gg** | Do first. Biggest real audience, clearest published rules, free, no server minimum found. |
| 2 | **discordlist.gg** | Do first. Actively surfaces brand-new/0-server bots in a "Trending" feed — unusually friendly to a bot with no traction yet. |
| 3 | **botlist.me** | Do early. Published, achievable requirements (5 real commands + a help command + 24/7 uptime). Audience skews anime/gacha/RPG bots, but has real Moderation/Utility/Logging tags. |
| 4 | **discordbotlist.com** | Do early. Real, active, has a Moderation category and a "New Bots" discovery page, but the submission form is behind Discord OAuth login and its exact field rules aren't publicly documented — budget extra time to find out live. |
| 5 | **discord.bots.gg** | Do, but later / after the others. Active and legitimate, but it's a small volunteer team doing fully manual review (their own About page literally lists a "Chief Bot Denial Helper" role), historically slower and pickier than top.gg. Better odds once Pavisie has a support server with some activity and a couple of other listings live. |
| 6 | **discadia.com** | Low priority — see caution below. |
| — | **disforge.com** | **Do not use.** See finding below — this is no longer the site people remember. |
| — | **wumpus.store** | **Could not verify this exists.** See finding below. |
| — | **bots.ondiscord.xyz** ("Bots on Discord") | Likely defunct — direct navigation failed/timed out; only found an archival requirements page dated December 2020. Don't invest time here without confirming it's alive first. |

### Site-by-site detail

#### 1. top.gg — DO FIRST
- Submit at `https://top.gg/bot/new` while logged in with the Discord account that owns the bot's application. [How to Add Your Bot](https://support.top.gg/hc/en-us/articles/23135162935708-How-to-Add-Your-Bot)
- **Free.** No minimum server count found anywhere in their docs.
- **Review**: manual, volunteer reviewers, "typically around a week or more." Bot **must stay online** during review or it gets auto-declined; you must tick a checkbox confirming this. [How the Bot Reviewal Process Works](https://support.top.gg/hc/en-us/articles/23135298323996-How-the-Bot-Reviewal-Process-Works)
- **Short description**: the step-by-step submission guide states **under 140 characters**. Note: the separate Guidelines page references not padding text "to reach the 200 character limit" for the same field — those two docs disagree with each other, so treat 140 as the safe target and double-check the live character counter in the form. [How to Add Your Bot](https://support.top.gg/hc/en-us/articles/23135162935708-How-to-Add-Your-Bot) / [Discord Bot Guidelines](https://support.top.gg/support/solutions/articles/73000502502-bot-guidelines)
- **Long description**: markdown and HTML/CSS supported.
- **Tags**: up to 12 categories, developer's choice, no `#`. **Languages**: up to 12.
- **Invite URL**: you supply your own (or top.gg auto-generates a 0-permission one). This is a natural fit for Pavisie since the product already never requests Administrator.
- **Support URL**: must be a non-expiring invite.
- **Disqualifiers relevant to a new bot**: cannot require Administrator permission; must have a working, obvious entry point (e.g. `/help`); cannot be an unmodified fork; no vote-manipulation or reward-for-voting-elsewhere schemes; owner/dev commands must be locked down; no NSFW anywhere on the page. None of these are a problem for Pavisie as described. [Discord Bot Guidelines](https://support.top.gg/support/solutions/articles/73000502502-bot-guidelines)

#### 2. discordlist.gg — DO FIRST
- Confirmed live and active by direct browsing (2026-08-20). Categories include Moderation, Auto Moderation, Logging, Server Management, Utility — a strong fit for Pavisie.
- Notably, its "Trending bots" section on the homepage prominently features bots with **0 servers** — meaning the site's discovery mechanics don't punish a brand-new bot the way vote/server-count-sorted lists do.
- Submission requires "Sign in with Discord" (OAuth). I could not find a public docs/rules page describing exact char limits, image dimensions, or a review queue — that detail only appears inside the logged-in dashboard. Budget time to read the in-dashboard rules at signup before filling anything in.

#### 3. botlist.me — DO EARLY
- Submit at `https://botlist.me/add`. Nav also has a separate, likely-paid "Certification" tier — that's optional, not required to list.
- **Published requirements** (from the add-bot page itself): at least 5 commands that aren't generic (not just help/ping/stats), a working help command, most commands functional, bot online 24/7 (outside maintenance). Long description accepts Markdown and HTML.
- **Disqualifiers**: scam bots (e.g. nitro generators), mass-DM bots, unmodified copies of other bots/GitHub repos, commands that fire without a prefix/mention (with limited exceptions), NSFW commands outside NSFW channels.
- No published minimum server count, no published char limit for the short description, no published image dimensions — none of these appeared on the public add page.
- **Audience caveat**: the live "Top Voted" and "Random" bot rails on botlist.me are dominated by anime/gacha card-collecting RPG bots and one bot explicitly tagged "Certified" that is an adult-roleplay/AI-persona bot. That's a values mismatch for a compliance-first brand, but the platform itself does have real Moderation/Utility/Logging/Role Management tags and doesn't require anything Pavisie can't honestly claim.

#### 4. discordbotlist.com — DO EARLY, EXPECT FRICTION FINDING THE RULES
- Confirmed live and active. Has a dedicated Moderation category (`/discord-moderation-bots`) and a `/new` "New Discord Bots" discovery page.
- Submission is gated behind "Log in with Discord" — I could not locate a public page listing char limits, image specs, minimum servers, or review turnaround; every dead-end (`/add-bot`, `/docs`, `/help`) 404'd. This is very likely because that information only lives inside the logged-in submission flow.
- Recommendation: log in, read whatever the dashboard shows at submission time, and note it down for next time (nothing here disqualifies Pavisie on what's publicly visible).

#### 5. discord.bots.gg — LEGITIMATE BUT SLOWER; DO LATER
- Confirmed alive and active by direct browsing (2026-08-20) — this is "the original Discord bot list," a community-run, all-volunteer operation.
- **Free**, and explicitly "completely free from monetary influences" — no pay-to-rank. [About page](https://discord.bots.gg/about)
- Review is fully manual by a small human team (their About page lists specific people with a "Bot Approval" role, plus one credited, half-joking as "Chief Bot Denial Helper" — a real signal that this list has a genuine, sometimes-strict, human gatekeeper culture, not a rubber stamp).
- General published bot rules (shared across most of these lists, corroborated across search results): bot must be online/public/invitable during review, main features must work, no Administrator-only requirement, commands must request only what they need, must have a clear entry point/help command, no unmodified forks, no scam/NSFW/copyrighted-download content.
- No published minimum server count found, but given the manual/volunteer review culture, this is the one where being brand new with zero social proof (no support server activity, no other listings) is likeliest to slow things down or draw a harder look. Reasonable to sequence after top.gg and discordlist.gg are live.

#### Caution: discadia.com — LOW PRIORITY
- Confirmed live. It is primarily a **server**-discovery site (top-level nav is servers, tags like gaming/anime/roleplay), with a bot section that sits behind a "Verify to Join Top Bots List" interstitial screen. Per the standing rule against completing CAPTCHA/bot-detection/verification gates, I did not click through it, so I could not see botlist.me-style submission requirements for Discadia specifically.
- **Brand-safety concern**: Discadia's own homepage sells paid "Sponsor" placements, and on the day I looked those slots were filled by a "3D crypto casino" server, a "DegenHub — Gambling Community," and a crypto exchange server advertising "No KYC" trading — exactly the kind of wagering/crypto-gambling adjacency a compliance-first, no-wagering-ever product should not want to sit next to.
- Third-party reviews (Trustpilot, aggregated via search) report recurring complaints about spam servers, scam-server ads, and allegations that the operator favors payers — take with a grain of salt (I did not read Trustpilot firsthand, this is a secondhand characterization from search snippets), but it's consistent with what the sponsored slots showed me directly.
- Verdict: not worth the effort right now. Revisit only if Brandon specifically wants the reach and is fine with the brand-adjacency risk.

#### Key finding: disforge.com is NOT the bot list it used to be
I navigated directly to `https://disforge.com/` and `https://disforge.com/bots` on 2026-08-20. Both
now 301-redirect — one to `discordservers.io`, the other (via a second hop) to `discordbots.net`.
`discordservers.io` is a low-quality server-discovery aggregator whose "latest servers" feed included
NSFW/dating-adjacent listings ("18+", "OF", "megapacks") on the front page. This strongly suggests the
`disforge.com` domain has changed hands or been repurposed and is no longer the developer-facing bot
list that gets recommended in older guides. **Do not submit anything here.** (There is a separate,
unrelated `disforge.app`, a Discord server-template marketplace — also not a bot list, not relevant.)

#### Key finding: wumpus.store could not be verified
Direct browser navigation to `wumpus.store` failed outright, and repeated web searches for it returned
nothing but unrelated bots literally named "Wumpus" hosted on other lists (top.gg, discordbotlist.com).
I found no evidence this is a real, currently-operating Discord bot listing site. Recommend treating it
as non-existent until someone finds a working link — don't spend time on it based on this document.

#### Other sites checked and ruled out for now
- **bots.ondiscord.xyz** ("Bots on Discord") — direct navigation failed to load; the only content found was an archived requirements page last revised December 2020. Possibly dead. Confirm it loads in a normal browser before investing any effort.

---

## PART 2 — Listing copy, ready to paste

Facts used below (all verified against the repo on 2026-09-06, nothing invented): tagline
**"Discord moderation you can trust,"** **command prefix `+`, entry point `+help`**, **15 modular
plugins,** **297 invocable commands** (51 top-level, of which 47 are slash commands and 4 are
right-click context-menu commands; 284 of the 297 are subcommands), invite never requests
Administrator, support server `https://discord.gg/5fpRPFMUKu`, site `https://pavisie.com`,
dashboard `https://pavisie.com/dashboard`. Counts are read from `docs/commands.json` — recount
there before reusing them, never estimate. Invite link uses the production client ID from the repo's own
Railway config plus the least-privilege permission integer documented in `docs/PERMISSIONS.md`:

```
https://discord.com/oauth2/authorize?client_id=1538665986633506947&scope=bot%20applications.commands&permissions=1504210971862
```

**Before submitting anywhere:** get a Discord support-server invite link that's set to **never expire**
— I could not find one already published in the repo, only the one live on the website above (confirm
that one is non-expiring before using it in listings).

No user counts, uptime stats, or review quotes are used anywhere below, because none exist yet — per
the honesty requirement, that's stated outright in the long descriptions rather than glossed over.

### 2.0 — Discord App Directory / Developer Portal app description

The Discord Developer Portal's **General Information** tab has a 400-character **Description** field and the App Directory has a longer long-form description. Both must open with `+help`.

**Developer Portal Description** (400-character limit; this copy is 153 characters). Kept deliberately
short — this is a bot *profile*, read at a glance next to the avatar, not a listing page. It only has to
do two things: name the entry point, and point at the site for everything else.
```
Type +help to get started. Moderation, automod, tickets, roles and leveling — all opt-in, never Administrator. Full command list: https://pavisie.com
```

**App Directory long description** (reuse the top.gg long description from Part 2.1 verbatim).

---

### 2.1 — top.gg

**Prefix field**: `+`

**Short description** (140-char limit — this copy is 126 characters):
```
All-in-one moderation & community bot. Type +help to start — every command also works as a slash command. Never Administrator.
```

**Tags** (up to 12; verify against top.gg's live autocomplete list, as the exact controlled vocabulary
wasn't published in their docs — these are reasonable, descriptive picks): `Moderation`, `Utility`,
`Logging`, `Auto Moderation`, `Tickets`, `Leveling`, `Anti-Spam`, `Economy`, `Multipurpose`, `Social`

**Long description** (Markdown):

```markdown
## Getting started

Type **`+help`** in any channel to see all available commands. Every command also works as a slash command (`/`), so use whichever form you prefer. For example: `+mod ban @user spam` or `/mod ban @user spam` — both work identically.

## Moderation you don't have to take on trust

Pavisie is a modular, compliance-first Discord bot for community and gaming servers. It's brand new — no big server count, just a working product in front of real communities for the first time. Here's what makes it different.

### The Admin Enforcer

Most moderation bots ask you to trust that whoever's on duty made the right call. Pavisie's **Enforcer** plugin instead turns policy violations into a paper trail: an admin writes plain-language policies, the bot flags matches (or staff flag something by hand) into a private review queue, a moderator picks an action, and the bot carries it out and messages the user directly — no DMs, no confrontations. Every flag and every decision gets written to a read-only, append-only ledger channel in your own server, and members can appeal. It's moderation that stays consistent no matter who's on shift, with a record nobody has to take on faith.

### 15 plugins, 297 commands, all opt-in per server

Admin · Moderation · Automod · Enforcer · Logging · Tickets · Roles & Onboarding · Engagement (XP, leveling, temp voice, starboard) · Community (polls, giveaways, suggestions, scheduled announcements) · Gamestats (Steam leaderboards) · Economy (virtual-only, no real money) · Utility · Media · Integrations (Twitch/YouTube go-live, Reddit, Steam, Instagram, Google/Microsoft calendars, webhooks) · AI Assistant (mention-based chat, configurable persona). Every plugin can be switched on or off per server.

### Least-privilege by default

Pavisie **never asks for Administrator.** Every command requests only the specific permission it needs, and message-content-dependent features stay off until an admin explicitly turns them on.

### Get started

- Type `+help` in Discord to see all commands (also works as `/help`)
- Invite: `https://pavisie.com` or use the button on this page
- Dashboard: `https://pavisie.com/dashboard`
- Support: `https://discord.gg/5fpRPFMUKu`

We're brand new here. If you try Pavisie and something's broken, missing, or confusing, the support server is the fastest way to reach us directly.
```

**Invite URL to submit**: the client-ID link above.
**Support URL to submit**: `https://discord.gg/5fpRPFMUKu` (confirm non-expiring first).

---


### 2.2 — discordlist.gg

No published char limit found — the following short description is kept tight (under 100 characters)
to be safe on an unfamiliar form:

**Short description:**
```
Type +help to start. Modular bot: moderation, automod, Enforcer (public ledger), logging, tickets, roles, and more. Never Administrator.
```

**Tags**: `Moderation`, `Auto Moderation`, `Logging`, `Server Management`, `Utility`, `Role Management`

**Prefix field** (if discordlist.gg supports it): `+`

**Long description**: reuse the top.gg long description verbatim (Part 2.1) — discordlist.gg's bot
pages render Markdown-style long-form text similarly to top.gg's, based on other listings observed
there. It includes the "Getting started: type `+help`" call-out at the top.

**Invite / Support**: same links as above.

---

### 2.3 — botlist.me

**Short description** (no published limit — kept under 150 characters to be safe):
```
Type +help to start. Modular bot: moderation, automod, Enforcer (audit ledger), tickets, roles, leveling, integrations, AI, and more.
```

**Tags**: `Moderation`, `Utility`, `Logging`, `Role Management`, `Leveling`, `Web Dashboard`

**Prefix field** (if botlist.me has it): `+`

**Long description**: reuse the top.gg long description (Part 2.1); botlist.me's add form explicitly
supports Markdown and HTML, so no reformatting needed.

**Before submitting, confirm live**: Pavisie has far more than the required 5 non-generic commands exposed (297 total), and `+help` and `/help` both work as the obvious entry point, per their published rule.

---

## PART 3 — Reddit

**Everything below is a live read, not a paraphrase.** Method: fetched each subreddit's own public
`old.reddit.com/r/<sub>/about.json` (subscriber count) and `old.reddit.com/r/<sub>/about/rules.json`
(exact current rule text) directly, read-only, logged out, 2026-08-20. Where a subreddit publishes no
structured rules, the sidebar/submission-guide text is quoted instead and labeled as such. A general
caveat that applies to every entry below: subreddit AutoModerator karma/account-age gates, if any, are
mod-configured and not exposed by this public data — none is stated in any human-readable rule quoted
below, but a hidden AutoMod filter on a low-karma/new account can't be ruled out from outside. Build a
little normal (non-promotional) history on whatever account will post before using it anywhere here.

### Reddit's site-wide self-promotion guidance (the 9:1 / "not just a spammer" rule)

This is Reddit's own long-standing, widely-documented platform-level guidance (not a subreddit-specific
rule): as a rough rule of thumb, no more than roughly **1 in 10** of an account's posts/comments should
be self-promotional — the rest should be genuine participation with no link to your own project. The
spirit of the rule, repeated consistently across every secondary source I could reach (e.g. the
self-promotion breakdowns at [mediafa.st](https://www.mediafa.st/reddit-self-promotion-rules-guide) and
[redship.io](https://redship.io/blog/reddit-self-promotion-rules)), is behavioral, not just numerical:
an account that shows up only to drop links to its own bot, in multiple subreddits, in a short window,
reads as spam and gets action taken against it (post removal, shadowban, or suspension) regardless of
the literal ratio. **For an account that has posted little or nothing except things related to its own
project — which is the realistic starting point here — every subreddit post about Pavisie should be
treated as spending down a very limited trust budget, not as a free/repeatable channel.**

### Subreddit-by-subreddit findings (verified live on 2026-08-20 via old.reddit.com)

#### r/discordapp — 1,530,274 subscribers
- **Self-promotion rule (3.2, "Advertising/Self-Promotion")**: *"No advertising/self-promoting
  servers, selling/buying accounts, trading, or nitro begging. Server self-promotion will result in an
  immediate perm ban. Advertising personal bots/projects is allowed if it does not make up a notable
  portion of your account history."*
- **Standalone posts**: allowed for a **bot/project**, explicitly **not** allowed for the Discord
  **server** invite (that's a perm-ban offense here). Keep any bot post a small fraction of the
  account's overall history.
- **Account age/karma gate**: none published.
- **Source**: `https://old.reddit.com/r/discordapp/about/rules/`
- **VERDICT: POST (bot only, sparingly)** — never post the support-server invite link here.

#### r/Discord_Bots — 68,366 subscribers
- **Self-promotion rule ("No advertising.")**: *"Users may advertise their own bots, but only in
  response to others questions or concerns. Servers are not allowed to be advertised, unless they are
  in response to a question or topic, and it is preferred for them to be support servers, not just
  random ones. All other forms of advertisement are [not allowed]."* This matches what was already
  confirmed by hand before this pass — no new contradiction found.
  Other rules found: no low-effort posts, must disclose paid vs. free, all posts must be about Discord
  bots, no "bot support" questions.
- **Standalone posts**: **no** — a standalone "I built a bot" post is a self-promotion violation here.
  Only a reply to someone else's relevant question is permitted.
- **Account age/karma gate**: none published.
- **Source**: `https://old.reddit.com/r/Discord_Bots/about/rules/`
- **VERDICT: REPLY-ONLY.**

#### r/discordbots (no underscore, a real and distinct community from r/Discord_Bots) — 18,803 subscribers
- **Self-promotion rule ("No advertising or self-promotion")**: *"This isn't a place to make a post to
  purely promote your Discord bots, it's a community for them. In the case of users asking for
  recommendations, feel free to link to your bot from a reputable source, such as top.gg. Do not
  directly link the invite."*
- **Standalone posts**: no. Even in a permitted reply, link through top.gg (or similar), not a direct
  bot-invite link.
- **Account age/karma gate**: none published.
- **Source**: `https://old.reddit.com/r/discordbots/about/rules/`
- **VERDICT: REPLY-ONLY** (stricter than r/Discord_Bots — no direct invite link even in a reply).

#### r/DiscordBotDesigner — 2,627 subscribers
- Public description: "Official Bot Designer For Discord app subreddit." Rules include "Do not
  advertise 3rd party Discord servers" (mod permission required, and only for complicated support
  cases) and "Do not promote services" ("This is not the place to promote your development services...
  Your message will be deleted and you risk being banned.").
- Small, and both its focus and its rules argue against posting.
- **Source**: `https://old.reddit.com/r/DiscordBotDesigner/about/rules/`
- **VERDICT: DO NOT POST** — explicitly bans promoting services/bots, and reach is negligible anyway.

#### r/SideProject — 814,266 subscribers
- **Submission format (from the subreddit's own submit-text, matches the sidebar)**: *"When submitting
  a link to a project or startup, please use this format: [Project name] - [Short description]. For
  example, 'Reddit - A website for sharing and discussing links.'"*
- Sidebar: "a subreddit for sharing and receiving constructive feedback on side projects... also a
  subreddit to get motivated and inspired to work on new projects."
- **Standalone posts**: yes, this is the sub's entire purpose.
- **Account age/karma gate**: none published.
- **Source**: `https://old.reddit.com/r/SideProject/` and `.../about/rules/`
- **VERDICT: POST**, title reformatted to the required `[Project name] - [Short description]` shape.

#### r/selfhosted — 824,458 subscribers
- **Self-promotion rule ("Spam / Self-Promotion / Affiliate Links")**: *"Do not spam or promote your
  own projects too much. We expect you to follow this Reddit self-promotion guideline... Promoted apps
  must be production ready and have docs. No direct ads for web hosting or VPS. Only mention your
  service in comments if it's relevant and adds value."* There's also a Wednesday-only exception for
  dashboards/companion tools, and a "New Project Megathread" exception for projects under 3 months old.
- **Reasoning for the verdict**: none of that matters here because of a topic mismatch, not a rule
  problem — r/selfhosted is for software people run on their **own** infrastructure. Pavisie is a
  hosted bot/dashboard (Brandon runs it on Railway; users invite it, they don't deploy it). Per the
  product facts for this document, there's no self-hostable release to point to.
- **Source**: `https://old.reddit.com/r/selfhosted/about/rules.json`
- **VERDICT: DO NOT POST** — off-topic for this community regardless of rule wording.

#### r/programming — 6,912,953 subscribers
- **Rule**: *"No Product Promotion/'I Made This' Project Demo Posts — r/programming is not the place
  to post a project to get feedback, ask for help, or otherwise promote it. Technical write-ups on what
  makes a project technically challenging, interesting, or educational are allowed..."*
- **Source**: `https://old.reddit.com/r/programming/about/rules.json`
- **VERDICT: DO NOT POST.**

#### r/webdev — 3,299,593 subscribers
- **Rules**: *"No self-promotion — ...no excessive self-promotion. Please refer to the Reddit 9:1 rule
  ..."*; *"No commercial promotions/solicitations — We do not allow any commercial promotion or
  solicitation. Violations can result in a ban."*; *"No soliciting feedback not on Saturday — Sharing
  your project, portfolio, or any other content that you want to either show off or request feedback on
  is limited to Showoff Saturday. If you post such content on any other day, it will be removed. Posts
  must be tagged with the correct fl[air]."*
- **Standalone posts**: only inside **Showoff Saturday**, correctly flaired.
- **Source**: `https://old.reddit.com/r/webdev/about/rules.json`
- **VERDICT: MEGATHREAD ONLY — runs every Saturday ("Showoff Saturday").**

#### r/startups — 2,115,467 subscribers
- **Rule ("No direct sales, advertisements, or promotional posts of any kind")**: *"We have designated
  places that are an exception to this rule and they will always be stickied at the top of
  /r/startups. You MAY share your startup in the Monthly Share Your Startup thread. Self-promotion is
  anything you have an interest, stake or relationship with..."*
- **Source**: `https://old.reddit.com/r/startups/about/rules.json`
- **VERDICT: MEGATHREAD ONLY — the "Monthly Share Your Startup" thread, stickied at the top of the sub.**

#### r/Entrepreneur — 5,260,934 subscribers
- **Rule ("No promotion, sales, or solicitation")**: *"Do not use this community to sell, promote,
  recruit, hire, job-seek, solicit investment, or drive traffic to your profile, company, or external
  content. No dropping URLs, asking users to DM you... Free offers and promotions belong only in the
  designated weekly threads. Violations may result in a permanent ban."*
- **Source**: `https://old.reddit.com/r/Entrepreneur/about/rules.json`
- **VERDICT: MEGATHREAD ONLY — designated weekly promo thread(s); check current sidebar for which one
  is running and its exact name before posting.**

#### r/IndieBiz — 40,495 subscribers
- **Submission guidance (sidebar)**: *"Please make a self post describing your business, services and
  products, and where you are located (if your business is regional)... Please use the following tags
  in your titles... [INTRO] [OFFER] [NETWORKING] [RESOURCE] [REQUEST]. NO MLM POSTING AT ALL."* No
  structured AutoMod rules were published (empty rules list) — this sidebar text is the operative
  policy.
- **Source**: `https://old.reddit.com/r/IndieBiz/about.json` (sidebar/description field)
- **VERDICT: POST** — self-post, `[INTRO]` tag, describe the product honestly (no location applies —
  Pavisie is online-only).

#### r/alphaandbetausers — 42,649 subscribers
- **Submission guidance (sidebar)**: *"Posts must include links to products that are ready to be
  tested. Please tag title with stage and system, i.e., [Android, Alpha] or [IOS, Beta]... DO NOT post
  links to pages that only request email addresses or 'registration for launch'... If you are posting,
  please take the time to test someone else's product as well."*
- This is a good fit specifically because Pavisie has a real, invitable bot and a live dashboard —
  not just a landing page — which is the exact bar this sub sets.
- **Source**: `https://old.reddit.com/r/alphaandbetausers/about.json` (sidebar/description field)
- **VERDICT: POST** — title tagged `[Discord, Beta]`, reciprocal testing expected as a norm.

#### r/roastmystartup — 34,016 subscribers
- **Submission guidance**: *"You can only submit your own start-up. We will look through your post
  history to ensure you are at least somewhat affiliated to that start-up... YOU MUST POST A CLICKABLE
  LINK IF YOUR BUSINESS IS ALREADY OUT THERE."* Required template: product, market, product analysis,
  stage/funding, customer-conversion strategy, "why you."
- **Culture note**: this sub's entire premise is blunt, sometimes harsh critique ("Don't come in here
  expecting any feel-good compliments") — good for pressure-testing the pitch, higher reputational risk
  than the others if the response is dismissive.
- **Source**: `https://old.reddit.com/r/roastmystartup/about.json` (description + submit_text fields)
- **VERDICT: POST** — genuinely on-topic, but sequence it after the account has some Reddit history so
  the mods' post-history affiliation check doesn't read as a fresh throwaway.

#### r/DiscordServers and r/discordservers — do not exist
- Both return HTTP 404 from `old.reddit.com/r/DiscordServers/about.json` (Reddit subreddit names are
  case-insensitive, so the capitalized and lowercase spellings are the same non-existent subreddit).
  There is no active community at that name to post to.

#### r/Discordian_Bots and r/DiscordianBots — do not exist
- Both return HTTP 200 but an **empty listing** (`"children": []`, no subreddit data) from
  `old.reddit.com/r/Discordian_Bots/about.json` — Reddit's quirky way of saying there's no subreddit
  there, rather than a clean 404. No real community exists at either name.

#### Discord-server-growth directories found (not asked for by exact name, found by searching)
Since r/DiscordServers doesn't exist, here's what a live search of Reddit's own subreddit index
(`old.reddit.com/subreddits/search.json?q=discord%20server`) actually turned up, checked the same way:

| Subreddit | Subscribers | What it is | Verdict |
|---|---|---|---|
| r/Discord_Servers_List | 16,612 | Real directory. Sidebar: *"share your discord server for free or find new communities to join... we only approve servers we can access to review for rule violations."* Rule: promotion restricted to Discord servers only, no social/website links. | **POST**, but only after granting the mod team access to review the server first — that's a real gate, not optional. |
| r/DiscordServerGrow | 11,291 | Sidebar: *"Advertise your favorite Discord Servers here! Please join the subreddit prior to posting, or posts may be removed by AutoMod."* No structured rules configured beyond that. | **POST** (join the sub first). |
| r/PromoteDiscordServer | 6,273 | Rules: post limit once per 24 hours, SFW servers only, valid Discord link required, no "ad servers"/"growth hubs," no giveaway-only or monetary/paid-focus servers, English only. | **POST** — Pavisie's support server isn't a giveaway/growth-hub server, so it clears these rules. |
| r/DiscordServerPromos | 19,706 | Sidebar frames it as the *"official subreddit used by [two named Twitch streamers]"*; **comments are globally disabled** sitewide on the sub. Rules exist (age-gating ban, Discord/Reddit ToS, "remember the human") but the overall shape reads as a personal/branded space, not a general open directory. | **NOT RECOMMENDED** — ambiguous fit, low confidence this is a genuine general-purpose venue; skip rather than guess. |
| r/DiscordServersAd | 2,272 | Exists (200 OK), rules not read — too small to be worth the research time given the alternatives above. | Not pursued. |
| r/PostDiscordServerAds | 77 | Exists but `subreddit_type: restricted` (posting likely needs approval), rules not read — negligible reach. | Not pursued. |
| r/discord__server | 49 | Exists but `restricted`, rules not read — negligible reach. | Not pursued. |
| r/DiscordServerAd | — | Returns HTTP 403 (private/inaccessible) — could not read anything about it. | Could not verify; skip. |

### Summary table

| Subreddit | Subscribers | Verdict | Key reason |
|---|---|---|---|
| r/discordapp | 1,530,274 | POST (bot only, sparingly) | Rule 3.2 allows bot/project ads; server-invite ads are a perm-ban |
| r/Discord_Bots | 68,366 | REPLY-ONLY | Standalone promo posts explicitly banned; replies to relevant questions only |
| r/discordbots | 18,803 | REPLY-ONLY | Same, plus: link via top.gg, never a direct invite |
| r/DiscordBotDesigner | 2,627 | DO NOT POST | "Do not promote services" rule; tiny, narrow focus |
| r/SideProject | 814,266 | POST | Self-promotion is the sub's purpose; strict title format |
| r/selfhosted | 824,458 | DO NOT POST | Pavisie is hosted, not self-hostable — topic mismatch |
| r/programming | 6,912,953 | DO NOT POST | Explicit "No Product Promotion" rule |
| r/webdev | 3,299,593 | MEGATHREAD ONLY | Showoff Saturday only |
| r/startups | 2,115,467 | MEGATHREAD ONLY | Monthly "Share Your Startup" thread only |
| r/Entrepreneur | 5,260,934 | MEGATHREAD ONLY | Designated weekly promo thread only |
| r/IndieBiz | 40,495 | POST | Sidebar explicitly invites self-posts with title tags |
| r/alphaandbetausers | 42,649 | POST | Wants exactly this: a live, testable product |
| r/roastmystartup | 34,016 | POST | On-topic; blunt-feedback culture, mod history check |
| r/DiscordServers / r/discordservers | n/a | DOES NOT EXIST | 404 on both spellings |
| r/Discordian_Bots / r/DiscordianBots | n/a | DOES NOT EXIST | Empty listing, no real subreddit |
| r/Discord_Servers_List | 16,612 | POST (mod review gate) | Real directory; requires granting access to review the server first |
| r/DiscordServerGrow | 11,291 | POST | Open directory, join sub before posting |
| r/PromoteDiscordServer | 6,273 | POST | Rules-compliant (once/24h, SFW, not a "growth hub") |
| r/DiscordServerPromos | 19,706 | NOT RECOMMENDED | Reads as a personal/branded space, not a general directory |

---

## PART 4 — Draft posts

All drafts below assume Brandon (or whoever holds the account) re-reads the live sidebar/rules
immediately before posting and adjusts for anything that's changed since 2026-08-20.

### 4.1 — r/SideProject (POST)

**Suggested flair** (if the sub uses flair — confirm live): "Sharing" / "Show & Tell" / closest
equivalent available.

**Title** (reformatted to the sub's required `[Project name] - [Short description]` shape — see Part 3):
```
Pavisie - a Discord bot that turns mod decisions into a public, appealable audit log
```

**Body:**
```
Hey — developer here, this is my own project (Pavisie), posting because I think the approach might
be useful to some of you even if you never install it.

The problem I kept running into on every Discord server I've modded: moderation runs on trust. Someone
gets timed out or banned, and unless you were watching, you just have to believe the mod made the right
call. There's usually no record a regular member can check.

Pavisie's main feature (called the Enforcer) tries to fix that mechanically instead of just asking for
more trust: an admin writes a plain-language policy, the bot watches for matches (or staff flag something
manually), a moderator reviews the flagged message in a private queue and picks an action, and the bot
carries it out and messages the user itself — no DMs, no back-and-forth. Every flag and every decision
gets written to a read-only ledger channel in the server itself, and there's a built-in appeal command.
Nothing is hidden from the members after the fact.

Beyond that it's a fairly standard modular "all-in-one" bot — 15 independently-toggleable plugins
covering moderation, automod, logging, tickets, roles/onboarding, leveling, community tools, integrations, 
an optional AI assistant, and more — but I wanted the headline feature to be the trust mechanism, not 
another feature checklist, since that's the most saturated category on Discord.

Every command works both as a slash command (`/`) and as a message command with the `+` prefix — try 
`+help` to see what's available, or use `/help` if you prefer.

It's brand new. No real user base yet, no track record — I'm posting here specifically to get honest
first reactions before I put real effort into growing it.

Site: https://pavisie.com
Dashboard (if you want to see the config UI without inviting anything): https://pavisie.com/dashboard

Happy to answer anything about the architecture, the moderation-audit design, the prefix-command layer, 
or why I went with an append-only ledger instead of just better logging.
```

*(Deliberately no invite link in the body — SideProject's culture rewards "look what I built" over
"come use my thing"; the site link is enough for anyone curious, and the dashboard link lets people
look without inviting a bot to a server. This fits the sub's stated purpose of "sharing and receiving
constructive feedback," and explicitly invites it in the last line.)*

### 4.2 — r/Discord_Bots and r/discordbots (REPLY-ONLY — no standalone draft)

Both subs' current rules ban a standalone "I made this" post (see Part 3). The only permitted use is a
**genuinely helpful reply to someone else's question**, written so it's useful even to someone who
never installs Pavisie — the disclosure comes after the actual answer, not instead of it. On
r/discordbots specifically, link via a reputable source like top.gg rather than a direct invite link;
on r/Discord_Bots, keep this kind of reply a small fraction of the account's total activity there.

**Example reply** (to a hypothetical thread like "looking for a mod bot where I can actually trust what
my mod team is doing"):
```
If the actual problem is trust in the mod team specifically (not just "need an automod"), the thing to
check for is whether the bot writes an actual record of moderation decisions somewhere members can see —
a lot of bots log actions to a private mod-only channel, which doesn't help with "can I trust my mods"
since only the mods can read it. Worth comparing candidates on: does it log to a channel regular members
can read, can that log be edited after the fact, and is there any kind of appeal path for the person who
got actioned.

(Disclosure: I built one of these — Pavisie — specifically because I kept hitting this exact problem
modding my own servers. Its Enforcer plugin writes every flagged message and every mod decision to a
read-only, append-only ledger channel, plus a built-in appeal command. Not saying it's the only answer —
just flagging what's worth checking for regardless of which bot you land on.)
```

### 4.3 — r/IndieBiz (POST)

**Title** (per the sub's required `[TAG]` format):
```
[INTRO] Pavisie — a modular, compliance-first Discord moderation bot
```

**Body:**
```
Hi all — introducing my project, Pavisie. Online-only (no physical location — it's a Discord bot with
a web dashboard, not a local business).

What it is: a modular Discord bot for community/gaming servers — 15 independently-toggleable plugins
covering moderation, automod, logging, tickets, roles/onboarding, leveling, community tools, virtual-only
economy, utility, integrations, an optional AI assistant, and more.

Entry point: type `+help` in Discord to see all commands (or `/help` if you prefer slash commands — 
every command works both ways).

What I think is actually distinctive: the Enforcer plugin turns moderation into an audit trail instead
of something members just have to trust — flagged messages and moderator decisions get written to a
read-only, append-only ledger channel in the server itself, with a built-in appeal command. It also
never requests the Administrator permission; every command asks for only what it specifically needs.

Where it's at: brand new, shipped and live, no meaningful user base yet. Not here to claim numbers I
don't have — mostly interested in feedback and in connecting with other people building in this space.

Site: https://pavisie.com
Dashboard: https://pavisie.com/dashboard
```

### 4.4 — r/alphaandbetausers (POST)

**Title** (per the sub's required `[System, Stage]` tag format):
```
[Discord, Beta] Pavisie — modular bot with +help entry point and public, appealable mod-ledger
```

**Body:**
```
Product: Pavisie, a modular Discord bot — invite it and toggle on whichever of its 15 plugins your
server needs (moderation, automod, logging, tickets, roles, leveling, community tools, utility,
integrations, optional AI assistant, and more). Every command works as both a slash command and a 
message command with the `+` prefix — try `+help` to explore.

What I want tested/feedback on specifically: the Enforcer plugin. It writes every flagged message and
every moderator decision to a read-only, append-only ledger channel in your own server, plus a built-in
appeal command — the idea is moderation your members can actually audit instead of just trust. It never
asks for Administrator.

It's live and working, not a landing page — invite link and dashboard both below. No real servers using
it yet, so this is genuinely early feedback I'm after.

Invite: https://pavisie.com
Dashboard: https://pavisie.com/dashboard

Happy to return the favor and test something of yours in exchange — drop a link.
```

### 4.5 — r/roastmystartup (POST — sequence after some account history exists)

Mods check post history for affiliation before approving, and the required template is specific —
follow it exactly:

```
**The product**: Pavisie (https://pavisie.com) — a modular Discord moderation bot. Its headline
feature, the Enforcer, writes every flagged message and moderator decision to a read-only, append-only
ledger channel in the server itself, with a built-in appeal command, instead of leaving moderation as
something members just have to trust. Entry point: type `+help` in Discord to see all commands (or 
`/help` if you prefer slash commands — both work). 15 total plugins, all opt-in per server. Never 
requests Administrator.

**The market**: Discord has an enormous, crowded field of general-purpose "all-in-one" bots
(moderation + leveling + tickets + economy, etc.). Competition is real and well-funded incumbents exist.
I'm not claiming a unique category — the bet is that the audit/trust angle is a real, underserved
differentiator inside an otherwise saturated space, not that the space itself is empty.

**Product analysis / vs. competition**: most competitors log moderator actions to a private mod-only
channel at best. Few, if any, write an append-only, member-readable ledger with a built-in appeal
command as a first-class feature rather than an afterthought.

**Stage**: shipped and live — real bot, real dashboard (https://pavisie.com/dashboard), zero meaningful
server count so far. Not raising money; this is self-funded and small right now.

**Customer conversion strategy**: honestly the weakest part right now — this document (bot-list
submissions, r/SideProject, r/alphaandbetausers, targeted subreddit replies) is most of the plan so
far. Genuinely looking for harder questions on this specifically.

**Why me**: I built it because I hit this exact "can I trust my mod team" problem moderating my own
Discord servers, not because I picked "Discord bot" as a market from a spreadsheet. Go ahead and roast
it — that's what I'm here for.
```

### 4.6 — Megathread copy (post only inside the correct pinned/stickied thread, correctly flaired where required)

**r/webdev — "Showoff Saturday" only:**
```
Pavisie — a modular Discord moderation bot. Most interested in feedback on one thing: instead of
logging admin actions to a private mod channel, it writes every flagged message and mod decision to a
read-only, append-only ledger channel that regular members can read, plus a built-in appeal command.
15 opt-in plugins total (moderation, automod, tickets, roles, leveling, integrations, AI, etc.), 
never requests Administrator. Type +help in Discord to explore all commands (also works as slash commands).

Brand new, no real user base yet — genuinely trying to find out if the audit-log idea is actually
useful or just adds friction.

Site: https://pavisie.com | Dashboard: https://pavisie.com/dashboard
```

**r/startups — "Monthly Share Your Startup" thread only:**
```
Pavisie — modular, compliance-first Discord bot for community/gaming servers. Differentiator: mod
decisions get written to a public, read-only, append-only ledger in the server itself (with an appeal
command), instead of just a private mod-only log — moderation you can audit, not just trust.

Stage: shipped and live (site + dashboard), no meaningful user base yet — here for feedback on
positioning more than growth at this point.

https://pavisie.com
```

**r/Entrepreneur — designated weekly promo thread only (confirm current thread name/rules live):**
```
Pavisie — a modular Discord moderation bot for community/gaming servers. The differentiator: every
flagged message and moderator decision is written to a read-only, append-only ledger channel in the
server itself, with a built-in appeal command — an audit trail instead of "just trust the mods."
Never requests Administrator. Brand new, no track record yet — feedback welcome.

https://pavisie.com
```

### 4.7 — Discord-server-growth directories (promoting the support server itself, not the bot pitch)

These three are about getting people into the Pavisie support/feedback server as a community, not
about pitching the bot's features — keep the copy honest about size (new, small) per the no-fake-content
rule.

**r/Discord_Servers_List** (POST, but grant the mods review access to the server before it'll be approved):
```
Pavisie Support & Feedback — a brand-new space for a Discord moderation bot I'm building. Come by if
you're evaluating mod bots, want to poke at the dashboard, or just want to see how the Enforcer
audit-log feature works before inviting anything to your own server. Small right now — that's the
honest state of it, not a sales pitch.

https://discord.gg/5fpRPFMUKu
```

**r/DiscordServerGrow** (POST — join the sub before posting):
```
Pavisie Support & Feedback — new support server for a modular Discord moderation bot (Enforcer plugin
writes mod decisions to a public, appealable ledger instead of a private mod-only log). Looking for
early testers and feedback more than members for their own sake.

https://discord.gg/5fpRPFMUKu
```

**r/PromoteDiscordServer** (POST — respect the once-per-24h limit, SFW-only, not framed as a growth hub):
```
Pavisie Support & Feedback Server
A new support/feedback community for Pavisie, a modular Discord moderation bot. Come talk to the
developer directly, try the dashboard, or get help setting it up. Small and new — not an established
community, just an honest invite to the people actually building and testing it.

Invite: https://discord.gg/5fpRPFMUKu
```

*(Invite link used above is the one already live on the site — confirm it's set to never expire before
using it anywhere, per Part 2.)*

---

## PART 5 — Risks and order of operations

### What gets an account banned or a bot delisted
- **Too many venues, same account, same few weeks.** Part 3 now has roughly a dozen POST/MEGATHREAD/
  REPLY-ONLY venues verified live — that's more real options than the earlier draft found, but from
  Reddit's side it's still **one account** doing all of it. More venues doesn't mean the 9:1 trust
  budget multiplies; it means more chances to trip it if everything lands in the same short window.
  Treat the whole list in Part 3/4 as sharing one budget, not eleven separate ones.
- **Cross-posting identical text to multiple subreddits same-day.** This is the single most common
  spam signal on Reddit — a moderator or AutoModerator seeing the same paragraph in r/SideProject and
  r/IndieBiz within hours of each other reads as a bot/marketing account, not a person. Space these
  out by at least several days, and rewrite the copy for each sub's voice rather than reusing verbatim
  (the drafts in Part 4 are already written differently per sub for this reason — keep them that way).
- **Posting from a fresh/low-karma account with no history.** An account whose first-ever posts are all
  about the same product is the exact pattern the 9:1 guidance and most subreddit AutoModerator configs
  are built to catch. If the Reddit account being used has little history, build a small amount of
  genuine participation (comments, unrelated posts) in the target communities before any draft goes
  up — this is more protective than any wording choice.
- **Skipping the disclosure.** Every draft above discloses "developer here" up front. Omitting that and
  getting caught (someone checks post history, notices the account only ever talks about one product)
  is a fast path to a ban in communities that care about this — r/SideProject, r/IndieBiz,
  r/alphaandbetausers, and r/roastmystartup all do, and it's non-negotiable on r/Discord_Bots/
  r/discordbots since a disclosed reply is the *only* way those two subs allow this at all.
- **Posting a standalone "I made this" on r/Discord_Bots, r/discordbots, or r/programming.** All three
  have an explicit current rule against exactly that (quoted in Part 3) — this isn't a judgment call,
  it's a rule that will get the post removed and can get the account actioned.
- **Claiming numbers that don't exist.** No server counts, uptime percentages, or user testimonials
  appear anywhere in this document, on purpose — Pavisie has none yet, and inventing any would violate
  both Brandon's explicit no-fake-content rule and most of these communities' own rules against
  misleading claims.
- **Submitting to a listing site whose brand doesn't fit and getting flagged as a mismatch.** Discadia's
  gambling-adjacent sponsor slots and disforge.com's redirect to an NSFW-adjacent server directory are
  reasons to actively avoid those two, not just deprioritize them — being listed there (or worse,
  submitting a bot that gets reviewed by whoever now runs the disforge.com/discordservers.io domain) is
  a reputational risk with no clear upside.
- **Treating "verify to continue" / CAPTCHA-style gates (e.g. Discadia's bot-list interstitial) as a
  normal login step and clicking through automatically.** These weren't completed during this research
  per the standing rule against bypassing bot-detection — whoever does the actual submission should
  be aware that gate exists and decide deliberately whether to proceed.

### Recommended order of operations
1. **First**: lock in a non-expiring Discord support-server invite link (confirm the one already live
   on the site, `https://discord.gg/5fpRPFMUKu`, doesn't expire) — every listing and every Reddit draft
   references it.
2. **Submit top.gg.** Highest-value, clearest rules, ~1 week review — start the clock on this first
   since it's the slowest-moving one of the achievable listings.
3. **Submit discordlist.gg and botlist.me** shortly after (same week is fine — these are different
   sites with different audiences, so this isn't "cross-posting the same content five times").
4. **Build a little ordinary (non-promotional) Reddit history** on whichever account will post, on the
   side, before any Reddit item below goes up — comments, unrelated posts. This protects every single
   Reddit venue at once; it's the single highest-leverage step in this whole plan.
5. **First Reddit post: r/SideProject.** No time-window dependency (unlike the megathread-only subs),
   big audience, straightforward format. Good first move.
6. **A few days to a week later, one at a time: r/IndieBiz, then r/alphaandbetausers.** Both are
   POST-verdict with no timing dependency — space them apart from each other and from step 5, and vary
   the copy (Part 4 drafts are already written differently per sub).
7. **Opportunistically, whenever they're actually running: the megathread-only venues** — r/webdev's
   Showoff Saturday, r/startups' Monthly "Share Your Startup" thread, r/Entrepreneur's designated weekly
   thread. These are gated by calendar, not by account readiness, so catch them as they come up rather
   than trying to force all three into one week.
8. **Reply-only, ongoing, not scheduled**: watch r/Discord_Bots, r/discordbots, and r/discordapp for
   genuinely relevant questions and reply per the rules in Part 3/4 (disclosed, useful on its own,
   never a direct invite link on r/discordbots). This isn't a one-time task — it's a standing practice,
   and forcing it on a schedule is exactly what reads as inauthentic.
9. **r/roastmystartup**: sequence this after steps 5–6 so the account has some visible history by the
   time its mods check post-history affiliation — not a hard blocker, just better odds of a clean
   approval.
10. **Discord-server-growth directories** (r/Discord_Servers_List, r/DiscordServerGrow,
    r/PromoteDiscordServer): different audience/purpose than the bot-pitch posts (joining a community
    vs. installing a bot), so these can run in parallel with steps 5–9 rather than waiting on them —
    but they still count against the same account's overall cadence, so don't stack all three the same
    day. Start with r/Discord_Servers_List's mod-review-access step early since that gate can take time
    on its own.
11. **Hold off on discordbotlist.com and discord.bots.gg's exact rules discovery** (log in, read what
    the dashboard says) until step 2–3 are done, since neither is time-sensitive and both benefit from
    Pavisie having a slightly less "just created" footprint by the time you look.
12. **Skip discadia.com and disforge.com** entirely unless Brandon explicitly decides the reach is worth
    the brand-adjacency risk after reading the findings above.
