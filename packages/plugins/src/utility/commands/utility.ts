import {
  ChannelType,
  GuildVerificationLevel,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
  type User,
} from 'discord.js';
import { discordTimestamp, redisKey } from '@pavisie/core';
import {
  brandEmbed,
  errorEmbed,
  infoEmbed,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import type { UtilityConfig } from '../manifest';
import { CalculatorError, evaluateExpression, formatCalculatorResult } from '../calculator';
import { describeChannelType, formatRoleColor, summarizePermissions } from '../format';
import {
  isValidIanaTimezone,
  listIanaTimezones,
  parseTimestampInput,
  TimestampParseError,
} from '../timestamp';
import { getTranslateAdapter, TranslateAdapterError } from '../adapters/translate';
import { getWeatherAdapter, WeatherAdapterError, type WeatherResult } from '../adapters/weather';

const TIMESTAMP_STYLES: { style: 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R'; label: string }[] = [
  { style: 't', label: 'Short time' },
  { style: 'T', label: 'Long time' },
  { style: 'd', label: 'Short date' },
  { style: 'D', label: 'Long date' },
  { style: 'f', label: 'Short date/time' },
  { style: 'F', label: 'Long date/time' },
  { style: 'R', label: 'Relative' },
];

const WEATHER_CACHE_TTL_SECONDS = 10 * 60;

const data = new SlashCommandBuilder()
  .setName('utility')
  .setDescription('General-purpose utility commands.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('userinfo')
      .setDescription('Show information about a member.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The member to look up (defaults to you)').setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName('serverinfo').setDescription('Show information about this server.'))
  .addSubcommand((sub) =>
    sub
      .setName('avatar')
      .setDescription("Show a member's avatar.")
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The member to look up (defaults to you)').setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('server-avatar')
          .setDescription('Show the server-specific avatar instead of the global one')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('banner')
      .setDescription("Show a member's profile banner.")
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The member to look up (defaults to you)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('roleinfo')
      .setDescription('Show information about a role.')
      .addRoleOption((opt) => opt.setName('role').setDescription('The role to look up').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('channelinfo')
      .setDescription('Show information about a channel.')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('The channel to look up (defaults to this channel)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('timestamp')
      .setDescription('Parse a date/time and get Discord <t:...> tags for it.')
      .addStringOption((opt) =>
        opt
          .setName('text')
          .setDescription('Date/time, e.g. "2027-03-05 15:00" or "March 5 2027 3pm"')
          .setRequired(true)
          .setMaxLength(100),
      )
      .addStringOption((opt) =>
        opt
          .setName('timezone')
          .setDescription('IANA timezone, e.g. America/New_York (defaults to your saved timezone, else UTC)')
          .setRequired(false)
          .setAutocomplete(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('timezone')
      .setDescription('Manage your saved timezone.')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Save your timezone (used by /utility timestamp).')
          .addStringOption((opt) =>
            opt
              .setName('timezone')
              .setDescription('IANA timezone, e.g. Europe/London')
              .setRequired(true)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('get')
          .setDescription('Show a saved timezone.')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Whose timezone to show (defaults to you)').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('Search IANA timezone names.')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('Filter, e.g. "America" or "London"').setRequired(false),
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('calculator')
      .setDescription('Evaluate a math expression.')
      .addStringOption((opt) =>
        opt
          .setName('expression')
          .setDescription('e.g. "2 * (3 + 4) ^ 2" or "sqrt(2)"')
          .setRequired(true)
          .setMaxLength(200),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('afk')
      .setDescription('Toggle AFK status. While AFK, the bot replies to your mentions with your message.')
      .addStringOption((opt) =>
        opt.setName('message').setDescription('Optional AFK message').setRequired(false).setMaxLength(200),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('translate')
      .setDescription('Translate text (requires a configured translation provider).')
      .addStringOption((opt) =>
        opt.setName('text').setDescription('Text to translate').setRequired(true).setMaxLength(1000),
      )
      .addStringOption((opt) =>
        opt
          .setName('to')
          .setDescription('Target language code, e.g. "en", "es", "fr"')
          .setRequired(true)
          .setMaxLength(10),
      )
      .addStringOption((opt) =>
        opt
          .setName('from')
          .setDescription('Source language code (auto-detected if omitted)')
          .setRequired(false)
          .setMaxLength(10),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('weather')
      .setDescription('Show current weather (requires a configured weather provider).')
      .addStringOption((opt) =>
        opt.setName('location').setDescription('City or place name').setRequired(true).setMaxLength(200),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription("Show the bot's health and per-plugin status."),
  );

function resolveTargetUser(interaction: ChatInputCommandInteraction<'cached'>): User {
  return interaction.options.getUser('user') ?? interaction.user;
}

// ---------------------------------------------------------------------------
// userinfo
// ---------------------------------------------------------------------------

export function buildUserInfoEmbed(user: User, member: GuildMember | null): EmbedBuilder {
  const embed = brandEmbed()
    .setTitle(`User info — ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ size: 512 }))
    .addFields(
      { name: 'ID', value: user.id, inline: true },
      { name: 'Bot?', value: user.bot ? 'Yes' : 'No', inline: true },
      { name: 'Account created', value: discordTimestamp(user.createdAt, 'f'), inline: false },
    );

  if (!member) {
    embed.addFields({ name: 'Membership', value: 'This user is not currently a member of this server.' });
    return embed;
  }

  const roles = member.roles.cache
    .filter((role) => role.id !== member.guild.id)
    .sort((a, b) => b.position - a.position);
  const topRoles = roles.map((role) => `<@&${role.id}>`).slice(0, 10);

  embed.addFields(
    {
      name: 'Joined server',
      value: member.joinedAt ? discordTimestamp(member.joinedAt, 'f') : 'Unknown',
      inline: false,
    },
    {
      name: `Roles (${roles.size})`,
      value: topRoles.length > 0 ? topRoles.join(', ') : '_None_',
      inline: false,
    },
    { name: 'Permissions', value: summarizePermissions(member.permissions), inline: false },
    {
      name: 'Boosting since',
      value: member.premiumSince ? discordTimestamp(member.premiumSince, 'f') : 'Not boosting',
      inline: true,
    },
  );

  if (member.nickname) {
    embed.addFields({ name: 'Nickname', value: member.nickname, inline: true });
  }
  if (member.communicationDisabledUntil && member.communicationDisabledUntil.getTime() > Date.now()) {
    embed.addFields({
      name: 'Timed out until',
      value: discordTimestamp(member.communicationDisabledUntil, 'f'),
      inline: true,
    });
  }

  return embed;
}

async function handleUserInfo(c: CommandContext): Promise<void> {
  const user = resolveTargetUser(c.interaction);
  const member =
    c.interaction.options.getMember('user') ??
    (user.id === c.interaction.user.id ? c.interaction.member : null);
  await c.interaction.reply({ embeds: [buildUserInfoEmbed(user, member)], ephemeral: false });
}

// ---------------------------------------------------------------------------
// serverinfo
// ---------------------------------------------------------------------------

function buildServerInfoEmbed(guild: Guild): EmbedBuilder {
  const embed = brandEmbed().setTitle(`Server info — ${guild.name}`);
  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 512 }));

  embed.addFields(
    { name: 'ID', value: guild.id, inline: true },
    { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
    { name: 'Created', value: discordTimestamp(guild.createdAt, 'f'), inline: false },
    { name: 'Members', value: String(guild.memberCount), inline: true },
    { name: 'Channels', value: String(guild.channels.cache.size), inline: true },
    { name: 'Roles', value: String(guild.roles.cache.size), inline: true },
    { name: 'Emojis', value: String(guild.emojis.cache.size), inline: true },
    { name: 'Boost tier', value: `Tier ${guild.premiumTier}`, inline: true },
    { name: 'Boosts', value: String(guild.premiumSubscriptionCount ?? 0), inline: true },
    { name: 'Verification level', value: GuildVerificationLevel[guild.verificationLevel], inline: true },
  );

  if (guild.description) {
    embed.addFields({ name: 'Description', value: guild.description });
  }

  return embed;
}

async function handleServerInfo(c: CommandContext): Promise<void> {
  await c.interaction.reply({ embeds: [buildServerInfoEmbed(c.interaction.guild)], ephemeral: false });
}

// ---------------------------------------------------------------------------
// avatar / banner
// ---------------------------------------------------------------------------

async function handleAvatar(c: CommandContext): Promise<void> {
  const user = resolveTargetUser(c.interaction);
  const member =
    c.interaction.options.getMember('user') ??
    (user.id === c.interaction.user.id ? c.interaction.member : null);
  const wantsServerAvatar = c.interaction.options.getBoolean('server-avatar') ?? false;

  const serverAvatarUrl = wantsServerAvatar ? (member?.avatarURL({ size: 4096 }) ?? null) : null;
  const url = serverAvatarUrl ?? user.displayAvatarURL({ size: 4096 });

  const embed = brandEmbed()
    .setTitle(`${wantsServerAvatar && serverAvatarUrl ? 'Server avatar' : 'Avatar'} — ${user.tag}`)
    .setImage(url);

  if (wantsServerAvatar && !serverAvatarUrl) {
    embed.setFooter({
      text: 'This user has no server-specific avatar; showing their global avatar instead.',
    });
  }

  await c.interaction.reply({ embeds: [embed], ephemeral: false });
}

async function handleBanner(c: CommandContext): Promise<void> {
  const targetUser = resolveTargetUser(c.interaction);

  let fullUser: User;
  try {
    fullUser = await c.interaction.client.users.fetch(targetUser.id, { force: true });
  } catch {
    await c.interaction.reply({ embeds: [errorEmbed('Could not fetch that user.')], ephemeral: true });
    return;
  }

  const bannerUrl = fullUser.bannerURL({ size: 4096 });
  if (!bannerUrl) {
    await c.interaction.reply({
      embeds: [infoEmbed('No banner', `${fullUser.tag} does not have a profile banner set.`)],
      ephemeral: false,
    });
    return;
  }

  await c.interaction.reply({
    embeds: [brandEmbed().setTitle(`Banner — ${fullUser.tag}`).setImage(bannerUrl)],
    ephemeral: false,
  });
}

// ---------------------------------------------------------------------------
// roleinfo / channelinfo
// ---------------------------------------------------------------------------

function buildRoleInfoEmbed(role: Role): EmbedBuilder {
  const color = formatRoleColor(role.hexColor);
  const embed = brandEmbed().setTitle(`Role info — ${role.name}`);
  if (color) embed.setColor(role.color);

  embed.addFields(
    { name: 'ID', value: role.id, inline: true },
    { name: 'Color', value: color ?? '_Default_', inline: true },
    { name: 'Position', value: String(role.position), inline: true },
    { name: 'Members (cached)', value: String(role.members.size), inline: true },
    { name: 'Hoisted', value: role.hoist ? 'Yes' : 'No', inline: true },
    { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
    { name: 'Managed (bot/integration)', value: role.managed ? 'Yes' : 'No', inline: true },
    { name: 'Created', value: discordTimestamp(role.createdAt, 'f'), inline: false },
  );

  return embed;
}

async function handleRoleInfo(c: CommandContext): Promise<void> {
  const role = c.interaction.options.getRole('role', true) as Role;
  await c.interaction.reply({ embeds: [buildRoleInfoEmbed(role)], ephemeral: false });
}

function buildChannelInfoEmbed(channel: GuildBasedChannel): EmbedBuilder {
  const embed = brandEmbed().setTitle(`Channel info — #${channel.name}`);
  embed.addFields(
    { name: 'ID', value: channel.id, inline: true },
    { name: 'Type', value: describeChannelType(channel.type), inline: true },
    { name: 'Category', value: channel.parentId ? `<#${channel.parentId}>` : '_None_', inline: true },
    { name: 'Created', value: discordTimestamp(channel.createdAt ?? new Date(), 'f'), inline: false },
  );
  // Threads (Public/Private/AnnouncementThread) have no `.position` — regular guild channels do.
  if ('position' in channel) {
    embed.addFields({ name: 'Position', value: String(channel.position), inline: true });
  }

  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    embed.addFields(
      { name: 'Topic', value: channel.topic ?? '_None_', inline: false },
      { name: 'NSFW', value: channel.nsfw ? 'Yes' : 'No', inline: true },
      {
        name: 'Slowmode',
        value: channel.rateLimitPerUser ? `${channel.rateLimitPerUser}s` : 'Off',
        inline: true,
      },
    );
  } else if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
    embed.addFields(
      { name: 'Bitrate', value: `${Math.round(channel.bitrate / 1000)} kbps`, inline: true },
      {
        name: 'User limit',
        value: channel.userLimit > 0 ? String(channel.userLimit) : 'Unlimited',
        inline: true,
      },
    );
  }

  return embed;
}

async function handleChannelInfo(c: CommandContext): Promise<void> {
  const channelOption = c.interaction.options.getChannel('channel');
  const channel = (channelOption ?? c.interaction.channel) as GuildBasedChannel | null;
  if (!channel) {
    await c.interaction.reply({ embeds: [errorEmbed('Could not resolve that channel.')], ephemeral: true });
    return;
  }
  await c.interaction.reply({ embeds: [buildChannelInfoEmbed(channel)], ephemeral: false });
}

// ---------------------------------------------------------------------------
// timestamp
// ---------------------------------------------------------------------------

async function resolveUserTimezone(c: CommandContext): Promise<string> {
  const profile = await c.ctx.prisma.userProfile.findUnique({ where: { id: c.interaction.user.id } });
  return profile?.timezone ?? 'UTC';
}

async function handleTimestamp(c: CommandContext): Promise<void> {
  const text = c.interaction.options.getString('text', true);
  const explicitZone = c.interaction.options.getString('timezone');
  const zone = explicitZone ?? (await resolveUserTimezone(c));

  let parsed;
  try {
    parsed = parseTimestampInput(text, zone);
  } catch (err) {
    const message = err instanceof TimestampParseError ? err.message : 'Could not parse that date/time.';
    await c.interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
    return;
  }

  const unixSeconds = Math.floor(parsed.toMillis() / 1000);
  const lines = TIMESTAMP_STYLES.map(
    ({ style, label }) =>
      `**${label}**: \`<t:${unixSeconds}:${style}>\` → ${discordTimestamp(parsed.toJSDate(), style)}`,
  );

  await c.interaction.reply({
    embeds: [infoEmbed(`Timestamp — ${zone}`, lines.join('\n'))],
    ephemeral: false,
  });
}

// ---------------------------------------------------------------------------
// timezone set|get|list
// ---------------------------------------------------------------------------

async function handleTimezoneSet(c: CommandContext): Promise<void> {
  const zone = c.interaction.options.getString('timezone', true);
  if (!isValidIanaTimezone(zone)) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('timezone.invalid'))], ephemeral: true });
    return;
  }

  await c.ctx.prisma.userProfile.upsert({
    where: { id: c.interaction.user.id },
    create: { id: c.interaction.user.id, username: c.interaction.user.username, timezone: zone },
    update: { timezone: zone },
  });

  await c.interaction.reply({
    embeds: [successEmbed(`Your timezone is now set to **${zone}**.`)],
    ephemeral: true,
  });
}

async function handleTimezoneGet(c: CommandContext): Promise<void> {
  const target = c.interaction.options.getUser('user') ?? c.interaction.user;
  const profile = await c.ctx.prisma.userProfile.findUnique({ where: { id: target.id } });

  const message = profile?.timezone
    ? `${target.id === c.interaction.user.id ? 'Your' : `${target.tag}'s`} saved timezone is **${profile.timezone}**.`
    : `${target.id === c.interaction.user.id ? "You haven't" : `${target.tag} hasn't`} saved a timezone yet. Use \`/utility timezone set\`.`;

  await c.interaction.reply({ embeds: [infoEmbed('Timezone', message)], ephemeral: true });
}

async function handleTimezoneList(c: CommandContext): Promise<void> {
  const query = (c.interaction.options.getString('query') ?? '').toLowerCase();
  const matches = listIanaTimezones()
    .filter((zone) => zone.toLowerCase().includes(query))
    .slice(0, 25);

  await c.interaction.reply({
    embeds: [
      infoEmbed(
        'IANA timezones',
        matches.length > 0 ? matches.map((z) => `\`${z}\``).join(', ') : 'No matching timezones found.',
      ),
    ],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// calculator
// ---------------------------------------------------------------------------

async function handleCalculator(c: CommandContext): Promise<void> {
  const expression = c.interaction.options.getString('expression', true);
  try {
    const result = evaluateExpression(expression);
    await c.interaction.reply({
      embeds: [
        brandEmbed()
          .setTitle('Calculator')
          .addFields(
            { name: 'Expression', value: `\`${expression}\`` },
            { name: 'Result', value: `\`${formatCalculatorResult(result)}\`` },
          ),
      ],
      ephemeral: true,
    });
  } catch (err) {
    const message = err instanceof CalculatorError ? err.message : 'Could not evaluate that expression.';
    await c.interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
  }
}

// ---------------------------------------------------------------------------
// afk
// ---------------------------------------------------------------------------

async function handleAfk(c: CommandContext): Promise<void> {
  const config = await c.config<UtilityConfig>();
  if (!config.afkEnabled) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('afk.disabled'))], ephemeral: true });
    return;
  }

  const existing = await c.ctx.prisma.afkStatus.findUnique({
    where: { guildId_userId: { guildId: c.guildId, userId: c.interaction.user.id } },
  });

  if (existing) {
    await c.ctx.prisma.afkStatus.delete({
      where: { guildId_userId: { guildId: c.guildId, userId: c.interaction.user.id } },
    });
    await c.interaction.reply({ embeds: [successEmbed(c.t('afk.welcomeBack'))], ephemeral: true });
    return;
  }

  const message = c.interaction.options.getString('message');
  await c.ctx.prisma.afkStatus.create({
    data: { guildId: c.guildId, userId: c.interaction.user.id, message: message ?? null },
  });

  await c.interaction.reply({
    embeds: [successEmbed(c.t('afk.nowAfk', { suffix: message ? `: ${message}` : '' }))],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// translate
// ---------------------------------------------------------------------------

async function handleTranslate(c: CommandContext): Promise<void> {
  const adapter = getTranslateAdapter(c.ctx.env);
  if (!adapter) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('translate.notConfigured'))], ephemeral: true });
    return;
  }

  const cooldown = await c.ctx.rateLimiter.consume(`utility:translate:${c.interaction.user.id}`, 1, 5000);
  if (!cooldown.allowed) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('translate.tooFast'))], ephemeral: true });
    return;
  }

  const text = c.interaction.options.getString('text', true);
  const to = c.interaction.options.getString('to', true);
  const from = c.interaction.options.getString('from') ?? undefined;

  try {
    const result = await adapter.translate(text, to, from);
    const embed = brandEmbed()
      .setTitle('Translation')
      .addFields(
        {
          name: `Original${result.detectedSourceLanguage ? ` (${result.detectedSourceLanguage})` : from ? ` (${from})` : ''}`,
          value: text.slice(0, 1024),
        },
        { name: `Translated (${to})`, value: result.translatedText.slice(0, 1024) },
      )
      .setFooter({ text: `via ${result.provider}` });
    await c.interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    const message = err instanceof TranslateAdapterError ? err.message : 'Translation failed.';
    await c.interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
  }
}

