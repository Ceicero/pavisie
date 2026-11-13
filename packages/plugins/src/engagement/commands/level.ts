import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  SlashCommandBuilder,
  userMention,
  type ButtonInteraction,
  type EmbedBuilder,
  type Guild,
} from 'discord.js';
import {
  assertStaffLevel,
  brandEmbed,
  buildCustomId,
  errorEmbed,
  fetchMemberSafe,
  isSnowflake,
  listEmbed,
  registerConfirmHandlers,
  requestConfirmation,
  resolveTextChannel,
  successEmbed,
  type ComponentHandler,
  type PluginCommand,
  type PluginContext,
} from '../../sdk';
import { clampXpMultiplier, type EngagementConfig } from '../manifest';
import { applyLevelUp, REWARD_ROLE_SYNC_LIMIT, syncMemberRewardRoles } from '../level-actions';
import { formatProgressBar, levelFromXp, levelProgress } from '../service';

const LEADERBOARD_PAGE_SIZE = 10;

/** Most ranked members one `/level rewards sync` or `/level reset` will touch, highest-XP first. */
const REWARD_SYNC_LIMIT = REWARD_ROLE_SYNC_LIMIT;

const data = new SlashCommandBuilder()
  .setName('level')
  .setDescription('Leveling: rank, leaderboard, XP, and level-role rewards.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('rank')
      .setDescription("Show a member's level, XP, and progress.")
      .addUserOption((opt) => opt.setName('user').setDescription('Defaults to you.')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('leaderboard')
      .setDescription('Show the XP leaderboard.')
      .addIntegerOption((opt) =>
        opt.setName('page').setDescription('Page number (default 1).').setMinValue(1),
      ),
  )
  .addSubcommand((sub) => sub.setName('config').setDescription('View the leveling configuration.'))
  .addSubcommand((sub) =>
    sub
      .setName('announce')
      .setDescription('Set where level-up announcements are sent.')
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Where to announce level-ups.')
          .setRequired(true)
          .addChoices(
            { name: 'Same channel as the activity', value: 'same-channel' },
            { name: 'DM the member', value: 'dm' },
            { name: 'Off', value: 'off' },
            { name: 'Specific channel', value: 'channel' },
          ),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to announce in (required when mode is "Specific channel").')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reset')
      .setDescription('Reset leveling data for one member, or everyone.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Leave empty to reset every member in this server.'),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('xp')
      .setDescription("Manually adjust a member's XP.")
      .addSubcommand((sub) =>
        sub
          .setName('give')
          .setDescription("Add XP to a member's total.")
          .addUserOption((opt) => opt.setName('user').setDescription('Member to adjust.').setRequired(true))
          .addIntegerOption((opt) =>
            opt.setName('amount').setDescription('XP to add.').setMinValue(1).setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription("Subtract XP from a member's total.")
          .addUserOption((opt) => opt.setName('user').setDescription('Member to adjust.').setRequired(true))
          .addIntegerOption((opt) =>
            opt.setName('amount').setDescription('XP to remove.').setMinValue(1).setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription("Set a member's XP total exactly.")
          .addUserOption((opt) => opt.setName('user').setDescription('Member to adjust.').setRequired(true))
          .addIntegerOption((opt) =>
            opt.setName('amount').setDescription('New XP total.').setMinValue(0).setRequired(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('rewards')
      .setDescription('Level-role rewards.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Grant a role when members reach a level.')
          .addIntegerOption((opt) =>
            opt.setName('level').setDescription('Level required.').setMinValue(1).setRequired(true),
          )
          .addRoleOption((opt) => opt.setName('role').setDescription('Role to grant.').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a level-role reward.')
          .addIntegerOption((opt) =>
            opt
              .setName('level')
              .setDescription('Level of the reward to remove.')
              .setMinValue(1)
              .setRequired(true),
          )
          .addRoleOption((opt) =>
            opt.setName('role').setDescription('Role of the reward to remove.').setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List all level-role rewards.'))
      .addSubcommand((sub) =>
        sub.setName('sync').setDescription('Recompute level-role rewards for every ranked member.'),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('ignore')
      .setDescription('Exclude a channel or role from earning XP.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Ignore a channel or role.')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel to ignore.')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum),
          )
          .addRoleOption((opt) => opt.setName('role').setDescription('Role to ignore.')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Stop ignoring a channel or role.')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel to un-ignore.')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum),
          )
          .addRoleOption((opt) => opt.setName('role').setDescription('Role to un-ignore.')),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('multiplier')
      .setDescription('Boost or reduce XP for a role or channel.')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set the XP multiplier for one role or one channel.')
          .addNumberOption((opt) =>
            opt
              .setName('multiplier')
              .setDescription('Factor from 0.25 to 5. The higher of the role and channel factors is used.')
              .setMinValue(0.25)
              .setMaxValue(5)
              .setRequired(true),
          )
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel whose messages or voice time use this factor.')
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.GuildForum,
                ChannelType.GuildVoice,
              ),
          )
          .addRoleOption((opt) => opt.setName('role').setDescription('Role whose members use this factor.')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('clear')
          .setDescription('Remove the XP multiplier from one role or one channel.')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel to clear.')
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.GuildForum,
                ChannelType.GuildVoice,
              ),
          )
          .addRoleOption((opt) => opt.setName('role').setDescription('Role to clear.')),
      ),
  );

function xpBar(xp: number): { level: number; intoLevel: number; span: number; bar: string } {
  const { level, intoLevel, span } = levelProgress(xp);
  return { level, intoLevel, span, bar: formatProgressBar(intoLevel, span) };
}

function formatXpMultiplier(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** `none` when the list is empty, otherwise `<mention> ×2` entries joined with commas. */
function formatXpMultiplierList(
  entries: { id: string; multiplier: number }[],
  mention: (id: string) => string,
): string {
  if (entries.length === 0) return 'none';
  return entries.map((entry) => `${mention(entry.id)} ×${formatXpMultiplier(entry.multiplier)}`).join(', ');
}

/** Renders `leveling.levelUpChannel` for display: the special modes as words, a channel snowflake as `<#id>`. */
function formatLevelUpChannel(levelUpChannel: string, t: (key: string) => string): string {
  if (levelUpChannel === 'current') return t('level.announce.targetCurrent');
  if (levelUpChannel === 'dm') return t('level.announce.targetDm');
  if (levelUpChannel === 'none') return t('level.announce.targetOff');
  if (isSnowflake(levelUpChannel)) return `<#${levelUpChannel}>`;
  return levelUpChannel;
}

async function fetchLeaderboardPage(ctx: PluginContext, guildId: string, page: number) {
  const offset = (page - 1) * LEADERBOARD_PAGE_SIZE;
  const [rows, total] = await Promise.all([
    ctx.prisma.levelProfile.findMany({
      where: { guildId },
      orderBy: { xp: 'desc' },
      skip: offset,
      take: LEADERBOARD_PAGE_SIZE,
    }),
    ctx.prisma.levelProfile.count({ where: { guildId } }),
  ]);
  return { rows, total, offset };
}

function buildLeaderboardEmbed(
  rows: { userId: string; xp: number; level: number }[],
  offset: number,
  total: number,
  page: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): EmbedBuilder {
  const totalPages = Math.max(1, Math.ceil(total / LEADERBOARD_PAGE_SIZE));
  const lines =
    rows.length > 0
      ? rows.map(
          (r, i) =>
            `**#${offset + i + 1}** ${userMention(r.userId)} — level ${r.level} (${r.xp.toLocaleString()} XP)`,
        )
      : [t('level.leaderboard.empty')];
  return listEmbed(t('level.leaderboard.title', { page, totalPages }), lines);
}

function buildLeaderboardRow(
  ownerId: string,
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('engagement', 'lb-page', ownerId, String(page - 1)))
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildCustomId('engagement', 'lb-page', ownerId, String(page + 1)))
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
  );
}

