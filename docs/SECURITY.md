# Security

This document is a threat model summary, a map of the controls already built into the codebase, a
vulnerability-reporting process, and the incident-response runbooks an operator (Brandon, or whoever
runs a deployment) follows when something goes wrong. It complements — doesn't replace — the security
recap in `docs/ARCHITECTURE.md` §15 and the compliance rules in `docs/SPEC.md`.

## 1. Threat model summary

**What we protect, in rough order of blast radius if it leaked:**

| Asset                                                                                            | Why it matters if compromised                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN` (bot token)                                                                      | Full control of the bot's Discord identity — read/send messages, moderate, in every server it's in.                                                                 |
| `ENCRYPTION_KEY`                                                                                 | Decrypts every OAuth token, webhook secret, and stored AI API key at rest across every server.                                                                      |
| OAuth access/refresh tokens (`OAuthToken.accessTokenEnc`/`refreshTokenEnc`)                      | Act as the Discord user (or connected integration account) who authorized them.                                                                                     |
| `SESSION_SECRET`                                                                                 | Signs dashboard session cookies — a leak lets an attacker forge a session for any user.                                                                             |
| Guild/member data (moderation cases, warnings, notes, Enforcer records, tickets, logs)           | Server-scoped moderation and behavioral history; some of it (staff notes, ticket transcripts, Enforcer excerpts) can contain sensitive free text about real people. |
| Webhook secrets (`WebhookEndpoint.secretEnc`)                                                    | Let an attacker forge inbound webhook deliveries or, for outbound endpoints, read what's being sent.                                                                |
| Third-party integration keys (Twitch, Google, Microsoft, Instagram, OpenAI/Anthropic, etc.)      | Scoped to whatever that provider's key grants — usually read access to public data or a connected account's data.                                                   |

**Who we're defending against:** opportunistic scanners hitting public endpoints, a malicious or
compromised guild member trying to escalate privilege or exfiltrate other members' data, a
compromised or careless staff member (hierarchy checks and confirmations exist specifically to make
one bad click by a real admin non-catastrophic), and credential leaks (accidental commits, log
exposure, a leaked `.env`). We are explicitly **not** trying to defend against a fully compromised
production host (an attacker with shell access on the API/bot container can already read
`process.env` and decrypt anything) — the controls below are about not making that box easier to
compromise in the first place, and about limiting damage if one _credential_ (not the whole host)
leaks.

**What we deliberately don't store**, because it can't leak if it isn't there: message content by
default (see `docs/PRIVACY_POLICY_TEMPLATE.md` for the full breakdown), plaintext secrets of any
kind, anything at all about donors (donations are a link out to Ko-fi — no payment page, no
webhook, no amount and no session id ever reaches us), and passwords (there are none; auth is
Discord OAuth only).

## 2. Controls

Each of these is implemented in code today, not aspirational — file references so you can verify:

- **Encryption at rest** — every `*Enc` field (`OAuthToken.accessTokenEnc`/`refreshTokenEnc`,
  `WebhookEndpoint.secretEnc`, the `ai` plugin's `PluginConfig.config.apiKeyEnc`) is AES-256-GCM
  encrypted with a 32-byte key from `ENCRYPTION_KEY`, format `v1:<iv>:<tag>:<ciphertext>` (all
  base64). Decrypted only in-process, only where used. `packages/core/src/crypto/encryption.ts`.
- **Sessions** — dashboard auth is a random 32-byte `sid` cookie (`httpOnly`, `sameSite`, `secure` in
  production) mapping to a Redis hash (`pavisie:session:<sid>`, 7-day TTL) holding the user id and
  encrypted OAuth tokens. Nothing about the session is trusted from the client except the opaque id.
  `apps/api/src/routes/auth.ts`, ARCHITECTURE §10.
- **CSRF** — every mutating dashboard API route requires the `X-CSRF-Token` header to match the
  session's csrf token (handed out by `GET /auth/me`), and the `Origin`/`Referer` header (when
  present) must be in the allowlist (`DASHBOARD_URL`, `WEB_URL`). A stolen cookie alone isn't enough
  to make a state-changing request cross-site.
- **Origin allowlist** — CORS is a strict `[DASHBOARD_URL, WEB_URL]` allowlist, not a wildcard.
- **Signature verification** — every inbound webhook (Discord interactions, GitHub, generic, Twitch
  EventSub) is verified with a constant-time HMAC/ed25519 check against the raw request body before
  anything in it is trusted. `packages/core/src/crypto/signatures.ts`.
- **SSRF guard** — any outbound URL the platform fetches based on user/admin input (webhook targets,
  integration callbacks) is checked with `assertPublicHttpUrl`: resolves DNS, rejects private/
  loopback/link-local/metadata-service IPs and non-standard ports. `packages/core/src/utils/ssrf.ts`.
- **Rate limits** — global Fastify rate limiting (300/min/IP, auth routes 20/min), plus a bot-side
  global 20 commands/10s per user, plus per-command cooldowns where configured
  (`requirement.cooldown`). Redis sliding-window implementation in `packages/core/src/ratelimit.ts`.
- **Hierarchy checks** — every moderation action (bot or dashboard-triggered) runs through
  `checkModerationTarget` before it executes: refuses to act on the actor themself, the bot, the
  guild owner, a bot owner, or anyone at or above the actor's/bot's own role position.
  `packages/core/src/permissions/hierarchy.ts`.
- **Confirmations** — destructive actions (kick/ban/softban/large purge/bulk role changes/ticket
  delete/data delete) require an explicit Confirm/Cancel button click (60s timeout) before executing,
  unless the guild has opted into `fastActions` for lower-risk cases. `packages/plugins/src/sdk/confirm.ts`.
- **Regex safety** — any user-supplied regex (automod rules, Enforcer policy matchers) is validated
  with `validateUserRegex` (length cap, `safe-regex2` catastrophic-backtracking heuristic, no
  deeply-nested lookbehind) before it can be saved, and matching at runtime always truncates the
  input first (`safeTest`). `packages/core/src/utils/safe-regex.ts`.
- **HTML escaping** — ticket transcripts and any other HTML we generate escape user content
  (`escapeHtml`) and render inside a strict CSP `<meta>` tag, so a message full of `<script>` tags
  can't execute when a staff member opens a transcript.
- **Idempotency** — inbound webhooks are deduplicated by `ProcessedWebhookEvent`
  (`@@unique([provider, eventId])`) before being enqueued, so a provider's at-least-once delivery
  retry can't double-process a payment or double-fire an integration event.
- **No content logging by default** — `GuildConfig.logMessageContent` and `dataCollectionEnabled`
  both default to `false`; pino's redact paths (`packages/core/src/logger.ts`) strip tokens,
  passwords, secrets, and message content from every log line even if a bug tried to log them.
- **Least-privilege bot invite** — `INVITE_PERMISSIONS` never includes `Administrator`; every plugin
  declares exactly the Discord permissions it needs in its manifest, auditable via `/permissions
