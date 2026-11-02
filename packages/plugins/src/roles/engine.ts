// Pure, discord.js-free logic for the roles plugin: elevated-role safety, template rendering, group
// selection resolution, the account-age gate, and role-persistence snapshot filtering. Kept separate from
// service.ts (which needs live discord.js/Prisma objects) so all of this can be unit tested directly.
import { PermissionFlagsBits } from 'discord-api-types/v10';

/** Discord permissions that a self-assignable role must never grant unless `config.allowElevatedRoles` is on (SPEC.md §F). */
export const ELEVATED_PERMISSION_FLAGS: readonly bigint[] = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
];

/** True if `permissionsBitfield` grants any permission in `ELEVATED_PERMISSION_FLAGS`. */
export function isElevatedPermissionBitfield(permissionsBitfield: bigint): boolean {
  return ELEVATED_PERMISSION_FLAGS.some((flag) => (permissionsBitfield & flag) === flag);
}

export interface RoleAssignabilityInput {
  /** The candidate role's permission bitfield. */
  permissionsBitfield: bigint;
  /** The candidate role's position in the guild's role list (higher = more senior). */
  position: number;
  /** True if the role is managed by an integration/bot (Discord never allows manually assigning these anyway). */
  managed: boolean;
  /** The bot's own highest role position in the guild. */
  botTopRolePosition: number;
  /** Guild's `roles.allowElevatedRoles` config flag. */
  allowElevatedRoles: boolean;
}

export type RoleAssignabilityReason = 'elevated' | 'managed' | 'hierarchy';
export type RoleAssignabilityResult = { ok: true } | { ok: false; reason: RoleAssignabilityReason };

/**
 * Guards a role from being attached to a self-assignable panel/group option, or actually toggled onto a member,
 * per SPEC.md §F "Safety": never an elevated-permission role unless explicitly allowed, never a managed role, and
 * always below the bot's own top role (so the bot can actually add/remove it). Checked at option-add time AND at
 * toggle time (roles can change after a panel is created).
 */
export function checkRoleAssignable(input: RoleAssignabilityInput): RoleAssignabilityResult {
  if (input.managed) {
    return { ok: false, reason: 'managed' };
  }
  if (!input.allowElevatedRoles && isElevatedPermissionBitfield(input.permissionsBitfield)) {
    return { ok: false, reason: 'elevated' };
  }
  if (input.position >= input.botTopRolePosition) {
    return { ok: false, reason: 'hierarchy' };
  }
  return { ok: true };
}

export interface ActorRoleManageInput {
  /** The candidate role's position. */
  rolePosition: number;
  /** The acting staff member's highest role position (undefined if it couldn't be resolved). */
  actorTopRolePosition: number | undefined;
  /** True if the actor owns the guild (owners bypass hierarchy, as in Discord itself). */
  actorIsOwner: boolean;
}

/**
 * Config-time guard: a staff member may only attach a role to a self-assign panel / auto-role list if that role is
 * strictly below their own highest role (or they own the guild). Without this, a moderator-level staff member could
 * expose a role above their own for self-assignment and escalate themselves. Fails closed when the actor's position
 * is unknown.
 */
export function canActorManageRole(input: ActorRoleManageInput): boolean {
  if (input.actorIsOwner) return true;
  if (input.actorTopRolePosition === undefined) return false;
  return input.rolePosition < input.actorTopRolePosition;
}

// ---------------------------------------------------------------------------
// Auto-roles on join
// ---------------------------------------------------------------------------

/** The `autoRoles` config section shape (mirrors `manifest.ts`'s `autoRolesSchema`; kept structural so this file stays free of zod/discord.js). */
export interface AutoRolesConfigLike {
  enabled: boolean;
  roleIds: string[];
  botRoleIds: string[];
  delaySeconds: number;
}

/** Picks which auto-role list applies to a joining member: `botRoleIds` for bot accounts, `roleIds` for humans. Returns `[]` when auto-roles are disabled. Duplicates are collapsed. */
export function selectAutoRoles(input: { isBot: boolean; config: AutoRolesConfigLike }): string[] {
  if (!input.config.enabled) return [];
  const list = input.isBot ? input.config.botRoleIds : input.config.roleIds;
  return [...new Set(list)];
}

// ---------------------------------------------------------------------------
// Template rendering (welcome/goodbye messages + embeds)
// ---------------------------------------------------------------------------

export interface TemplateVars {
  user: string;
  'user.tag': string;
  'user.id': string;
  server: string;
  memberCount: string | number;
  mention: string;
}

const TEMPLATE_TOKEN_PATTERN = /\{([a-zA-Z._]+)\}/g;