interface ResetPayload {
  targetUserId: string | null; // null = reset everyone
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    const group = c.interaction.options.getSubcommandGroup(false);
    const config = await c.config<EngagementConfig>();

    if (group === 'xp') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);
      const targetUser = c.interaction.options.getUser('user', true);
      const amount = c.interaction.options.getInteger('amount', true);

      const before = await c.ctx.prisma.levelProfile.findUnique({
        where: { guildId_userId: { guildId: c.guildId, userId: targetUser.id } },
      });
      const currentXp = before?.xp ?? 0;
      const nextXp =
        sub === 'give'
          ? currentXp + amount
          : sub === 'remove'
            ? Math.max(0, currentXp - amount)
            : Math.max(0, amount);

      const profile = await c.ctx.prisma.levelProfile.upsert({
        where: { guildId_userId: { guildId: c.guildId, userId: targetUser.id } },
        create: { guildId: c.guildId, userId: targetUser.id, xp: nextXp },
        update: { xp: nextXp },
      });

      const newLevel = levelFromXp(nextXp);
      const previousLevel = before?.level ?? 0;
      const leveledUp = newLevel > previousLevel;
      const levelChanged = newLevel !== previousLevel;
      if (newLevel !== profile.level) {
        await c.ctx.prisma.levelProfile.update({ where: { id: profile.id }, data: { level: newLevel } });
      }

      await c.ctx.audit({
        guildId: c.guildId,
        actorId: c.interaction.user.id,
        actorType: 'user',
        action: `engagement.xp.${sub}`,
        targetType: 'level_profile',
        targetId: targetUser.id,
        before: { xp: currentXp },
        after: { xp: nextXp },
        source: 'bot',
      });

      // Announcements and `level.up` stay level-up only. `remove` and `set` still recompute reward
      // roles when the stored level drops; a level-up (including `set` upward) goes through applyLevelUp,
      // which syncs roles and then announces.
      if (leveledUp) {
        const member = await fetchMemberSafe(c.interaction.guild, targetUser.id);
        await applyLevelUp({
          ctx: c.ctx,
          guild: c.interaction.guild,
          member,
          guildId: c.guildId,
          userId: targetUser.id,
          newLevel,
          config: config.leveling,
        });
      } else if ((sub === 'remove' || sub === 'set') && levelChanged) {
        const member = await fetchMemberSafe(c.interaction.guild, targetUser.id);
        if (member) {
          await syncMemberRewardRoles({
            ctx: c.ctx,
            guildId: c.guildId,
            member,
            level: newLevel,
            mode: config.leveling.rewardMode,
          });
        }
      }

      const key = sub === 'give' ? 'level.xp.given' : sub === 'remove' ? 'level.xp.removed' : 'level.xp.set';
      await c.interaction.reply({
        embeds: [
          successEmbed(c.t(key, { amount, user: userMention(targetUser.id), level: newLevel, xp: nextXp })),
        ],
        ephemeral: true,
      });
      return;
    }

    if (group === 'rewards') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);

      if (sub === 'add') {
        const level = c.interaction.options.getInteger('level', true);
        const role = c.interaction.options.getRole('role', true);
        const reward = await c.ctx.prisma.levelReward.create({
          data: { guildId: c.guildId, level, roleId: role.id },
        });
        await c.ctx.audit({
          guildId: c.guildId,
          actorId: c.interaction.user.id,
          actorType: 'user',
          action: 'engagement.reward.create',
          targetType: 'level_reward',
          targetId: reward.id,
          after: { level, roleId: role.id },
          source: 'bot',
        });
        await c.interaction.reply({
          embeds: [successEmbed(c.t('level.rewards.added', { level, role: `<@&${role.id}>` }))],
          ephemeral: true,
        });
        return;
      }

      if (sub === 'remove') {
        const level = c.interaction.options.getInteger('level', true);
        const role = c.interaction.options.getRole('role', true);
        const existing = await c.ctx.prisma.levelReward.findFirst({
          where: { guildId: c.guildId, level, roleId: role.id },
        });
        if (!existing) {
          await c.interaction.reply({ embeds: [errorEmbed(c.t('level.rewards.notFound'))], ephemeral: true });
          return;
        }
        await c.ctx.prisma.levelReward.delete({ where: { id: existing.id } });
        await c.ctx.audit({
          guildId: c.guildId,
          actorId: c.interaction.user.id,
          actorType: 'user',
          action: 'engagement.reward.delete',
          targetType: 'level_reward',
          targetId: existing.id,
          source: 'bot',
        });
        await c.interaction.reply({ embeds: [successEmbed(c.t('level.rewards.removed'))], ephemeral: true });
        return;
      }

      if (sub === 'list') {
        const rewards = await c.ctx.prisma.levelReward.findMany({
          where: { guildId: c.guildId },
          orderBy: { level: 'asc' },
        });
        const lines =
          rewards.length > 0
            ? rewards.map((r) => `Level ${r.level} → <@&${r.roleId}>`)
            : [c.t('level.rewards.empty')];
        await c.interaction.reply({ embeds: [listEmbed('Level rewards', lines)], ephemeral: true });
        return;
      }

      // sub === 'sync'
      // Every ranked member can cost a member fetch plus two role writes, so this blows past Discord's
      // 3-second ack deadline on any real server — defer first, and cap the pass so one command can never
      // fan out an unbounded number of role writes into the shared REST queue.
      await c.interaction.deferReply({ ephemeral: true });
      const rewards = await c.ctx.prisma.levelReward.findMany({ where: { guildId: c.guildId } });
      // One row over the cap, so "were there more?" is answered without a second query.
      const ranked = await c.ctx.prisma.levelProfile.findMany({
        where: { guildId: c.guildId, level: { gt: 0 } },
        orderBy: { xp: 'desc' },
        take: REWARD_SYNC_LIMIT + 1,
      });
      const capped = ranked.length > REWARD_SYNC_LIMIT;
      const profiles = capped ? ranked.slice(0, REWARD_SYNC_LIMIT) : ranked;
      let synced = 0;
      for (const profile of profiles) {
        const member = await fetchMemberSafe(c.interaction.guild, profile.userId);
        if (!member) continue;
        const wrote = await syncMemberRewardRoles({
          ctx: c.ctx,
          guildId: c.guildId,
          member,
          level: profile.level,
          mode: config.leveling.rewardMode,
          rewards,
          addReason: 'Pavisie engagement: /level rewards sync',
          removeReason: 'Pavisie engagement: /level rewards sync',
        });
        if (wrote) synced += 1;
      }
      await c.interaction.editReply({
        embeds: [
          successEmbed(
            capped
              ? c.t('level.rewards.syncCapped', { count: synced, limit: REWARD_SYNC_LIMIT })
              : c.t('level.rewards.syncDone', { count: synced }),
          ),
        ],
      });
      return;
    }

    if (group === 'ignore') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);
      const channel = c.interaction.options.getChannel('channel', false);
      const role = c.interaction.options.getRole('role', false);
      if ((!channel && !role) || (channel && role)) {
        await c.interaction.reply({
          embeds: [errorEmbed(c.t('errors.needExactlyOneOption'))],
          ephemeral: true,
        });
        return;
      }

      const adding = sub === 'add';
      if (channel) {
        const ids = new Set(config.leveling.ignoredChannelIds);
        if (adding) ids.add(channel.id);
        else ids.delete(channel.id);
        await c.ctx.setConfig<EngagementConfig>(
          c.guildId,
          { leveling: { ...config.leveling, ignoredChannelIds: [...ids] } },
          { id: c.interaction.user.id, source: 'bot' },
        );
        await c.interaction.reply({
          embeds: [
            successEmbed(
              c.t(adding ? 'level.ignore.addedChannel' : 'level.ignore.removedChannel', {
                channel: `<#${channel.id}>`,
              }),
            ),
          ],
          ephemeral: true,
        });
        return;
      }
      if (role) {
        const ids = new Set(config.leveling.ignoredRoleIds);
        if (adding) ids.add(role.id);
        else ids.delete(role.id);
        await c.ctx.setConfig<EngagementConfig>(
          c.guildId,
          { leveling: { ...config.leveling, ignoredRoleIds: [...ids] } },
          { id: c.interaction.user.id, source: 'bot' },
        );
        await c.interaction.reply({
          embeds: [
            successEmbed(
              c.t(adding ? 'level.ignore.addedRole' : 'level.ignore.removedRole', { role: `<@&${role.id}>` }),
            ),
          ],
          ephemeral: true,
        });
        return;
      }
      return;
    }

    if (group === 'multiplier') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);
      const channel = c.interaction.options.getChannel('channel', false);
      const role = c.interaction.options.getRole('role', false);
      if ((!channel && !role) || (channel && role)) {
        await c.interaction.reply({
          embeds: [errorEmbed(c.t('errors.needExactlyOneOption'))],
          ephemeral: true,
        });
        return;
      }

      const id = channel ? channel.id : role!.id;
      const key = channel ? 'channelMultipliers' : 'roleMultipliers';
      const mention = channel ? `<#${id}>` : `<@&${id}>`;
      const current = config.leveling[key];

      if (sub === 'clear') {
        await c.ctx.setConfig<EngagementConfig>(
          c.guildId,
          { leveling: { ...config.leveling, [key]: current.filter((entry) => entry.id !== id) } },
          { id: c.interaction.user.id, source: 'bot' },
        );
        await c.interaction.reply({
          embeds: [
            successEmbed(
              c.t(channel ? 'level.multiplier.clearedChannel' : 'level.multiplier.clearedRole', {
                channel: mention,
                role: mention,
              }),
            ),
          ],
          ephemeral: true,
        });
        return;
      }

      const multiplier = clampXpMultiplier(c.interaction.options.getNumber('multiplier', true));
      await c.ctx.setConfig<EngagementConfig>(
        c.guildId,
        {
          leveling: {
            ...config.leveling,
            [key]: [...current.filter((entry) => entry.id !== id), { id, multiplier }],
          },
        },
        { id: c.interaction.user.id, source: 'bot' },
      );
      await c.interaction.reply({
        embeds: [
          successEmbed(
            c.t(channel ? 'level.multiplier.setChannel' : 'level.multiplier.setRole', {
              channel: mention,
              role: mention,
              multiplier: formatXpMultiplier(multiplier),
            }),
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    // Top-level subcommands.
    if (sub === 'rank') {
      const target = c.interaction.options.getUser('user') ?? c.interaction.user;
      const profile = await c.ctx.prisma.levelProfile.findUnique({
        where: { guildId_userId: { guildId: c.guildId, userId: target.id } },
      });
      if (!profile) {
        await c.interaction.reply({
          embeds: [brandEmbed().setDescription(c.t('level.rank.notRanked', { name: target.username }))],
          ephemeral: false,
        });
        return;
      }
      const rank =
        1 +
        (await c.ctx.prisma.levelProfile.count({ where: { guildId: c.guildId, xp: { gt: profile.xp } } }));
      const { level, intoLevel, span, bar } = xpBar(profile.xp);
      const embed = brandEmbed()
        .setTitle(c.t('level.rank.title', { name: target.username }))
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: 'Rank', value: `#${rank}`, inline: true },
          { name: 'Level', value: String(level), inline: true },
          { name: 'Total XP', value: profile.xp.toLocaleString(), inline: true },
          {
            name: 'Progress',
            value: `${bar}\n${intoLevel.toLocaleString()} / ${span.toLocaleString()} XP to next level`,
            inline: false,
          },
          { name: 'Messages', value: profile.messages.toLocaleString(), inline: true },
          { name: 'Voice minutes', value: profile.voiceMinutes.toLocaleString(), inline: true },
        );
      await c.interaction.reply({ embeds: [embed], ephemeral: false });
      return;
    }

    if (sub === 'leaderboard') {
      const page = Math.max(1, c.interaction.options.getInteger('page') ?? 1);
      const { rows, total, offset } = await fetchLeaderboardPage(c.ctx, c.guildId, page);
      const totalPages = Math.max(1, Math.ceil(total / LEADERBOARD_PAGE_SIZE));
      const embed = buildLeaderboardEmbed(rows, offset, total, page, c.t);
      const components = totalPages > 1 ? [buildLeaderboardRow(c.interaction.user.id, page, totalPages)] : [];
      await c.interaction.reply({ embeds: [embed], components, ephemeral: false });
      return;
    }

    if (sub === 'config') {
      assertStaffLevel(c.staffLevel, 'moderator', c.t);
      const l = config.leveling;
      const lines = [
        `Enabled: ${l.enabled ? 'Yes' : 'No'}`,
        `XP per message: ${l.xpPerMessageMin}–${l.xpPerMessageMax}`,
        `XP cooldown: ${l.xpCooldownSeconds}s`,
        `Max XP/hour: ${l.maxXpPerHour}`,
        `Voice XP/minute: ${l.voiceXpPerMinute}`,
        `Level-up announcement: ${formatLevelUpChannel(l.levelUpChannel, c.t)}`,
        `Reward mode: ${l.rewardMode}`,
        `Ignored channels: ${l.ignoredChannelIds.length}`,
        `Ignored roles: ${l.ignoredRoleIds.length}`,
        `Role XP multipliers: ${formatXpMultiplierList(l.roleMultipliers, (id) => `<@&${id}>`)}`,
        `Channel XP multipliers: ${formatXpMultiplierList(l.channelMultipliers, (id) => `<#${id}>`)}`,
        'XP factor: the higher of the best matching role and the best matching channel (not multiplied). A thread counts its own channel and its parent. Message XP is rolled, multiplied, floored, then limited by the hourly cap. Voice XP uses the same factor.',
      ];
      await c.interaction.reply({ embeds: [listEmbed(c.t('level.config.title'), lines)], ephemeral: true });
      return;
    }

    if (sub === 'announce') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);
      const mode = c.interaction.options.getString('mode', true);
      const channelOption = c.interaction.options.getChannel('channel', false);

      let levelUpChannel: string;
      if (mode === 'same-channel') {
        levelUpChannel = 'current';
      } else if (mode === 'dm') {
        levelUpChannel = 'dm';
      } else if (mode === 'off') {
        levelUpChannel = 'none';
      } else {
        // mode === 'channel'
        if (!channelOption) {
          await c.interaction.reply({
            embeds: [errorEmbed(c.t('level.announce.channelRequired'))],
            ephemeral: true,
          });
          return;
        }
        const resolved = await resolveTextChannel(c.interaction.guild, channelOption.id);
        if (!resolved) {
          await c.interaction.reply({
            embeds: [errorEmbed(c.t('level.announce.channelNotUsable'))],
            ephemeral: true,
          });
          return;
        }
        levelUpChannel = resolved.id;
      }

      await c.ctx.setConfig<EngagementConfig>(
        c.guildId,
        { leveling: { ...config.leveling, levelUpChannel } },
        { id: c.interaction.user.id, source: 'bot' },
      );

      await c.interaction.reply({
        embeds: [
          successEmbed(c.t('level.announce.updated', { target: formatLevelUpChannel(levelUpChannel, c.t) })),
        ],
        ephemeral: true,
      });
      return;
    }

    // sub === 'reset'
    assertStaffLevel(c.staffLevel, 'admin', c.t);
    const targetUser = c.interaction.options.getUser('user');
    const payload: ResetPayload = { targetUserId: targetUser?.id ?? null };
    const embed = brandEmbed()
      .setTitle(c.t('level.reset.confirmTitle'))
      .setDescription(
        targetUser
          ? c.t('level.reset.confirmDescriptionUser', { user: userMention(targetUser.id) })
          : c.t('level.reset.confirmDescriptionAll'),
      );

    const guildConfig = await c.ctx.services.get('host')?.getGuildConfig(c.guildId);
    const result = await requestConfirmation({
      interaction: c.interaction,
      ctx: c.ctx,
      pluginId: 'engagement',
      action: 'level-reset',
      ownerId: c.interaction.user.id,
      embed,
      payload,
      fastActions: Boolean(guildConfig?.fastActions),
    });

    if (result.confirmed) {
      const count = await performReset(
        c.ctx,
        c.interaction.guild,
        c.guildId,
        c.interaction.user.id,
        result.payload,
        config.leveling.rewardMode,
      );
      await c.interaction.reply({
        embeds: [
          successEmbed(
            result.payload.targetUserId
              ? c.t('level.reset.doneUser', { user: userMention(result.payload.targetUserId) })
              : c.t('level.reset.doneAll', { count }),
          ),
        ],
        ephemeral: true,
      });
    }
  },
};

