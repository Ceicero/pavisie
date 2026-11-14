import type { PluginContext } from '../../sdk';

/** Discord API error codes that mean the thing we were about to undo is already gone. */
const UNKNOWN_GUILD = 10004;
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_ROLE = 10011;
/** Fetching a guild the bot has been removed from answers Missing Access rather than Unknown Guild. */
const MISSING_ACCESS = 50001;

export function discordCode(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return undefined;
  return 'code' in err ? err.code : undefined;
}

/** `metadata.roleId` set by the `enforcer` plugin's timed MUTE (`metadata: { enforcerMute: true, roleId }`). */
export function enforcerMuteRoleId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const enforcerMute: unknown = 'enforcerMute' in metadata ? metadata.enforcerMute : undefined;
  const roleId: unknown = 'roleId' in metadata ? metadata.roleId : undefined;
  return enforcerMute === true && typeof roleId === 'string' ? roleId : null;
}

export interface EnforcerMuteCaseRow {
  id: string;
  guildId: string;
  targetId: string;
  metadata: unknown;
}

/**
 * True when a different, still-running enforcer mute holds the same role on the same member: one that has
 * not been closed and either never expires or expires in the future. An overdue case does not count. It is
 * waiting to be lifted itself, and two overdue mutes deferring to each other would never lift either.
 */
async function hasAnotherActiveMute(
  ctx: PluginContext,
  row: EnforcerMuteCaseRow,
  roleId: string,
): Promise<boolean> {
  const now = Date.now();
  const others = await ctx.prisma.moderationCase.findMany({
    where: {
      guildId: row.guildId,
      targetId: row.targetId,
      type: 'ROLE_ADD',
      expiredAt: null,
      deletedAt: null,
      id: { not: row.id },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }],
    },
  });
  // Re-checked here as well as in the query: the role lives in the JSON metadata, which the query cannot filter.
  return others.some(
    (other) =>
      other.id !== row.id &&
      other.guildId === row.guildId &&
      other.targetId === row.targetId &&
      !other.expiredAt &&
      !other.deletedAt &&
      (!other.expiresAt || other.expiresAt.getTime() > now) &&
      enforcerMuteRoleId(other.metadata) === roleId,
  );
}

/**
 * Removes the mute role of an expired enforcer timed MUTE. Shared by the `expire` and `sweep` jobs so the
 * two cannot disagree about which failures are final.
 *
 * Resolves when the mute is lifted or there is nothing left to lift: the case is not an enforcer mute,
 * another mute on the same member and role is still running, the bot is no longer in the guild, the member
 * left, the member no longer has the role, or the role was deleted. Any other failure (outage, rate limit, missing permission) is thrown, and the caller must leave
 * the case active so a later attempt can lift the mute instead of leaving the member muted indefinitely.
 */
export async function liftEnforcerMute(
  ctx: PluginContext,
  row: EnforcerMuteCaseRow,
  reason: string,
): Promise<void> {
  const roleId = enforcerMuteRoleId(row.metadata);
  if (!roleId) return;

  // The role is one switch shared by every mute on this member. If a later mute is still running, this
  // case is over but the member must stay muted: removing the role here would cut the later mute short.
  if (await hasAnotherActiveMute(ctx, row, roleId)) return;

  let guild;
  try {
    guild = await ctx.client.guilds.fetch(row.guildId);
  } catch (err) {
    const code = discordCode(err);
    if (code === UNKNOWN_GUILD || code === MISSING_ACCESS) return;
    throw err;
  }

  let member;
  try {
    // `force` skips the member cache. Without the GuildMembers intent the cached member does not see the
    // mute role being added, and a stale cache would make the role check below skip a removal that is needed.
    member = await guild.members.fetch({ user: row.targetId, force: true });
  } catch (err) {
    if (discordCode(err) === UNKNOWN_MEMBER) return;
    throw err;
  }
  if (!member.roles.cache.has(roleId)) return;

  try {
    await member.roles.remove(roleId, reason);
  } catch (err) {
    const code = discordCode(err);
    // The role was deleted, or the member left between the fetch and the removal.
    if (code === UNKNOWN_ROLE || code === UNKNOWN_MEMBER) return;
    throw err;
  }

  // A new mute can start between the check above and the removal: its role add changes nothing (the role is
  // still on) and its case is written while this runs, so the removal just undid it. Check again and put the
  // role back. Per-member and lock-free; see the README for the narrower window this leaves.
  if (await hasAnotherActiveMute(ctx, row, roleId)) {
    await member.roles.add(roleId, 'A newer mute is still in force');
  }
}
