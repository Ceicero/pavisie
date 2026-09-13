# Privacy policy template (operator-facing)

This is a **template for the operator** ([Operator]) to review, fill in, and adapt before treating it
as a real privacy policy — it is not itself the live policy shown to end users. The live, shorter
policy end users actually see is rendered on the website's `/privacy` page from
`apps/web/src/content/legal.ts` (`privacyPolicy(operator, contactEmail)`), with a visible banner on
that page saying it's a template. **This document and that page must describe the same data
categories** — this one just goes deeper, mapping each category to the actual database models so an
operator (or their counsel) can verify the plain-language description against what's really stored.

Replace every bracketed placeholder — `[Operator]`, `[Contact]`, `[Jurisdiction]` — before publishing
this anywhere as a real policy. **A generic template is not a substitute for one reviewed by someone
qualified for your jurisdiction and your specific deployment** (what plugins you've enabled, what
data collection you've turned on, what integrations you've connected).

## 1. Who this covers

This policy explains what **[Operator]** collects when you use the Pavisie Discord bot named
**[Bot name]**, its dashboard, and its companion website, and why. It does not cover Discord itself —
see Discord's own Privacy Policy and Terms of Service for that; using this bot at all requires having
a Discord account and agreeing to Discord's terms.

## 2. What the bot stores, by feature

Pavisie is modular — every plugin below is optional, and a server administrator controls which are
enabled from the dashboard (`/dashboard/[guildId]/plugins`) or with `/plugin enable|disable`. Nothing
in a disabled plugin's row is ever written. Every row below is scoped to the Discord server (guild)
it was created in, and is deleted when that server removes the bot (`Guild` deletion cascades to
everything below it — see `docs/ARCHITECTURE.md` §8).