async function performReset(
  ctx: PluginContext,
  guild: Guild,
  guildId: string,
  actorId: string,
  payload: ResetPayload,
  rewardMode: EngagementConfig['leveling']['rewardMode'],
): Promise<number> {
  const where = payload.targetUserId ? { guildId, userId: payload.targetUserId } : { guildId };
  // Role removal is capped like `/level rewards sync` (highest XP first). The profile delete is not:
  // every matching row goes, even when more than the cap still hold reward roles.
  const rewards = await ctx.prisma.levelReward.findMany({ where: { guildId } });
  const profiles = await ctx.prisma.levelProfile.findMany({
    where,
    orderBy: { xp: 'desc' },
    take: REWARD_SYNC_LIMIT,
  });
  for (const profile of profiles) {
    const member = await fetchMemberSafe(guild, profile.userId);
    if (!member) continue;
    await syncMemberRewardRoles({
      ctx,
      guildId,
      member,
      level: 0,
      mode: rewardMode,
      rewards,
      addReason: 'Pavisie engagement: /level reset',
      removeReason: 'Pavisie engagement: /level reset',
    });
  }
  const result = await ctx.prisma.levelProfile.deleteMany({ where });
  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: 'engagement.level.reset',
    targetType: 'level_profile',
    targetId: payload.targetUserId ?? 'all',
    after: { count: result.count },
    source: 'bot',
  });
  return result.count;
}

