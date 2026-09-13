import { STAFF_LEVEL_RANK, type StaffLevel } from '@pavisie/types';
import { PermissionFlagsBits } from 'discord-api-types/v10';

/** Minimal plain-data shape of a guild member needed to resolve staff level — no discord.js dependency. */
export interface MemberLike {
  id: string;
  roleIds: string[];
  permissions: bigint;
  highestRolePosition: number;
  isBot?: boolean;
}

export interface StaffRoleConfig {
  adminRoleIds: string[];
  modRoleIds: string[];
  helperRoleIds: string[];
}

export interface ResolveStaffLevelInput {
  member: MemberLike;
  guildOwnerId: string;
  botOwnerIds: string[];
  staffRoles: StaffRoleConfig;
}

function hasAnyRole(roleIds: string[], configuredIds: string[]): boolean {
  if (configuredIds.length === 0) return false;
  const roleSet = new Set(roleIds);
  return configuredIds.some((id) => roleSet.has(id));
}

function hasPermission(permissions: bigint, flag: bigint): boolean {
  return (permissions & flag) === flag;
}

/**
 * Resolves a member's effective staff level.
 *
 * Order: the guild owner is always `'owner'`. Otherwise, configured staff roles win (admin > moderator > helper),
 * then Discord permissions are used as a fallback (Administrator/ManageGuild → admin;
 * ModerateMembers/KickMembers/BanMembers/ManageMessages → moderator). Bot owners who are not the guild owner
 * are floored at `'admin'` regardless of roles/permissions (owner status is reserved for the actual guild owner).
 */
export function resolveStaffLevel(input: ResolveStaffLevelInput): StaffLevel {
  const { member, guildOwnerId, botOwnerIds, staffRoles } = input;

  if (member.id === guildOwnerId) {
    return 'owner';
  }

  let level: StaffLevel = 'member';

  if (hasAnyRole(member.roleIds, staffRoles.adminRoleIds)) {
    level = 'admin';
  } else if (hasAnyRole(member.roleIds, staffRoles.modRoleIds)) {
    level = 'moderator';
  } else if (hasAnyRole(member.roleIds, staffRoles.helperRoleIds)) {
    level = 'helper';
  } else if (
    hasPermission(member.permissions, PermissionFlagsBits.Administrator) ||
    hasPermission(member.permissions, PermissionFlagsBits.ManageGuild)
  ) {
    level = 'admin';
  } else if (
    hasPermission(member.permissions, PermissionFlagsBits.ModerateMembers) ||
    hasPermission(member.permissions, PermissionFlagsBits.KickMembers) ||
    hasPermission(member.permissions, PermissionFlagsBits.BanMembers) ||
    hasPermission(member.permissions, PermissionFlagsBits.ManageMessages)
  ) {
    level = 'moderator';
  }

  if (botOwnerIds.includes(member.id) && STAFF_LEVEL_RANK[level] < STAFF_LEVEL_RANK.admin) {
    level = 'admin';
  }

  return level;
}

/** True if `level` meets or exceeds `required` in staff rank. */
export function hasStaffLevel(level: StaffLevel, required: StaffLevel): boolean {
  return STAFF_LEVEL_RANK[level] >= STAFF_LEVEL_RANK[required];
}