/**
 * Renders `{user}`, `{user.tag}`, `{user.id}`, `{server}`, `{memberCount}`, `{mention}` tokens in `template`
 * against `vars`. Unknown tokens (typos, or anything not in `vars`) are left literal — never evaluated, never
 * treated as code — so this is safe against injection: the output is always plain text derived only from the
 * fixed variable set, substituted verbatim (no recursive re-substitution of a variable's own value).
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(TEMPLATE_TOKEN_PATTERN, (whole, token: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, token)) {
      return String(vars[token as keyof TemplateVars]);
    }
    return whole;
  });
}

/** Recursively renders every string value inside an arbitrary embed-shaped object (title, description, fields, footer text, etc). */
export function renderTemplateDeep<T>(value: T, vars: TemplateVars): T {
  if (typeof value === 'string') {
    return renderTemplate(value, vars) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateDeep(item, vars)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderTemplateDeep(val, vars);
    }
    return out as T;
  }
  return value;
}

/** Largest value Discord accepts for `embeds[].color` (0xFFFFFF). */
const EMBED_COLOR_MAX = 0xff_ff_ff;

const EMBED_COLOR_HEX_PATTERN = /^#?[0-9a-fA-F]{6}$/;

/**
 * Coerces a stored embed `color` into the integer Discord's API requires (it answers `400 BASE_TYPE_INT` for a
 * string and drops the whole message). `welcome.embed`/`goodbye.embed` are free-form Json columns and earlier
 * builds of both writers persisted `#rrggbb` text, so live guild configs hold either shape. Anything that isn't
 * a usable colour returns undefined — a bad colour must cost the guild its colour, never its welcome message.
 */