audit`.

## 3. Reporting a vulnerability

Security contact: `contact@pavisie.com` (confirmed and monitored — the project's general contact
mailbox, also used by the policy pages).

If you find a security issue: email `contact@pavisie.com` with what you found, how to reproduce
it, and its potential impact. Please don't open a public GitHub issue for anything that could be
actively exploited before a fix ships (encryption bugs, auth bypasses, SSRF/RCE-class findings) —
issues not already covered by the controls in §2 (e.g. a genuinely new bypass, not "the bot could
theoretically ban someone" which is expected behavior for a moderation bot) are the kind worth a
private report first.

## 4. Incident response runbooks

Rotate on suspicion, not on proof — waiting for evidence of misuse before rotating a leaked credential
just extends the exposure window for no benefit.

### 4.1 Compromised bot token

**Signal**: the bot behaves in a way you didn't configure (posts you didn't send, permission changes,
servers it shouldn't be in), or `DISCORD_TOKEN` appeared somewhere it shouldn't have (a public commit,
a shared screenshot, a support ticket).

1. Discord Developer Portal → your application → **Bot** → **Reset Token**. This invalidates the old
   token immediately — the bot goes offline the instant you do this, which is the point.
2. Set the new token as `DISCORD_TOKEN` on the `bot` service's environment and restart it (see
   `infra/DEPLOYMENT.md` §7 for the exact steps per hosting platform).
3. Once the bot reconnects, review recent audit log entries (`/audit` in the dashboard or `/logs
search`) for anything unexpected the old token might have done while compromised.
4. If you suspect the leak happened via a specific commit or log, also rotate anything else that
   might have been exposed alongside it — leaks are rarely single-secret.

### 4.2 Leaked `ENCRYPTION_KEY`

**Signal**: `ENCRYPTION_KEY` appeared somewhere it shouldn't have. This is the highest-blast-radius
secret — treat it seriously even on suspicion alone.

1. Generate a new key: `openssl rand -base64 32`.
2. Set the **old** key as `ENCRYPTION_KEY_PREVIOUS` and the **new** key as `ENCRYPTION_KEY` on both
   `bot` and `api`. Doing both in the same change (not sequentially) matters: `decryptSecret()`
   already tries `ENCRYPTION_KEY` first and falls back to `ENCRYPTION_KEY_PREVIOUS` on failure
   (`packages/core/src/crypto/encryption.ts`), so every row stays readable through the transition
   regardless of which key it was originally written under.
3. Restart `bot` and `api`. From this point, every **new** write (a new OAuth token, a new webhook
   secret, a fresh `/ai config set-key`) is encrypted under the new key automatically — no extra step
   needed for new data.
4. Run the re-encryption script once to migrate everything still encrypted under the old key:
   ```
   pnpm --filter @pavisie/database reencrypt:secrets
   ```
   This walks `OAuthToken.accessTokenEnc`/`refreshTokenEnc`, `WebhookEndpoint.secretEnc`, and the
   `ai` plugin's `PluginConfig.config.apiKeyEnc`, decrypting each (via the same primary-then-previous
   fallback) and re-encrypting under the current `ENCRYPTION_KEY`. It's idempotent and safe to
   re-run; use `--reencrypt:secrets -- --dry-run` (i.e. `pnpm --filter @pavisie/database exec tsx
