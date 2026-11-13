import type { Guild } from 'discord.js';
import { redisKey } from '@pavisie/core';
import { fetchMemberSafe, type PluginContext, type PluginJob } from '../../sdk';
import { checkRoleAssignable } from '../../roles/engine';
import { openTextChannel } from '../channel-access';
import { classifyDiscordFailure } from '../discord-errors';
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
 * Announces every birthday due today once the guild-local hour has reached `cfg.birthdays.announceHour`.
 * A transient send failure is left unstamped so a later run the same day retries that member only; a permanent
 * Discord rejection is stamped so it is not tried again all day. One member's failure does not stop the others.
 * `lastAnnouncedYear` is what keeps an already-posted birthday from going out twice. Exported for tests; the
 * job's processor loops guilds.
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
  // Before the configured hour, wait. From that hour through the end of the local day, announce anyone not
  // yet stamped this year — a failure during the announce hour is retried on a later run today.
  if (ln.hour < settings.announceHour) {
    return { guildId, announced: 0, skippedReason: 'hour' };
  }

  const blockedKey = redisKey(
    'community',
    'birthday-channel-blocked',
    guildId,
    String(ln.year),
    String(ln.month),
    String(ln.day),
  );
  if (await ctx.redis.get(blockedKey)) {
    return { guildId, announced: 0, skippedReason: 'channel' };
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

  // `members.me` missing is a cache gap, not Discord 50001. Don't pin the channel as blocked for the day.
  if (!guild.members.me) {
    ctx.logger.warn({ guildId, channelId: settings.channelId }, 'community: birthday channel unavailable');
    return { guildId, announced: 0, skippedReason: 'channel' };
  }

  const opened = await openTextChannel(guild, settings.channelId);
  if (!opened.ok) {
    ctx.logger.warn(
      { guildId, channelId: settings.channelId, discordFailure: opened.failure },
      'community: birthday channel unavailable',
    );
    if (opened.failure !== 'unavailable') {
      // Unknown channel / missing access / missing permissions will not start working an hour later.
      await ctx.redis.set(blockedKey, '1', 'EX', 36 * 3600);
    }
    return { guildId, announced: 0, skippedReason: 'channel' };
  }
  const channel = opened.channel;

  const role = settings.roleId ? await resolveBirthdayRole(guild, settings.roleId) : null;
  let announced = 0;

  const stamp = (birthdayId: string) =>
    ctx.prisma.birthday.update({
      where: { id: birthdayId },
      data: { lastAnnouncedYear: ln.year },
    });

  for (const birthday of due) {
    try {
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
      try {
        await channel.send({ content, allowedMentions: { users: [member.id], parse: [] } });
      } catch (err) {
        const failure = classifyDiscordFailure(err);
        if (failure) {
          ctx.logger.warn(
            { err, guildId, userId: member.id, discordFailure: failure },
            'community: birthday announcement was rejected and will not be retried',
          );
          // Stamp so the hourly job does not hammer a channel Discord has already refused.
          await stamp(birthday.id);
        } else {
          ctx.logger.warn(
            { err, guildId, userId: member.id },
            'community: birthday announcement failed and will be retried',
          );
        }
        continue;
      }
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
      await stamp(birthday.id);
    } catch (err) {
      // One member's bookkeeping error must not drop the rest of today's list.
      ctx.logger.error(
        { err, guildId, userId: birthday.userId },
        'community: birthday announcement failed for a member',
      );
    }
  }

  return { guildId, announced };
}

/**
 * Hourly (top of the hour) sweep: for every guild the bot is in where the community plugin is enabled and
 * birthdays are configured, announce today's birthdays once the guild-local hour has reached the configured
 * hour (and on later hours the same day, for anyone whose post failed). Per-guild errors are caught + logged
 * (and routed to `bot.error` when the logging plugin is loaded); the processor never throws.
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
