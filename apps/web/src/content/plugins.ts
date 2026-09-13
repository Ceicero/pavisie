// Curated marketing copy per plugin (ARCHITECTURE.md §17). This is the only hand-written content on the site —
// everything else (command names, descriptions, permissions) is generated from the plugin registry so it can
// never drift from what the bot actually does. Keyed by the real `PluginId` union so a missing entry is a
// compile error, not a silent gap.
import type { PluginId } from '@pavisie/types';

export interface PluginCopy {
  /** One sentence, used as the card/section headline. */
  headline: string;
  /** Bullet points answering "why gaming communities love it". */
  whyGaming: string[];
  /** Short highlight chips shown on the overview card. */
  highlights: string[];
}

export const pluginCopy: Record<PluginId, PluginCopy> = {
  admin: {
    headline: 'The control room every server needs before it needs anything else.',
    whyGaming: [
      'A guided setup wizard gets a new server from zero to configured in minutes, no trial-and-error required.',
      'Enable and disable feature modules per server, so a small clan and a 20,000-member org run the same bot differently.',
      'A permissions audit tells staff exactly which bot permission is missing and which feature it will break — before members notice.',
      'Every configuration change is written to an audit trail, so "who changed this?" always has an answer.',
    ],
    highlights: ['Guided setup', 'Plugin marketplace', 'Permission audits', 'Full audit trail'],
  },
  moderation: {
    headline: 'Warnings, timeouts, kicks and bans — with a case number for every one of them.',
    whyGaming: [
      'Competitive lobbies and voice channels get heated; a moderator hierarchy stops a helper from ever touching an admin, the owner, or the bot itself.',
      'Escalation rules (three warnings triggers a timeout, say) keep enforcement consistent across a large staff roster instead of depending on who is online.',
      'Every action gets an immutable case number, a reason, and an optional evidence link — useful when a banned player disputes it in a support ticket.',
      'Temporary punishments expire on their own with a background job, so nobody has to remember to `/unban` someone at 3am.',
    ],
    highlights: ['Case IDs', 'Escalation rules', 'Appeals workflow', 'CSV export'],
  },
  automod: {
    headline: 'Catches spam, invite drops and phishing links before a human has to.',
    whyGaming: [
      'Raid nights and giveaway spikes bring bot accounts and invite-link spam; automod filters it in milliseconds, at 3am, every night of the week.',
      'Dry-run mode lets staff tune new rules against real traffic without accidentally punishing legitimate players while they calibrate.',
      'A false-positive review queue means an over-eager caps-lock rule gets caught and fixed, not silently annoying your best members.',
      'Regex filters run through a catastrophic-backtracking safeguard, so a bad pattern from a copy-pasted filter list can never hang the bot.',
    ],
    highlights: ['Dry-run mode', 'Raid detection', 'Regex safety checks', 'Review queue'],
  },
  enforcer: {
    headline: 'Policy-driven moderation where staff never have to confront a player directly.',
    whyGaming: [
      'The bot flags the message, shows the moderator the exact context, and the moderator just picks Warn, Timeout, Kick or Ban — the bot does the talking to the player.',
      'Every flag and every decision lands in a read-only ledger channel, so a competitive community can show sponsors and players a transparent, tamper-evident moderation record.',
      'Built for servers that run tournaments or paid coaching, where a single unfair-looking mod interaction can blow up in public — Enforcer keeps the process consistent and documented.',
      'Optional AI risk scoring is clearly labelled assistive-only; it never decides or acts on its own.',
    ],
    highlights: ['Flag → decide → ledger', 'Blind context capture', 'Full appeal trail', 'Assistive-only AI'],
  },
  logging: {
    headline: 'A quiet, searchable record of everything that happened in the server.',
    whyGaming: [
      'Scrims and tournaments generate channel and role changes fast; a searchable log means staff can reconstruct "what changed before the match started" in seconds.',
      'Message-content capture is off by default — logging tracks that an edit or delete happened without storing what was said unless a server explicitly opts in.',
      'Retention settings and CSV export make it easy for a community to keep only what it needs and hand a clean record to a co-owner or new head-mod.',
      'Bot errors and webhook failures get logged too, so staff find out about a broken integration before players do.',
    ],
    highlights: ['Privacy-first capture', 'Retention controls', 'Searchable', 'CSV export'],
  },
  tickets: {
    headline: 'Button-driven support tickets for player reports, appeals and recruitment.',
    whyGaming: [
      'A "Report a player" or "Appeal a ban" button turns a chaotic DM-the-mods workflow into a queue with assignment, tags and SLAs.',
      'Private channels or private threads keep sensitive reports (cheating accusations, harassment) out of public view while still giving staff a shared workspace.',
      'HTML and JSON transcripts mean a resolved ticket becomes a permanent, shareable record — useful for esports orgs that need to document rule enforcement.',
      'Optional modal intake forms collect the right details up front (match id, opponent, evidence link) instead of a back-and-forth in chat.',
    ],
    highlights: ['Button intake', 'Staff assignment', 'HTML/JSON transcripts', 'Tags & SLAs'],
  },
  roles: {
    headline: 'Self-serve roles, a real welcome mat, and a verification queue for gated servers.',
    whyGaming: [
      'Game/platform/region self-assignable role panels let a 10,000-member hub sort itself into the right voice channels and pings without a single ticket.',
      'Welcome and goodbye messages with a live preview help a community feel staffed even when no moderator is online to say hello.',
      'Verification with staff approval keeps out account-farmed bots and ban-evaders before they can post — critical for servers running paid tournaments.',
      "Role persistence (clearly disclosed to admins) means a player who left mid-season and rejoins doesn't lose their team or rank role.",
    ],
    highlights: ['Self-assign panels', 'Welcome/goodbye', 'Verification queue', 'Role persistence'],
  },
  engagement: {
    headline: 'Leveling, reputation and a starboard that reward the players who show up.',
    whyGaming: [
      'XP and leveling with anti-farming controls give casual and competitive members alike a reason to stick around between events.',
      'Reputation with cooldowns lets a community recognize helpful teammates and coaches without turning into a popularity-contest spam-fest.',
      'The starboard surfaces the best clips, memes and highlight plays the community reacts to, automatically — no manual curation channel needed.',
      'Temporary voice channels spin up an instant squad room on demand and clean themselves up when everyone leaves.',
    ],
    highlights: ['Anti-farm XP', 'Leaderboards', 'Starboard', 'Temp voice channels'],
  },
  community: {
    headline: 'Polls, giveaways, suggestions and event RSVPs for the whole server calendar.',
    whyGaming: [
      'Run a "which map next" poll or a scrim-night RSVP without leaving Discord, with anonymous or public voting depending on the moment.',
      'Giveaways with eligibility rules (minimum account age, required role) keep sponsor-funded prize drops fair and bot-resistant.',
      'A suggestions channel with voting and a staff status workflow turns "you should really add a LFG channel" comments into a tracked backlog instead of noise.',
      "Scheduled announcements and reminders keep a tournament bracket, patch-day watch party, or Discord-wide event on everyone's radar automatically.",
    ],
    highlights: ['Polls & giveaways', 'Suggestions board', 'Scheduled announcements', 'Event RSVPs'],
  },
  gamestats: {
    headline: 'Steam-linked leaderboards that turn a shared game into server bragging rights.',
    whyGaming: [
      'Members opt in by linking their public Steam profile, then the bot pulls real in-game stats — starting with Dead by Daylight — for a server leaderboard.',
      'Steam-only and said plainly: there is no public stats API for console platforms, so this never pretends to support them.',
      'Linking and unlinking is entirely self-service; a member controls their own data with no staff involvement or audit trail.',
      'Disabled by default and unavailable until the server owner configures a Steam Web API key — no guessing, no scraping.',
    ],
    highlights: ['Disabled by default', 'Steam-only, honestly', 'Self-service linking', 'Dead by Daylight leaderboard'],
  },
  economy: {
    headline: 'A virtual currency mini-game for engagement — never real money.',
    whyGaming: [
      'Daily claims and a give command add a light, optional progression layer that keeps casual members opening Discord.',
      'A server-wide leaderboard gives grinders something to chase that has nothing to do with skill rating.',
      'It is disabled by default and stays entirely virtual — no purchases, no cash-outs, no wagering, ever; see the compliance section below.',
      "Config lets an admin tune payouts (or turn it off entirely) so it fits a server's culture instead of dominating it.",
    ],
    highlights: ['Disabled by default', 'No real money, ever', 'Daily claims', 'Leaderboard'],
  },
  utility: {
    headline: 'The everyday toolbox: who is this, what time is it there, and is the bot even up.',
    whyGaming: [
      '`/userinfo` and `/roleinfo` give staff a fast lookup during a dispute without leaving Discord to check a spreadsheet.',
      '`/timestamp` and `/timezone` solve the classic "scrim is at 8pm in whose timezone?" problem for international rosters.',
      'An AFK status and a calculator round out the small conveniences that make a server feel maintained, not abandoned.',
      '`/status` shows bot and per-plugin health at a glance, so staff know immediately if something needs attention.',
    ],
    highlights: ['User/server info', 'Timestamps & timezones', 'AFK & reminders', 'Live status'],
  },
  media: {
    headline: 'Voice-channel playback for a legal, user-authorized audio source — optional.',
    whyGaming: [
      'Queue management, skip/pause/resume, volume and a DJ role give squad voice channels shared control over what is playing.',
      'The plugin is unavailable until a server sets `MEDIA_PROVIDER` to a compliant audio provider — it never scrapes or rips streams to work around that.',
      'When no provider is configured, `/plugin status` explains exactly why in plain language instead of the command silently failing.',
      'Disabled by default: this is an opt-in convenience feature, not a requirement to run the rest of the bot.',
    ],
    highlights: [
      'Optional / provider required',
      'No scraping, ever',
      'Queue & DJ role',
      'Clear status messaging',
    ],
  },
  integrations: {
    headline: 'Stream-live pings, your own Instagram posts, and webhook alerts, connected on your terms.',
    whyGaming: [
      'A Twitch or YouTube "going live" alert turns a scrim VOD or a member\'s stream into an automatic, on-brand server announcement.',
      "Connect the server's own Instagram account and new posts show up in a channel automatically — no one has to remember to cross-post.",
      'Generic inbound/outbound webhooks connect a tournament bracket tool, a Google Form, or an internal ops system without custom code.',
      'Every OAuth token is encrypted at rest and scoped to the minimum the feature needs — connect and disconnect anytime from the dashboard.',
      'Disabled by default; each connector only activates once a server explicitly connects it.',
    ],
    highlights: ['Disabled by default', 'Encrypted tokens', 'Twitch/YouTube/Instagram', 'Generic webhooks'],
  },
  ai: {
    headline: 'An optional AI helper for summaries and drafting — never a moderator.',
    whyGaming: [
      '`/summarize` catches a member up on a long strategy thread they missed, restricted to channels they can already read.',
      '`/mod-assist` suggests a moderation angle on a report for a human moderator to consider — it never performs the action itself.',
      'Per-server opt-in, per-channel allowlisting and per-user cooldowns keep it scoped and cheap to run instead of an always-on chat bot.',
      'Disabled by default, requires an admin-configured provider key, and is always disclosed as capable of being inaccurate.',
    ],
    highlights: [
      'Disabled by default',
      'Suggests, never acts',
      'Per-channel allowlist',
      'Provider key required',
    ],
  },
};
