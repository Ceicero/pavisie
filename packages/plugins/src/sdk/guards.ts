import {
  PermissionsBitField,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type PermissionResolvable,
} from 'discord.js';
import {
  PermissionError,
  hasStaffLevel,
  missingPermissions,
  describePermission,
  checkModerationTarget,
  t as coreT,
  type HierarchyMemberLike,
} from '@pavisie/core';
import type { StaffLevel } from '@pavisie/types';

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

/** Throws `PermissionError` if `current` doesn't meet or exceed `required` in staff rank. */
export function assertStaffLevel(current: StaffLevel, required: StaffLevel, t: TFunction): void {
  if (!hasStaffLevel(current, required)) {
    throw new PermissionError(t('errors.missing_staff_level', { level: required }));
  }
}

function isGuildBasedChannel(target: Guild | GuildBasedChannel): target is GuildBasedChannel {
  return 'guild' in target;
}

/**
 * Throws `PermissionError` if the bot lacks any of `required` permissions in `target` (a `Guild` for
 * guild-level permissions, or a `GuildBasedChannel` for channel-level overwrites).
 */
export function assertBotPermissions(
  target: Guild | GuildBasedChannel,
  required: PermissionResolvable[],
  t: TFunction,
): void {
  const guild = isGuildBasedChannel(target) ? target.guild : target;
  const botMember = guild.members.me;
  const requiredBits = required.map((perm) => PermissionsBitField.resolve(perm));

  if (!botMember) {
    throw new PermissionError(
      t('errors.bot_missing_permission', { permission: requiredBits.map(describePermission).join(', ') }),
    );
  }

  const have = isGuildBasedChannel(target)
    ? (target.permissionsFor(botMember) ?? new PermissionsBitField(0n))
    : botMember.permissions;
  const missing = missingPermissions(have.bitfield, requiredBits);

  if (missing.length > 0) {
    throw new PermissionError(t('errors.bot_missing_permission', { permission: missing.join(', ') }));
  }
}

function toHierarchyMemberLike(member: GuildMember): HierarchyMemberLike {
  return { id: member.id, highestRolePosition: member.roles.highest.position, isBot: member.user.bot };
}

export interface HierarchyGuardInteraction {
  guild: Guild;
  member: GuildMember;
}

/**
 * Throws `PermissionError` (message `errors.hierarchy.<reason>`) if `interaction.member` may not take a
 * moderation action against `targetMember` — self, the bot, the guild owner, a bot owner, or an
 * equal-or-higher role position than the actor or the bot (see `@pavisie/core` `checkModerationTarget`).
 */
export function hierarchyGuard(
  interaction: HierarchyGuardInteraction,
  targetMember: GuildMember,
  botOwnerIds: string[],
  t: TFunction = coreT,
): void {
  const botMember = interaction.guild.members.me;
  if (!botMember) {
    throw new PermissionError(t('errors.generic'));
  }

  const result = checkModerationTarget({
    actor: toHierarchyMemberLike(interaction.member),
    target: toHierarchyMemberLike(targetMember),
    botMember: toHierarchyMemberLike(botMember),
    guildOwnerId: interaction.guild.ownerId,
    botOwnerIds,
  });

  if (!result.ok) {
    throw new PermissionError(t(`errors.hierarchy.${result.reason}`));
  }
}