// ---------------------------------------------------------------------------
// weather
// ---------------------------------------------------------------------------

function buildWeatherEmbed(result: WeatherResult): EmbedBuilder {
  const tempUnit = result.units === 'imperial' ? '°F' : '°C';
  const windUnit = result.units === 'imperial' ? 'mph' : 'km/h';

  const embed = brandEmbed()
    .setTitle(`Weather — ${result.locationName}`)
    .setDescription(result.conditionDescription);
  embed.addFields({
    name: 'Temperature',
    value: `${Math.round(result.temperature)}${tempUnit}`,
    inline: true,
  });
  if (result.feelsLike !== undefined)
    embed.addFields({
      name: 'Feels like',
      value: `${Math.round(result.feelsLike)}${tempUnit}`,
      inline: true,
    });
  if (result.humidityPercent !== undefined)
    embed.addFields({ name: 'Humidity', value: `${result.humidityPercent}%`, inline: true });
  if (result.windSpeed !== undefined)
    embed.addFields({ name: 'Wind', value: `${Math.round(result.windSpeed)} ${windUnit}`, inline: true });
  embed.setFooter({ text: `via ${result.provider}` });
  return embed;
}

async function handleWeather(c: CommandContext): Promise<void> {
  const adapter = getWeatherAdapter(c.ctx.env);
  if (!adapter) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('weather.notConfigured'))], ephemeral: true });
    return;
  }

  const location = c.interaction.options.getString('location', true);
  const config = await c.config<UtilityConfig>();
  const cacheKey = redisKey('utility', 'weather', config.weatherUnits, location.trim().toLowerCase());

  const cached = await c.ctx.redis.get(cacheKey);
  if (cached) {
    await c.interaction.reply({
      embeds: [buildWeatherEmbed(JSON.parse(cached) as WeatherResult)],
      ephemeral: false,
    });
    return;
  }

  const cooldown = await c.ctx.rateLimiter.consume(`utility:weather:${c.interaction.user.id}`, 1, 5000);
  if (!cooldown.allowed) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('weather.tooFast'))], ephemeral: true });
    return;
  }

  try {
    const result = await adapter.getWeather(location, config.weatherUnits);
    await c.ctx.redis.set(cacheKey, JSON.stringify(result), 'EX', WEATHER_CACHE_TTL_SECONDS);
    await c.interaction.reply({ embeds: [buildWeatherEmbed(result)], ephemeral: false });
  } catch (err) {
    const message = err instanceof WeatherAdapterError ? err.message : 'Could not fetch the weather.';
    await c.interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function healthEmoji(status: 'ok' | 'degraded' | 'unavailable' | 'disabled'): string {
  switch (status) {
    case 'ok':
      return '🟢';
    case 'degraded':
      return '🟡';
    case 'unavailable':
      return '🔴';
    default:
      return '⚪';
  }
}

async function handleStatus(c: CommandContext): Promise<void> {
  const host = c.ctx.services.get('host');
  if (!host) {
    await c.interaction.reply({
      embeds: [errorEmbed('Status is not available right now.')],
      ephemeral: true,
    });
    return;
  }

  const manifests = host.listManifests();
  const lines: string[] = [];
  for (const manifest of manifests) {
    const enabled = manifest.alwaysEnabled ? true : await host.isPluginEnabled(c.guildId, manifest.id);
    if (!enabled) {
      lines.push(`⚪ **${manifest.name}** — disabled`);
      continue;
    }
    const health = await host.getPluginHealth(manifest.id);
    const status = health?.status ?? 'ok';
    lines.push(
      `${healthEmoji(status)} **${manifest.name}** — ${status}${health?.details ? ` — ${health.details}` : ''}`,
    );
  }

  const stats = host.getBotStats();
  const embed = brandEmbed()
    .setTitle(c.t('status.title'))
    .addFields(
      { name: 'Gateway ping', value: `${stats.wsPingMs}ms`, inline: true },
      { name: 'Guilds', value: String(stats.guildCount), inline: true },
      { name: 'Plugins', value: lines.join('\n').slice(0, 1024) },
    );

  await c.interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---------------------------------------------------------------------------

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true },
  async execute(c) {
    const group = c.interaction.options.getSubcommandGroup(false);
    const sub = c.interaction.options.getSubcommand(true);

    if (group === 'timezone') {
      if (sub === 'set') return handleTimezoneSet(c);
      if (sub === 'get') return handleTimezoneGet(c);
      if (sub === 'list') return handleTimezoneList(c);
    }

    switch (sub) {
      case 'userinfo':
        return handleUserInfo(c);
      case 'serverinfo':
        return handleServerInfo(c);
      case 'avatar':
        return handleAvatar(c);
      case 'banner':
        return handleBanner(c);
      case 'roleinfo':
        return handleRoleInfo(c);
      case 'channelinfo':
        return handleChannelInfo(c);
      case 'timestamp':
        return handleTimestamp(c);
      case 'calculator':
        return handleCalculator(c);
      case 'afk':
        return handleAfk(c);
      case 'translate':
        return handleTranslate(c);
      case 'weather':
        return handleWeather(c);
      case 'status':
        return handleStatus(c);
      default:
        await c.interaction.reply({ embeds: [errorEmbed('Unknown subcommand.')], ephemeral: true });
    }
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    if (focused.name !== 'timezone') {
      await c.interaction.respond([]);
      return;
    }
    const query = String(focused.value).toLowerCase();
    const matches = listIanaTimezones()
      .filter((zone) => zone.toLowerCase().includes(query))
      .slice(0, 25);
    await c.interaction.respond(matches.map((zone) => ({ name: zone, value: zone })));
  },
};