| Feature / plugin                                         | What's stored                                                                                                                                                                                                                                                                                                                                                                                                                                    | Model(s)                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Moderation                                               | Case records: type (warn/timeout/kick/ban/etc.), target and moderator Discord ids, reason text, evidence **links** (never files/screenshots automatically), duration, timestamps                                                                                                                                                                                                                                                                 | `ModerationCase`                                                                                         |
| Moderation — warnings                                    | Warning text, target/moderator ids, timestamp                                                                                                                                                                                                                                                                                                                                                                                                    | `ModerationWarning`                                                                                      |
| Moderation — staff notes                                 | Free-text notes staff write about a member — intentionally kept for staff visibility; not shown to the member                                                                                                                                                                                                                                                                                                                                    | `ModerationNote`                                                                                         |
| Moderation — appeals                                     | The appeal text a member submits, the case it's tied to, and the decision                                                                                                                                                                                                                                                                                                                                                                        | `ModerationAppeal`                                                                                       |
| Enforcer (disabled by default)                           | A sanitized excerpt of a flagged message, and — only when "Capture context" is on (on by default _when Enforcer itself is enabled_) — a short snapshot of the messages immediately before the flagged one, so a moderator has context without confronting the reporting member directly                                                                                                                                                          | `EnforcerRecord` (`excerpt`, `contextSnapshot`)                                                          |
| Logging                                                  | Metadata about server events (who joined/left, what was edited/deleted, when) by default; the message **text** of an edit/delete is only captured when both the server-wide "Log message content" setting and this plugin's own "Capture content" setting are on                                                                                                                                                                                 | `LogEvent`                                                                                               |
| Tickets                                                  | Full ticket transcript (message history, including text) so the ticket opener and staff have a record of what was discussed; intake form answers if a panel collects them                                                                                                                                                                                                                                                                        | `Ticket`, `TicketTranscript`, `TicketParticipant`                                                        |
| Roles / verification                                     | Verification request answers (if using the modal flow) until a staff decision is made; an optional snapshot of a leaving member's roles (if role persistence is turned on) to restore them on rejoin                                                                                                                                                                                                                                             | `VerificationRequest`, `MemberRoleSnapshot`                                                              |
| Leveling / engagement                                    | Aggregate counters only — XP, level, message count, voice minutes — never message content; who gave reputation to whom plus an optional short free-text reason; a link to a starred message (and, only with the Message Content intent enabled, the message text itself is echoed into the starboard embed)                                                                                                                                      | `LevelProfile`, `ReputationEvent`, `StarboardEntry`                                                      |
| Community (polls/giveaways/suggestions/reminders/events) | Poll votes (anonymous polls never store or display who voted for which option — only per-option counts), giveaway entries, suggestion text and votes, reminder text until it's delivered or cancelled, event RSVPs                                                                                                                                                                                                                               | `Poll`, `PollVote`, `Giveaway`, `GiveawayEntry`, `Suggestion`, `Reminder`, `CommunityEvent`, `EventRsvp` |
| Community — tags / auto-responders                       | The text/embed staff wrote for each tag, its optional trigger phrase, and a use counter. Auto-responder triggers compare incoming messages against the trigger phrases **in memory**, and only when the bot has the Message Content intent enabled — the messages themselves are never stored or logged                                                                                                                                          | `Tag`                                                                                                    |
| Community — sticky messages                              | The staff-written text/embed for the channel's sticky, the id of the bot's own last posted copy, and the staff member who created it. Never reads or stores member message content — the bot only reacts to the fact that a message was posted. Removed via `/sticky remove`, when its channel is deleted, or when the server's data is deleted                                                                                                  | `StickyMessage`                                                                                          |
| Community — birthdays                                    | Only the **month and day** a member chooses to share, per server, until the member removes it or the server's data is deleted — no year, no age (there is no field for it); the bot never DMs about birthdays                                                                                                                                                                                                                                    | `Birthday`                                                                                               |
| Integrations                                             | OAuth access/refresh tokens, **encrypted at rest** (AES-256-GCM), decrypted only in-process to make an API call on your behalf; webhook secrets, also encrypted at rest and shown in plaintext exactly once at creation                                                                                                                                                                                                                          | `OAuthToken` (`accessTokenEnc`, `refreshTokenEnc`), `WebhookEndpoint` (`secretEnc`)                      |
| AI assistant (disabled by default)                       | If a server admin sets their own API key, it's encrypted at rest the same way; usage counters (not full prompts/responses) for budget tracking. If mention chat is turned on for a channel, @mentioning the bot there sends that message plus up to a configured number of recent messages from the same channel (redacted, same as everything else) to the configured provider for that one reply — nothing beyond the usage counters is stored | `PluginConfig` (`ai` plugin's `apiKeyEnc`, `chat.*`), `AiUsage`                                          |
| Economy (disabled by default)                            | Virtual-currency balances and transaction history — **no real money involved, ever**; not personal data beyond the Discord user id                                                                                                                                                                                                                                                                                                               | `EconomyAccount`, `EconomyTransaction`                                                                   |
| Donations                                                | None — donations are handled entirely by Ko-fi (a third-party donation platform). Pavisie stores no information about donors, donations, or personal data from donations; Ko-fi's own privacy policy covers their collection.                                                                                                                                                                                                                   | (no table — donations processed externally by Ko-fi)                                                      |
| Dashboard sign-in                                        | Discord user id, username, avatar, and which servers you manage — just enough to determine what you're allowed to configure; a session cookie and (encrypted) OAuth tokens                                                                                                                                                                                                                                                                       | Redis session hash, `OAuthToken`                                                                         |
| Every configuration change                               | Actor, timestamp, and a redacted before/after diff, for every setup wizard run, `/config set`, or plugin enable/disable                                                                                                                                                                                                                                                                                                                          | `AuditLog`                                                                                               |

## 3. What is NOT stored by default

**Message content is never stored by default.** A server has to explicitly enable a specific feature
that needs it — logging's "Capture content," Enforcer's "Capture context," or the starboard's echo
(which additionally requires the bot to have the Message Content privileged intent enabled at all) —
before any message text is written anywhere. Deleted/edited-message logging without that toggle
records only that the event happened (who, when, where), not what the message said. Passwords are
never collected (there are none — auth is Discord OAuth only), and card/payment details never reach
[Operator]'s servers at all (see §4).

## 4. Donations

Donations are handled entirely by Ko-fi, a third-party donation platform. When a visitor clicks the donate link,
they are taken to the operator's Ko-fi page. Ko-fi processes the payment and collects whatever information their
service requires. **[Operator]'s servers never receive any information about the donation or the donor** — not a
name, email, payment details, amount, or any other data. Ko-fi's own privacy policy governs what information they
collect, retain, and how they use it; [Operator] is not responsible for Ko-fi's data handling. If the operator is
concerned about donation privacy, they should review Ko-fi's privacy policy before asking their community to use it.