scripts/reencrypt-secrets.ts --dry-run`) first if you want a preview without writing anything. The
   script is `packages/database/scripts/reencrypt-secrets.ts` — if a future encrypted field is added
   to the schema or a plugin's config, add it to that script's coverage.
5. Once the script reports zero failures, remove `ENCRYPTION_KEY_PREVIOUS` (leaving it set
   indefinitely means the compromised key can still decrypt anything an attacker captured mid-
   rotation) and restart `bot`/`api` one more time.
6. If the leak was severe enough that you believe an attacker actually captured encrypted values
   _and_ the key before you rotated, treat every credential those values represented (every
   connected OAuth account, every webhook secret, every stored AI API key) as compromised too, and
   have affected users/integrations re-authenticate or roll their own keys.

### 4.3 (retired) Compromised Stripe keys / webhook secret

The guild-facing Stripe integration connector was removed 2026-09-02 (`docs/ARCHITECTURE.md` §18a) —
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the `/webhooks/stripe` route no longer exist, so there is
nothing left to rotate here. Left as a numbered placeholder rather than renumbering §4.4+ out from under any
existing link to them.

### 4.4 Dashboard session invalidation

Use this when you want to force everyone signed out without a full `SESSION_SECRET` rotation — e.g.
you suspect a specific stolen cookie rather than a leaked signing key, or you just want a clean slate
after a config change.

```
redis-cli --scan --pattern 'pavisie:session:*' | xargs -r redis-cli del
```

On a managed Redis (Railway/Render), run this from a shell with `REDIS_URL` set:
`redis-cli -u "$REDIS_URL" --scan --pattern 'pavisie:session:*' | xargs -r redis-cli -u "$REDIS_URL" del`.
Every dashboard user has to log in again on their next request; nothing else is affected (guild data,
moderation history, etc. are untouched — sessions are pure Redis state).

If you additionally suspect `SESSION_SECRET` itself leaked (not just one stolen cookie), rotate it
too — see `infra/DEPLOYMENT.md` §7 — which invalidates every session cookie's signature outright and
makes this Redis flush redundant (but harmless to also run).

## 5. Dependency updates

- CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile` against the committed
  lockfile on every push and PR — there's no silent drift between what's declared and what's
  installed.
- Review Dependabot/`npm audit`-style alerts for `apps/*` and `packages/*` regularly, prioritizing
  anything touching `discord.js`, `fastify`, `@fastify/*`, `prisma`, or `next` (the security-sensitive
  edges: auth, HTTP handling, DB access, and the framework serving public traffic).
- Bump the version in `docs/ARCHITECTURE.md` §2's pinned-range table when you deliberately move a
  major version, so the table stays the source of truth for what's actually running.
- After any dependency bump, the full gate still applies before merging: `pnpm lint && pnpm
typecheck && pnpm test && pnpm build` (this is exactly what CI runs).

## 6. Incident history

**2026-08-26 — donation endpoint abused for card testing.** The public `POST /donations/checkout` endpoint
received roughly 125 rapid checkout attempts, each for exactly $1.00 — matching the then-default
`DONATION_MIN_CENTS`. This matches a known "card testing" pattern, where stolen card numbers are probed for
validity via small charges rather than genuine purchases. Stripe flagged the pattern and suspended the
account. No donor personal data was exposed — Stripe Checkout is the only party that ever sees payment details.

**Resolution (2026-08-30):** Rather than defend the checkout endpoint against ongoing abuse, donations were moved
entirely to Ko-fi, a third-party donation platform. Pavisie no longer processes payments at all. This removes
the entire card-testing attack surface instead of just hardening one endpoint. The `POST /donations/checkout`
endpoint is gone; the `/donations/config` route returns a simple link to Ko-fi when configured. This also
eliminated the need for the hardening controls below — they were situational defenses against a payment-processing
role Pavisie no longer plays.

Earlier hardening (archived for reference, no longer in effect):

- Donation amounts were locked to a fixed preset list (`DONATION_PRESETS_CENTS`).
- `POST /donations/checkout` required a CAPTCHA token verified server-side before anything else ran.
- A global hourly ceiling capped checkout attempts across all callers combined.
- API rate limiting moved to a Redis-backed store shared across instances and restarts.
