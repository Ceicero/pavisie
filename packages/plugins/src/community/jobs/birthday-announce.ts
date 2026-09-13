import type { Guild } from 'discord.js';
import { fetchMemberSafe, resolveTextChannel, type PluginContext, type PluginJob } from '../../sdk';
import { checkRoleAssignable } from '../../roles/engine';
import {
  BIRTHDAY_ROLE_DURATION_MS,
  birthdayRoleRemoveJobId,
  localNow,
  renderBirthdayMessage,
  type LocalNow,
} from '../birthdays';
import type { CommunityConfig } from '../manifest';
import type { BirthdayRoleRemoveJobData } from './birthday-role-remove';

export interface BirthdayAnnounceResult {
  guildId: string;
  /** Number of birthdays announced in this run (0 when the hour didn't match, nothing was due, etc). */
  announced: number;
  skippedReason?: 'disabled' | 'hour' | 'channel';
}

/** `birthdays.roleId` → the guild's Role, or null if it's gone / can't safely be assigned by the bot. */
async function resolveBirthdayRole(guild: Guild, roleId: string) {
  const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) return null;
  const botTopRolePosition = guild.members.me?.roles.highest.position ?? 0;
  const assignable = checkRoleAssignable({
    permissionsBitfield: role.permissions.bitfield,
    position: role.position,
    managed: role.managed,
    botTopRolePosition,
    // A birthday role is a cosmetic, bot-assigned role: never hand out elevated permissions with it.
    allowElevatedRoles: false,
  });
  return assignable.ok ? role : null;
}

/**
 * Announces every birthday due right now in one guild (guild-local hour must equal `cfg.birthdays.announceHour`),
 * adds the optional role, schedules its removal, and stamps `lastAnnouncedYear` so a rerun in the same hour
 * (or a later hour the same day) never announces twice. Exported for tests; the job's processor loops guilds.
 */
export async function announceBirthdaysForGuild(
  ctx: PluginContext,
  guild: Guild,
  cfg: CommunityConfig,
  now: Date = new Date(),
): Promise<BirthdayAnnounceResult> {
  const guildId = guild.id;
  const settings = cfg.birthdays;
  if (!settings.enabled || !settings.channelId) {
    return { guildId, announced: 0, skippedReason: 'disabled' };
  }

  const host = ctx.services.get('host');
  const timezone = host ? (await host.getGuildConfig(guildId)).timezone : 'UTC';
  const ln: LocalNow = localNow(timezone, now);
  if (ln.hour !== settings.announceHour) {
    return { guildId, announced: 0, skippedReason: 'hour' };
  }

  // Feb 29 birthdays are celebrated on Feb 28 in non-leap years.
  const dateMatches: { month: number; day: number }[] = [{ month: ln.month, day: ln.day }];
  if (ln.month === 2 && ln.day === 28 && !ln.isLeapYear) {
    dateMatches.push({ month: 2, day: 29 });
  }

  const due = await ctx.prisma.birthday.findMany({
    where: {
      guildId,
      OR: dateMatches,
      // NOT: { lastAnnouncedYear: ln.year } looks equivalent but ISN'T: Postgres's `<> value` comparison
      // evaluates to NULL (never TRUE) for a NULL column, so that predicate silently excludes every row whose
      // birthday has never been announced — first-time birthdays would never fire. Spell out both cases.
      AND: [{ OR: [{ lastAnnouncedYear: null }, { lastAnnouncedYear: { not: ln.year } }] }],
    },
  });
  if (due.length === 0) return { guildId, announced: 0 };

  const channel = await resolveTextChannel(guild, settings.channelId);
  if (!channel) {
    ctx.logger.warn({ guildId, channelId: settings.channelId }, 'community: birthday channel unavailable');
    return { guildId, announced: 0, skippedReason: 'channel' };
  }

  const role = settings.roleId ? await resolveBirthdayRole(guild, settings.roleId) : null;
  let announced = 0;

  for (const birthday of due) {
    // Member left → skip (do NOT delete; they may rejoin, and the row expires with the guild's data anyway).
    const member = await fetchMemberSafe(guild, birthday.userId);
    if (!member) continue;

    const content = renderBirthdayMessage(settings.message, {
      mention: `<@${member.id}>`,
      user: member.displayName,
      server: guild.name,
      userId: member.id,
      memberCount: guild.memberCount,
    });
    // Only the birthday member may be pinged, whatever the template says.
    await channel.send({ content, allowedMentions: { users: [member.id], parse: [] } });
    announced += 1;

    if (role) {
      let roleAdded = false;
      try {
        await member.roles.add(role, 'Pavisie community: birthday role');
        roleAdded = true;
      } catch (err) {
        ctx.logger.warn(
          { err, guildId, userId: member.id, roleId: role.id },
          'community: could not add the birthday role',
        );
      }

      if (roleAdded) {
        try {
          const jobData: BirthdayRoleRemoveJobData = { guildId, userId: member.id, roleId: role.id };
          await ctx.queue('birthday-role-remove').add('birthday-role-remove', jobData, {
            delay: BIRTHDAY_ROLE_DURATION_MS,
            jobId: birthdayRoleRemoveJobId(guildId, member.id, ln.year),
            removeOnComplete: true,
          });
        } catch (err) {
          ctx.logger.warn(
            { err, guildId, userId: member.id, roleId: role.id },
            'community: could not schedule birthday role removal',
          );
          // The 24h auto-removal job couldn't be scheduled — undo the grant (best-effort) so it can't become permanent.
          await member.roles
            .remove(role.id, 'Pavisie community: could not schedule the automatic removal')
            .catch(() => undefined);
        }
      }
    }

    // Stamped after posting (even if the role step failed) so we never announce twice in one year.
    await ctx.prisma.birthday.update({
      where: { id: birthday.id },
      data: { lastAnnouncedYear: ln.year },
    });
  }

  return { guildId, announced };
}

/**
 * Hourly (top of the hour) sweep: for every guild the bot is in where the community plugin is enabled and
 * birthdays are configured, announce today's birthdays when the guild-local hour matches. Per-guild errors are
 * caught + logged (and routed to `bot.error` when the logging plugin is loaded); the processor never throws.
 */
export const birthdayAnnounceJob: PluginJob = {
  name: 'birthday-announce',
  repeat: { pattern: '0 * * * *' },
  async processor(ctx) {
    const now = new Date();
    for (const guild of ctx.client.guilds.cache.values()) {
      // An unavailable guild (regional Discord outage) has an empty channel/role cache — treating that as
      // "nothing configured" would wipe live config. Wait for it to come back instead.
      if (!guild.available) continue;
      try {
        if (!(await ctx.isEnabled(guild.id))) continue;
        const cfg = await ctx.getConfig<CommunityConfig>(guild.id);
        if (!cfg.birthdays?.enabled || !cfg.birthdays.channelId) continue;
        const result = await announceBirthdaysForGuild(ctx, guild, cfg, now);
        if (result.announced > 0) {
          ctx.logger.info(
            { guildId: guild.id, announced: result.announced },
            'community: birthdays announced',
          );
        }
      } catch (err) {
        ctx.logger.error({ err, guildId: guild.id }, 'community: birthday-announce failed for a guild');
        const logging = ctx.services.get('logging');
        if (logging) {
          await logging
            .log(guild.id, 'bot.error', {
              title: 'Birthday announcement failed',
              description: err instanceof Error ? err.message : String(err),
            })
            .catch(() => undefined);
        }
      }
    }
  },
};
