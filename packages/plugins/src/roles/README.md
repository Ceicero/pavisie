# Roles, Onboarding & Verification (`roles`)

Self-assignable role panels, welcome/goodbye messages, an onboarding checklist with rules acknowledgement, and
member verification (instant button, staff-approved modal, or CAPTCHA). Disabled by default (SPEC.md §F).

## Commands

| Command                                                             | What it does                                                                                                                       | Who                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `/roles panel create`                                               | Creates a role panel (channel/style/group/max-selections as options, title/description via a form).                                | Moderator+                    |
| `/roles panel edit` \| `delete` \| `list` \| `post`                 | Manage panels; `post` (re)posts the panel message.                                                                                 | Moderator+                    |
| `/roles panel option-add` \| `option-remove`                        | Add/remove a role option. Blocked for elevated/managed/above-bot roles unless `allowElevatedRoles` is on.                          | Moderator+                    |
| `/roles group create` \| `edit` \| `delete` \| `list`               | Role groups: exclusive (max 1) or max-N selection, shared by any panel that references the group.                                  | Moderator+                    |
| `/roles persist on` \| `off` \| `status`                            | Toggle role persistence, with the disclosure text shown every time.                                                                | Admin                         |
| `/roles autorole add role:<role> [for:humans\|bots]`                | Add a role to the auto-role list (max 5 for humans, 3 for bots). Refuses elevated/managed/above-bot roles and says why.            | Admin                         |
| `/roles autorole remove` \| `delay` \| `enable`                     | Remove a role from the lists; set the delay in seconds (0 = immediately, max 7 days); turn auto-roles on/off.                      | Admin                         |
| `/roles autorole list`                                              | Show the current auto-role setup (status, human/bot lists, delay).                                                                 | Moderator+                    |
| `/welcome set` \| `embed` \| `test` \| `disable`                    | Configure the join message (channel/text/embed/DM). Template vars: `{user} {user.tag} {user.id} {server} {memberCount} {mention}`. | Moderator+                    |
| `/goodbye set` \| `embed` \| `test` \| `disable`                    | Same, for the leave message.                                                                                                       | Moderator+                    |
| `/verify`                                                           | Member-facing: runs the configured verification flow (button/modal/captcha).                                                       | Everyone                      |
| `/verification setup` \| `queue` \| `approve` \| `deny`             | Configure verification and review the modal-mode staff queue.                                                                      | Moderator+ (`setup` is Admin) |
| `/onboarding checklist`                                             | Ephemeral personal progress: rules, verification, roles picked, custom steps.                                                      | Everyone                      |
| `/onboarding config` \| `rules-post` \| `step-add` \| `step-remove` | Configure onboarding.                                                                                                              | Moderator+                    |
| "I agree" button on the posted rules                                | Records acceptance and grants `rulesRoleId` if set.                                                                                | Everyone                      |

## Config keys (`config.roles`)

`allowElevatedRoles`, `welcome{enabled,channelId,message,embed,dm}`, `goodbye{...same...}`, `rulesText`, `rulesRoleId`,
`steps[{id,label}]`, `verification{mode,questions[],verifiedRoleId,staffChannelId,minAccountAgeDays,underageAction,quarantineRoleId}`,
`rolePersistence{enabled,maxDays}`, `autoRoles{enabled,roleIds[≤5],botRoleIds[≤3],delaySeconds(0..604800)}`.

## Auto-roles on join

