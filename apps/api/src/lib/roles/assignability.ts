import { PermissionError, ValidationError } from '@pavisie/core';
import { canActorManageRole, checkRoleAssignable } from '@pavisie/plugins/roles/engine';
import { fetchWithBotToken, hasBotToken } from '../discord';

interface ApiRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  permissions: string;
}
interface ApiMember {
  roles: string[];
}

/** Highest role position among `roleIds` (0 = only @everyone). */
function topPosition(roleIds: string[], byId: Map<string, ApiRole>): number {
  return roleIds.reduce((max, id) => Math.max(max, byId.get(id)?.position ?? 0), 0);
}

/**
 * Dashboard-side mirror of the bot's `/roles panel add-option` checks (packages/plugins/src/roles/engine.ts):
 * each role must exist in this guild, not be integration-managed, not grant elevated permissions (unless
 * `allowElevatedRoles`), be below the bot's top role, AND be below the acting user's own top role (guild owner
 * exempt). Reads live Discord data via the bot token (uncached — this is a write-path authorization check).
 *
 * When the API has no bot token configured the check is skipped (the bot still re-checks managed/elevated/bot
 * hierarchy at toggle time); this keeps token-less dev setups working.
 */
export async function assertPanelRolesAssignable(input: {
  guildId: string;
  actorId: string;
  roleIds: string[];
  allowElevatedRoles: boolean;
}): Promise<void> {
  const roleIds = [...new Set(input.roleIds)];
  if (roleIds.length === 0 || !hasBotToken()) return;

  const [roles, guild, botUser] = await Promise.all([
    fetchWithBotToken<ApiRole[]>(`/guilds/${input.guildId}/roles`),
    fetchWithBotToken<{ owner_id: string }>(`/guilds/${input.guildId}`),
    fetchWithBotToken<{ id: string }>(`/users/@me`),
  ]);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const isOwner = guild.owner_id === input.actorId;
  const [botMember, actorMember] = await Promise.all([
    fetchWithBotToken<ApiMember>(`/guilds/${input.guildId}/members/${botUser.id}`),
    isOwner
      ? Promise.resolve(null)
      : fetchWithBotToken<ApiMember>(`/guilds/${input.guildId}/members/${input.actorId}`),
  ]);
  const botTop = topPosition(botMember.roles, byId);
  const actorTop = actorMember ? topPosition(actorMember.roles, byId) : undefined;

  for (const roleId of roleIds) {
    const role = byId.get(roleId);
    if (!role || role.id === input.guildId) {
      throw new ValidationError(`Role ${roleId} is not an assignable role in this server.`);
    }
    const result = checkRoleAssignable({
      permissionsBitfield: BigInt(role.permissions),
      position: role.position,
      managed: role.managed,
      botTopRolePosition: botTop,
      allowElevatedRoles: input.allowElevatedRoles,
    });
    if (!result.ok) {
      const why =
        result.reason === 'managed'
          ? 'is managed by an integration or bot'
          : result.reason === 'elevated'
            ? 'grants an elevated permission (enable allowElevatedRoles to allow it)'
            : "is at or above the bot's highest role";
      throw new ValidationError(`Role "${role.name}" ${why}.`);
    }
    if (
      !canActorManageRole({
        rolePosition: role.position,
        actorTopRolePosition: actorTop,
        actorIsOwner: isOwner,
      })
    ) {
      throw new PermissionError(`Role "${role.name}" is at or above your own highest role.`);
    }
  }
}