## 5. Retention defaults and admin controls

Retention periods are configurable per server from the dashboard's Privacy settings
(`/dashboard/[guildId]/privacy`, backed by `DataRetentionPolicy`) or `/logs retention`. Sensible
defaults ship out of the box (for example, ticket transcripts default to 90 days —
`transcriptRetentionDays`); a server admin can shorten or lengthen most windows, subject to the
overall data retention policy for that server. A scheduled job (`runRetentionForGuild`,
`packages/database/src/retention.ts`) purges records past their retention window automatically —
retention isn't just a promise, it runs.

## 6. Export and delete

From `/dashboard/[guildId]/privacy`, a server administrator can:

- **Export** the server's data (`POST /guilds/:guildId/data/export`) — queues a job that produces a
  downloadable JSON file of that server's records.
- **Delete** the server's data (`POST /guilds/:guildId/data/delete`) — requires typing a confirmation
  phrase, then queues a deletion job. Because every tenant table cascades from `Guild`, removing the
  bot from a server (or an explicit delete request) removes that server's data, not just marks it
  hidden.
- View the status of past export/delete requests (`GET /guilds/:guildId/data/requests`,
  `DataRequest` model).

An individual Discord user who wants their own data addressed (rather than a whole server's) should
contact **[Contact]** — most of what's stored is server-scoped moderation/community history that only
that server's administrators can act on directly, but requests about dashboard account data (session,
cached guild list) can be handled centrally.

## 7. Third parties

Data is shared only with the services required to operate the features actually in use:

- **Discord** — the platform itself; using the bot at all means Discord processes the underlying
  messages/events per its own policies.
- **Ko-fi** — donations only (see §4); the operator's Ko-fi page is where donations are processed and
  the visitor's data (if any is collected) goes directly to Ko-fi, not to [Operator]'s servers.
- **Optional integrations a server administrator explicitly connects**: Twitch, YouTube, Instagram,
  Reddit, Steam, Google, or Microsoft (via the `integrations` plugin — only the specific
  provider(s) a server connects, and only the scopes that connection grants); an AI provider (OpenAI
  or Anthropic) if the `ai` plugin is enabled and configured with a key; a translation provider
  (DeepL or LibreTranslate) or weather provider (OpenWeatherMap, or Open-Meteo which needs no key at
  all) if the `utility` plugin's translate/weather commands are configured to use one.

No data is sold, and nothing is shared with any party not listed here or not explicitly connected by
a server administrator.

## 8. Children / age requirement

Pavisie runs entirely on top of Discord, and Discord's own Terms of Service require users to be at
least 13 years old (or the higher minimum age required in some jurisdictions — Discord enforces this,
not this bot). [Operator] does not knowingly collect data from anyone below the applicable minimum
age and relies on Discord's own age-gating rather than performing separate age verification.

## 9. Contact

Questions about this policy, or a request not covered by the dashboard's export/delete tools above:
**[Contact]**. For jurisdiction-specific rights (e.g. GDPR/CCPA-style access, correction, or deletion
requests), also see **[Jurisdiction]**-specific guidance you (the operator) add here once you've had
this reviewed.

## 10. Keeping this in sync with the live `/privacy` page

If you add a plugin, change what a plugin stores, or connect a new integration, update **both**:

1. This file (`docs/PRIVACY_POLICY_TEMPLATE.md`) — the detailed, model-mapped version.
2. `apps/web/src/content/legal.ts`'s `privacyPolicy()` — the shorter version end users actually see
   on `/privacy`. Keep it monochrome (it inherits the website's plain black/grey/white design tokens
   from `docs/ARCHITECTURE.md` §17 — don't add color or restyle the page itself); just make sure the
   data categories mentioned there still match this file's §2 table.

Both currently describe the same categories: bot-side per-feature storage with message content off
by default, dashboard OAuth sign-in data, donations with no personal data collected, retention +
admin export/delete controls, the same third-party list (Discord, Ko-fi, optional integrations
including AI/translate/weather providers), and the Discord-inherited 13+ age floor.
