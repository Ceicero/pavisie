import { PermissionsBitField, type GuildMember, type PermissionResolvable } from 'discord.js';
import {
  describePermission,
  hasStaffLevel,
  resolveStaffLevel,
  type MemberLike,
  type StaffRoleConfig,
} from '@pavisie/core';
import type { StaffLevel } from '@pavisie/types';
import type { CommandRequirement } from '@pavisie/plugins';

/** Converts a real discord.js `GuildMember` into the plain-data shape `@pavisie/core`'s staff-level resolver needs. */
export function toMemberLike(member: GuildMember): MemberLike {
  return {
    id: member.id,
    roleIds: [...member.roles.cache.keys()],
    permissions: member.permissions.bitfield,
    highestRolePosition: member.roles.highest.position,
    isBot: member.user.bot,
  };
}

export interface ResolveInteractionStaffLevelInput {
  member: GuildMember;
  guildOwnerId: string;
  botOwnerIds: string[];
  staffRoles: StaffRoleConfig;
}

/** Resolves the effective staff level for the member issuing a command/component interaction. */
export function resolveInteractionStaffLevel(input: ResolveInteractionStaffLevelInput): StaffLevel {
  return resolveStaffLevel({
    member: toMemberLike(input.member),
    guildOwnerId: input.guildOwnerId,
    botOwnerIds: input.botOwnerIds,
    staffRoles: input.staffRoles,
  });
}

export interface EvaluateRequirementInput {
  requirement:
    | CommandRequirement
    | Pick<CommandRequirement, 'staffLevel' | 'discordPermissions' | 'botOwnerOnly'>
    | undefined;
  staffLevel: StaffLevel;
  /** The actor's Discord permission bitfield in the relevant guild/channel context. */
  actorPermissionsBitfield: bigint;
  userId: string;
  botOwnerIds: string[];
}

export type RequirementFailure =
  | { ok: false; reason: 'bot_owner_only' }
  | { ok: false; reason: 'missing_staff_level'; level: StaffLevel }
  | { ok: false; reason: 'missing_discord_permission'; permission: string };

export type RequirementResult = { ok: true } | RequirementFailure;

/**
 * Evaluates a command/component `requirement`'s `botOwnerOnly`, `staffLevel`, and `discordPermissions` checks
 * (everything that doesn't need a live `Guild`/`GuildBasedChannel` object — bot permission checks and hierarchy
 * checks are handled separately via the SDK's `assertBotPermissions`/`hierarchyGuard`, which need real objects).
 *
 * `staffLevel` and `discordPermissions` are OR'd together when BOTH are declared on the same requirement (either
 * one satisfies it); when only one is declared, only that one is checked. Pure and gateway-free — safe to unit
 * test directly.
 */
export function evaluateRequirement(input: EvaluateRequirementInput): RequirementResult {
  const { requirement, staffLevel, actorPermissionsBitfield, userId, botOwnerIds } = input;

  if (!requirement) return { ok: true };

  if (requirement.botOwnerOnly && !botOwnerIds.includes(userId)) {
    return { ok: false, reason: 'bot_owner_only' };
  }

  const staffDeclared = requirement.staffLevel !== undefined;
  const permsDeclared =
    requirement.discordPermissions !== undefined && requirement.discordPermissions.length > 0;

  if (!staffDeclared && !permsDeclared) {
    return { ok: true };
  }

  const satisfiesStaff = staffDeclared
    ? hasStaffLevel(staffLevel, requirement.staffLevel as StaffLevel)
    : false;
  const requiredPermissionBits = permsDeclared
    ? (requirement.discordPermissions as PermissionResolvable[]).map((p) => PermissionsBitField.resolve(p))
    : [];
  const satisfiesPerms = permsDeclared
    ? requiredPermissionBits.every((bit) => (actorPermissionsBitfield & bit) === bit)
    : false;

  const ok =
    staffDeclared && permsDeclared
      ? satisfiesStaff || satisfiesPerms
      : staffDeclared
        ? satisfiesStaff
        : satisfiesPerms;

  if (ok) return { ok: true };

  // When both are declared and neither is satisfied, the staff-level message is the more actionable one to show
  // (it names a single concrete requirement rather than a permission list mixing in whatever the actor already has).
  if (staffDeclared) {
    return { ok: false, reason: 'missing_staff_level', level: requirement.staffLevel as StaffLevel };
  }

  const missing = requiredPermissionBits
    .filter((bit) => (actorPermissionsBitfield & bit) !== bit)
    .map(describePermission);
  return { ok: false, reason: 'missing_discord_permission', permission: missing.join(', ') };
}

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

/** Maps an `evaluateRequirement` failure to a translated, user-facing message via the caller's bound `t`. */
export function requirementFailureMessage(failure: RequirementFailure, t: TFunction): string {
  switch (failure.reason) {
    case 'bot_owner_only':
      return t('errors.permission_denied');
    case 'missing_staff_level':
      return t('errors.missing_staff_level', { level: failure.level });
    case 'missing_discord_permission':
      return t('errors.missing_discord_permission', { permission: failure.permission });
  }
}

export type CooldownScope = 'user' | 'guild' | 'channel';

export interface CooldownKeyIds {
  userId: string;
  guildId: string;
  channelId: string;
}

/** Builds the Redis cooldown key for a command's `requirement.cooldown` (scoped by user, guild, or channel). Pure. */
export function cooldownKey(commandName: string, scope: CooldownScope, ids: CooldownKeyIds): string {
  const scopeId = scope === 'user' ? ids.userId : scope === 'guild' ? ids.guildId : ids.channelId;
  return `cmd:${commandName}:${scope}:${scopeId}`;
}

/** Redis key for the global per-user command rate limiter (20 commands / 10s, ARCHITECTURE.md §7.7). Pure. */
export function globalLimiterKey(userId: string): string {
  return `global:${userId}`;
}