When `autoRoles.enabled` is on, every member who finishes joining (immediately for servers without membership
screening; otherwise once `member.pending` flips to false) gets `autoRoles.roleIds` (humans) or
`autoRoles.botRoleIds` (bot accounts). With `delaySeconds > 0` the grant is queued on `roles.autorole-apply`
(BullMQ, jobId `autorole-<guildId>-<userId>` so a leave+rejoin inside the window doesn't double-schedule); when it
fires, the member must still be present and not pending, and only roles that are still in the current config are
applied. Every grant re-runs `checkRoleAssignable` (elevated / managed / above the bot's top role are skipped),
drops roles the member already holds, and writes a `roles.autorole.apply` audit row with `after.roleIds`
(granted) and `after.skipped[{roleId, reason}]`. Dashboard/API edits write `roles.autorole.update`; `/roles
autorole *` writes go through `ctx.setConfig` (audited by the config store).

## Permissions & privileged intents

See `manifest.ts` `permissions` for the full table (Manage Roles, Send Messages, Embed Links required; Add
Reactions and Manage Channels/Kick Members optional with fallbacks). Declares `privilegedIntents: ['GuildMembers']`
— without it, welcome/goodbye, the account-age gate, and role persistence are unavailable (`/plugin status` reports
this plugin as degraded; `/health` reflects it too).

## Safety

Every role attached to a panel/group option, every auto-role, and every role toggled by a member, is checked
against `engine.ts`'s `checkRoleAssignable`: never Administrator/ManageGuild/ManageRoles/ManageChannels/
ManageWebhooks/KickMembers/BanMembers/ModerateMembers/MentionEveryone unless `allowElevatedRoles` is explicitly
on, never a managed (integration/bot) role, and never a role at or above the bot's own top role. Checked both at
`option-add`/`group create|edit`/`autorole add` time and again at toggle/select/reaction/auto-assignment time
(roles can change after a panel is created or an auto-role is configured). The dashboard/API cannot see role
hierarchy (no gateway), so auto-roles saved there are validated by the bot when they're actually assigned, and
any skips are recorded in the audit row.

## Privacy

- Verification (modal mode) stores submitted answers on the pending request until a staff decision.
- Role persistence, off by default, stores a filtered role snapshot (never elevated/managed roles) for up to
  the configured number of days after a member leaves, so it can restore them on rejoin. `/roles persist on`
  shows the disclosure text every time it's turned on.
- The account-age gate and membership screening only read `user.createdAt` and `member.pending` — nothing else
  is collected.
- Auto-roles store nothing about members; a delayed auto-role keeps only the member id (plus guild id and the
  role ids to grant) in a scheduled job until it fires, then the job is removed.

## CAPTCHA mode — Redis contract

CAPTCHA mode only activates when `CAPTCHA_PROVIDER` (`hcaptcha` or `turnstile`) is set. `/verify` writes
`pavisie:verify:pending:<token>` → `{"guildId","userId"}` (TTL 10 min) and replies with
`${API_BASE_URL}/verify/<token>`. The `/verify/:token` public web page (`apps/api/src/routes/verify.ts`, added
by the wiring stage) renders the configured provider's widget under a strict per-route CSP, verifies the
response server-side against the provider's `siteverify` endpoint, and on success writes
`pavisie:verify:done:<token>` (120s TTL — the poll job below deletes both keys once seen). If `CAPTCHA_PROVIDER`
is `none` (or the configured provider's site/secret keys aren't set), the page 404s with a plain explanation. The
`captcha-poll` job (`jobs/captcha-poll.ts`) scans for `pavisie:verify:done:*` every 15 seconds, resolves the
`{guildId,userId}` context, grants the verified role via `RolesService.verifyMember`, and deletes both keys.

## Bot-actions dispatch convention

`apps/bot/src/host/bot-actions.ts` dispatches every `bot-actions` job by calling the target service method with a
single merged object `{ guildId, payload, requestedBy }`, not the positional arguments
`RolesService.postPanel`/`testWelcome`/`verificationDecision` declare in `sdk/services.ts`. This plugin's
`service.ts` detects and supports both call shapes at runtime (dual-calling-convention wrappers around each core
implementation), so both dashboard-triggered actions (object shape) and in-process calls from other plugins
(positional shape, per the declared `RolesService` type) work correctly. The `tickets`, `ai`, `integrations`, and
`enforcer` plugins' services follow the same pattern for the same reason.

## Dashboard

`/dashboard/[guildId]/roles` — tabs: Panels (visual builder + post), Groups, Welcome & Goodbye (live embed
preview + test), Verification (settings + approval queue), Onboarding (rules + steps), Persistence (toggle with
disclosure), Auto-roles (enable switch, human/bot role pickers, delay, and the assignment-time re-check note;
`GET`/`PUT /guilds/:guildId/roles/autoroles`).
