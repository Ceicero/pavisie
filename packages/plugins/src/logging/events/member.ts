import { PermissionFlagsBits, type GuildMember, type PartialGuildMember } from 'discord.js';
import type { PluginEventHandler, PluginContext } from '../../sdk';
import {
  diffInviteUses,
  readInviteSnapshot,
  writeInviteSnapshot,
  type InviteUseSnapshot,
} from '../invite-cache';

async function logService(ctx: PluginContext) {
  return ctx.services.get('logging');
}

/** Best-effort invite-use attribution for a fresh join: needs `ManageGuild` (to list invites) — silently skipped otherwise (manifest.permissions documents the fallback). */
async function attributeInvite(ctx: PluginContext, member: GuildMember): Promise<string | null> {
  const botMember = member.guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageGuild)) return null;

  try {
    const invites = await member.guild.invites.fetch();
    const current: InviteUseSnapshot[] = invites.map((invite) => ({
      code: invite.code,
      uses: invite.uses ?? 0,
    }));
    const previous = await readInviteSnapshot(ctx.redis, member.guild.id);
    const diff = diffInviteUses(previous, current);
    await writeInviteSnapshot(ctx.redis, member.guild.id, current);
    return diff ? `Used invite \`${diff.code}\` (${diff.usesBefore} → ${diff.usesAfter} uses).` : null;
  } catch (err) {
    ctx.logger.warn({ guildId: member.guild.id, err }, 'logging: invite-use attribution failed');
    return null;
  }
}

export const guildMemberAdd: PluginEventHandler<'guildMemberAdd'> = {
  event: 'guildMemberAdd',
  guildIdOf: (member) => member.guild.id,
  async handler(ctx, member) {
    const logging = await logService(ctx);
    if (!logging) return;

    await logging.log(member.guild.id, 'member.join', {
      targetId: member.id,
      description: `${member.user.tag} (\`${member.id}\`) joined the server.`,
    });

    const inviteNote = await attributeInvite(ctx, member);
    if (inviteNote) {
      await logging.log(member.guild.id, 'invite.use', {
        targetId: member.id,
        description: inviteNote,
      });
    }
  },
};

export const guildMemberRemove: PluginEventHandler<'guildMemberRemove'> = {
  event: 'guildMemberRemove',
  guildIdOf: (member) => member.guild.id,
  async handler(ctx, member: GuildMember | PartialGuildMember) {
    const logging = await logService(ctx);
    if (!logging) return;

    const tag = member.user?.tag ?? member.id;
    await logging.log(member.guild.id, 'member.leave', {
      targetId: member.id,
      description: `${tag} (\`${member.id}\`) left the server.`,
    });
  },
};

export const memberEvents = [guildMemberAdd, guildMemberRemove];
