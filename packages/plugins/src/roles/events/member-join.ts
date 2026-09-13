import type { GuildMember } from 'discord.js';
import { resolveTextChannel, safeDm, type PluginContext, type PluginEventHandler } from '../../sdk';
import {
  filterPersistableRoles,
  isElevatedPermissionBitfield,
  isSnapshotFresh,
  passesAccountAgeGate,
} from '../engine';
import type { RolesConfig } from '../manifest';
import { applyAutoRoles, deliverWelcomeGoodbye } from '../service';

export const memberJoinHandler: PluginEventHandler<'guildMemberAdd'> = {
  event: 'guildMemberAdd',
  guildIdOf: (member) => member.guild.id,
  async handler(ctx, member) {
    const config = await ctx.getConfig<RolesConfig>(member.guild.id);

    // --- Account-age gate ---------------------------------------------------------------------------------
    if (
      config.verification.minAccountAgeDays > 0 &&
      !passesAccountAgeGate(member.user.createdAt, config.verification.minAccountAgeDays)
    ) {
      const action = config.verification.underageAction;
      if (action === 'kick') {
        await safeDm(member.user, {
          content: `You were removed from **${member.guild.name}** because your Discord account is too new to join yet. You're welcome to rejoin once it meets the minimum age.`,
        });
        try {
          await member.kick('Account-age gate: account too new');
        } catch (err) {
          ctx.logger.warn(
            { err: err instanceof Error ? err.message : String(err), guildId: member.guild.id },
            'roles: account-age gate kick failed (missing permission?)',
          );
        }
        await ctx.audit({
          guildId: member.guild.id,
          actorId: member.id,
          actorType: 'system',
          action: 'roles.accountAgeGate.kick',
          targetType: 'member',
          targetId: member.id,
          source: 'bot',
        });
        return;
      }
      if (action === 'quarantine') {
        let roleApplied = false;
        const automod = ctx.services.get('automod');
        if (automod) {
          try {
            await automod.quarantine(member.guild.id, member.id, 'Account-age gate: account too new');
            roleApplied = true;
          } catch (err) {
            // automod.quarantine threw (e.g., its own quarantine role is unconfigured); fall back to roles plugin's role
            if (config.verification.quarantineRoleId) {
              try {
                await member.roles.add(
                  config.verification.quarantineRoleId,
                  'Account-age gate: account too new',
                );
                roleApplied = true;
              } catch (roleErr) {
                ctx.logger.warn(
                  {
                    err: roleErr instanceof Error ? roleErr.message : String(roleErr),
                    guildId: member.guild.id,
                    quarantineRoleId: config.verification.quarantineRoleId,
                  },
                  'roles: account-age gate quarantine role assignment failed',
                );
              }
            } else {
              ctx.logger.warn(
                {
                  err: err instanceof Error ? err.message : String(err),
                  guildId: member.guild.id,
                },
                'roles: account-age gate quarantine failed (automod unavailable and no fallback role configured)',
              );
            }
          }
        } else if (config.verification.quarantineRoleId) {
          try {
            await member.roles.add(
              config.verification.quarantineRoleId,
              'Account-age gate: account too new',
            );
            roleApplied = true;
          } catch (err) {
            ctx.logger.warn(
              {
                err: err instanceof Error ? err.message : String(err),
                guildId: member.guild.id,
                quarantineRoleId: config.verification.quarantineRoleId,
              },
              'roles: account-age gate quarantine role assignment failed',
            );
          }
        } else {
          ctx.logger.warn(
            { guildId: member.guild.id },
            'roles: account-age gate quarantine configured but no quarantine role is set',
          );
        }

        // Only write an audit entry if a role was actually applied
        if (roleApplied) {
          await ctx.audit({
            guildId: member.guild.id,
            actorId: member.id,
            actorType: 'system',
            action: 'roles.accountAgeGate.quarantine',
            targetType: 'member',
            targetId: member.id,
            source: 'bot',
          });
        }
      }
    }

    // --- Membership screening: if Discord's own verification gate is on, wait for guildMemberUpdate --------
    if (member.pending) {
      return;
    }

    await handleFullyJoined(ctx, member, config);
  },
};

/** Shared by `guildMemberAdd` (non-pending members) and `member-update.ts` (pending → not pending): restores persisted roles, applies auto-roles, then sends the welcome message. */
export async function handleFullyJoined(
  ctx: PluginContext,
  member: GuildMember,
  config: RolesConfig,
): Promise<void> {
  // --- Role persistence restore --------------------------------------------------------------------------
  if (config.rolePersistence.enabled) {
    const snapshot = await ctx.prisma.memberRoleSnapshot.findUnique({
      where: { guildId_userId: { guildId: member.guild.id, userId: member.id } },
    });
    if (snapshot && isSnapshotFresh(snapshot.leftAt, config.rolePersistence.maxDays)) {
      await member.guild.roles.fetch();
      const botTopRolePosition = member.guild.members.me?.roles.highest.position ?? 0;
      const elevatedOrUnsafe = new Set<string>();
      const managed = new Set<string>();
      for (const roleId of snapshot.roleIds) {
        const role = member.guild.roles.cache.get(roleId);
        if (!role) continue;
        if (isElevatedPermissionBitfield(role.permissions.bitfield) || role.position >= botTopRolePosition)
          elevatedOrUnsafe.add(roleId);
        if (role.managed) managed.add(roleId);
      }
      const restorable = filterPersistableRoles({
        roleIds: snapshot.roleIds,
        elevatedRoleIds: elevatedOrUnsafe,
        managedRoleIds: managed,
        everyoneRoleId: member.guild.roles.everyone.id,
      }).filter((id) => member.guild.roles.cache.has(id));

      if (restorable.length > 0) {
        await member.roles.add(restorable, 'Role persistence: restored on rejoin').catch(() => undefined);
      }
      await ctx.prisma.memberRoleSnapshot.delete({ where: { id: snapshot.id } }).catch(() => undefined);
      await ctx.audit({
        guildId: member.guild.id,
        actorId: member.id,
        actorType: 'system',
        action: 'roles.persistence.restore',
        targetType: 'member',
        targetId: member.id,
        after: { roleIds: restorable },
        source: 'bot',
      });
    }
  }

  // --- Auto-roles -----------------------------------------------------------------------------------------
  if (config.autoRoles.enabled) {
    await applyAutoRoles(ctx, member, config);
  }

  // --- Welcome message ------------------------------------------------------------------------------------
  if (config.welcome.enabled) {
    const channel = config.welcome.channelId
      ? await resolveTextChannel(member.guild, config.welcome.channelId)
      : null;
    await deliverWelcomeGoodbye({
      ctx,
      guild: member.guild,
      channel,
      member,
      section: config.welcome,
      fetchUser: async () => member.user,
    });
  }
}