const [confirmReset, cancelReset] = registerConfirmHandlers<ResetPayload>(
  'level-reset',
  async (c, payload) => {
    const config = await c.config<EngagementConfig>();
    const count = await performReset(
      c.ctx,
      c.interaction.guild,
      c.guildId,
      c.interaction.user.id,
      payload,
      config.leveling.rewardMode,
    );
    await c.interaction.followUp({
      embeds: [
        successEmbed(
          payload.targetUserId
            ? c.t('level.reset.doneUser', { user: userMention(payload.targetUserId) })
            : c.t('level.reset.doneAll', { count }),
        ),
      ],
      ephemeral: true,
    });
  },
);

const leaderboardPageComponent: ComponentHandler = {
  action: 'lb-page',
  kind: 'button',
  ownerOnly: true,
  async handler(c) {
    const interaction = c.interaction as ButtonInteraction<'cached'>;
    const [ownerId, pageStr] = c.args;
    const page = Math.max(1, Number(pageStr) || 1);
    const { rows, total, offset } = await fetchLeaderboardPage(c.ctx, c.guildId, page);
    const totalPages = Math.max(1, Math.ceil(total / LEADERBOARD_PAGE_SIZE));
    const embed = buildLeaderboardEmbed(rows, offset, total, page, c.t);
    await interaction.update({
      embeds: [embed],
      components: [buildLeaderboardRow(ownerId, page, totalPages)],
    });
  },
};

export const levelComponents: ComponentHandler[] = [confirmReset, cancelReset, leaderboardPageComponent];