export function normalizeEmbedColor(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= EMBED_COLOR_MAX ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!EMBED_COLOR_HEX_PATTERN.test(trimmed)) return undefined;
  return parseInt(trimmed.replace(/^#/, ''), 16);
}

/** Formats a stored embed colour (integer, or legacy `#rrggbb` text) back into the hex the embed modal shows. Empty string when there's no usable colour. */
export function formatEmbedColorHex(value: unknown): string {
  const color = normalizeEmbedColor(value);
  return color === undefined ? '' : `#${color.toString(16).padStart(6, '0')}`;
}

/** Returns `embed` with its `color` normalised to an integer, dropping the key entirely when the stored value is unusable. */
export function normalizeStoredEmbed(embed: Record<string, unknown>): Record<string, unknown> {
  if (!('color' in embed)) return embed;
  const { color: stored, ...rest } = embed;
  const color = normalizeEmbedColor(stored);
  return color === undefined ? rest : { ...rest, color };
}

// ---------------------------------------------------------------------------
// Role group exclusivity / max-selection resolution
// ---------------------------------------------------------------------------

export interface RoleGroupLike {
  roleIds: string[];
  exclusive: boolean;
  maxSelections: number | null;
}

export interface GroupSelectionResult {
  /** Roles to add (already filtered to ones the member doesn't have). */
  toAdd: string[];
  /** Roles to remove because the group is exclusive/max-selection-limited and they're being displaced. */
  toRemove: string[];
  /** True if the requested selection had to be truncated to fit `maxSelections`. */
  truncated: boolean;
}

/**
 * Resolves what a member's group-scoped roles should become after they pick `requestedRoleIds` from a
 * `RoleGroup`, given the roles from that group they currently hold (`currentGroupRoleIds`). Exclusive groups
 * (`exclusive: true`) behave as max-1; otherwise `maxSelections` (if set) caps how many of the group's roles a
 * member may hold at once, keeping the earliest-requested selections and dropping the rest.
 */
export function resolveGroupSelection(
  group: RoleGroupLike,
  requestedRoleIds: string[],
  currentGroupRoleIds: string[],
): GroupSelectionResult {
  const groupRoleSet = new Set(group.roleIds);
  const requested = requestedRoleIds.filter((id) => groupRoleSet.has(id));
  const cap = group.exclusive ? 1 : (group.maxSelections ?? requested.length);

  const truncated = requested.length > cap;
  const kept = requested.slice(0, Math.max(0, cap));
  const keptSet = new Set(kept);

  const toAdd = kept.filter((id) => !currentGroupRoleIds.includes(id));
  const toRemove = currentGroupRoleIds.filter((id) => groupRoleSet.has(id) && !keptSet.has(id));

  return { toAdd, toRemove, truncated };
}

// ---------------------------------------------------------------------------
// Account-age gate
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** True if `accountCreatedAt` is old enough to satisfy `minAccountAgeDays` as of `now` (0 = gate disabled, always passes). */
export function passesAccountAgeGate(
  accountCreatedAt: Date,
  minAccountAgeDays: number,
  now: Date = new Date(),
): boolean {
  if (minAccountAgeDays <= 0) return true;
  const ageMs = now.getTime() - accountCreatedAt.getTime();
  return ageMs >= minAccountAgeDays * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Role-persistence snapshot filtering
// ---------------------------------------------------------------------------

export interface PersistableRoleFilterInput {
  roleIds: string[];
  /** Ids of roles that are elevated-permission (per `isElevatedPermissionBitfield`) in this guild. */
  elevatedRoleIds: ReadonlySet<string>;
  /** Ids of roles that are integration/bot-managed. */
  managedRoleIds: ReadonlySet<string>;
  /** The guild's `@everyone` role id, always excluded (every member has it implicitly). */
  everyoneRoleId: string;
}

/** Filters a member's role list down to the ones safe to snapshot for role persistence (SPEC.md §F): never elevated, never managed, never @everyone. */
export function filterPersistableRoles(input: PersistableRoleFilterInput): string[] {
  return input.roleIds.filter(
    (id) => id !== input.everyoneRoleId && !input.elevatedRoleIds.has(id) && !input.managedRoleIds.has(id),
  );
}

/** True if a role snapshot taken at `leftAt` is still within `maxDays` of `now` and thus eligible to be restored. */
export function isSnapshotFresh(leftAt: Date, maxDays: number, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - leftAt.getTime();
  return ageMs <= maxDays * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Verification request state machine
// ---------------------------------------------------------------------------

export type VerificationRequestStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

/** Only a `PENDING` request may be decided — guards against two moderators acting on the same request twice (SPEC.md §F). */
export function canDecideVerification(status: VerificationRequestStatus): boolean {
  return status === 'PENDING';
}

/** Maps an approve/deny decision to the resulting `VerificationRequest.status`. */
export function nextVerificationStatus(approve: boolean): 'APPROVED' | 'DENIED' {
  return approve ? 'APPROVED' : 'DENIED';
}

// ---------------------------------------------------------------------------
// Onboarding progress (stored in `OnboardingProgress.steps`, a free-form Json column)
// ---------------------------------------------------------------------------

/** Shape written into `OnboardingProgress.steps` — a free-form Json column, so this is a convention this plugin owns, not a schema constraint. */
export interface OnboardingProgressData {
  /** Per-custom-step (from `config.steps`) completion, keyed by step id. */
  customSteps: Record<string, boolean>;
  verifiedAt?: string;
  rolesPickedAt?: string;
}

export function emptyOnboardingProgress(): OnboardingProgressData {
  return { customSteps: {} };
}

/** Defensively parses a Prisma `Json` value back into `OnboardingProgressData`, tolerating `null`/malformed data. */
export function parseOnboardingProgress(raw: unknown): OnboardingProgressData {
  if (!raw || typeof raw !== 'object') return emptyOnboardingProgress();
  const obj = raw as Record<string, unknown>;
  const customSteps =
    obj.customSteps && typeof obj.customSteps === 'object'
      ? (obj.customSteps as Record<string, boolean>)
      : {};
  return {
    customSteps,
    verifiedAt: typeof obj.verifiedAt === 'string' ? obj.verifiedAt : undefined,
    rolesPickedAt: typeof obj.rolesPickedAt === 'string' ? obj.rolesPickedAt : undefined,
  };
}

export interface OnboardingChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

/** Builds the ephemeral checklist shown by `/onboarding checklist`: built-in items (rules, verified, roles picked) plus any `config.steps` custom items. */
export function buildOnboardingChecklist(input: {
  rulesConfigured: boolean;
  rulesAcceptedAt: Date | null;
  verificationEnabled: boolean;
  progress: OnboardingProgressData;
  customStepDefs: { id: string; label: string }[];
}): OnboardingChecklistItem[] {
  const items: OnboardingChecklistItem[] = [];
  if (input.rulesConfigured) {
    items.push({ id: '__rules__', label: 'Accepted the server rules', done: input.rulesAcceptedAt !== null });
  }
  if (input.verificationEnabled) {
    items.push({ id: '__verified__', label: 'Verified', done: Boolean(input.progress.verifiedAt) });
  }
  items.push({
    id: '__roles__',
    label: 'Picked self-assignable roles',
    done: Boolean(input.progress.rolesPickedAt),
  });
  for (const step of input.customStepDefs) {
    items.push({ id: step.id, label: step.label, done: Boolean(input.progress.customSteps[step.id]) });
  }
  return items;
}
