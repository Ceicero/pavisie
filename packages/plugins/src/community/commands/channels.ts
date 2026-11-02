import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  errorEmbed,
  infoEmbed,
  listEmbed,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import { ARCHIVE_MINUTES, CHANNEL_AUTOMATION_MAX, type ArchiveMinutes } from '../channel-automations';
import { botHasChannelPermission, channelPresence, nonBlank } from '../command-input';
import type { AutoThreadRule, CommunityConfig } from '../manifest';

const THREAD_TOKENS = ['user', 'user.tag', 'server', 'date'];

/** Tokens in `template` that auto-thread rendering will leave as literal text. */
function unknownThreadTokens(template: string): string[] {
  const unknown: string[] = [];
  for (const match of template.matchAll(/\{([a-zA-Z._]+)\}/g)) {
    const token = match[1] ?? '';
    if (!THREAD_TOKENS.includes(token) && !unknown.includes(token)) unknown.push(token);
  }
  return unknown;
}

async function saveConfig(c: CommandContext, patch: Partial<CommunityConfig>): Promise<boolean> {
  try {
    await c.ctx.setConfig<CommunityConfig>(c.guildId, patch, { id: c.interaction.user.id, source: 'bot' });
    return true;
  } catch (err) {
    c.ctx.logger.warn({ err, guildId: c.guildId }, 'community: failed to save channel automation config');
    await c.interaction.reply({ embeds: [errorEmbed(c.t('channelauto.saveFailed'))], ephemeral: true });
    return false;
  }
}

async function splitLiveIds(c: CommandContext, ids: string[]): Promise<{ live: string[]; gone: string[] }> {
  const live: string[] = [];
  const gone: string[] = [];
  for (const id of ids) {
    if ((await channelPresence(c.interaction.guild, id)) === 'gone') gone.push(id);
    else live.push(id);
  }
  return { live, gone };
}

const ARCHIVE_CHOICES = [
  { name: '1 hour', value: 60 },
  { name: '1 day', value: 1440 },
  { name: '3 days', value: 4320 },
  { name: '1 week', value: 10080 },
] as const;

const data = new SlashCommandBuilder()
  .setName('channelauto')
  .setDescription('Channel automations: auto-publish announcements and one-thread-per-post channels.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommandGroup((group) =>
    group
      .setName('publish')
      .setDescription('Auto-publish every new message in an announcement channel.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Start auto-publishing an announcement channel.')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Announcement channel')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Stop auto-publishing an announcement channel.')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Announcement channel')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List auto-published channels.')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('thread')
      .setDescription('Automatically start a thread for every post in a channel.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add or update an auto-thread rule for a channel.')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Text or announcement channel')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription(
                'Thread name template: {user}, {user.tag}, {server}, {date} (default: "{user} — {date}")',
              )
              .setRequired(false)
              .setMaxLength(100),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('archive')
              .setDescription('Auto-archive after inactivity (default: 1 day)')
              .setRequired(false)
              .addChoices(...ARCHIVE_CHOICES),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('require_attachment')
              .setDescription('Only thread posts with an attachment or embed (default: false)')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('starter')
              .setDescription('Optional message the bot posts in each new thread (same tokens as name)')
              .setRequired(false)
              .setMaxLength(300),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove the auto-thread rule for a channel.')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List auto-thread rules.')),
  );

function formatArchive(minutes: number): string {
  return ARCHIVE_CHOICES.find((c) => c.value === minutes)?.name ?? `${minutes} min`;
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

async function handlePublishAdd(c: CommandContext): Promise<void> {
  const { interaction, t } = c;
  const channel = interaction.options.getChannel('channel', true);
  if (channel.type !== ChannelType.GuildAnnouncement) {
    await interaction.reply({
      embeds: [errorEmbed(t('channelauto.publish.notAnnouncement'))],
      ephemeral: true,
    });
    return;
  }
  if ((await channelPresence(interaction.guild, channel.id)) === 'gone') {
    await interaction.reply({ embeds: [errorEmbed(t('channelauto.channelGone'))], ephemeral: true });
    return;
  }
  const me = interaction.guild.members?.me ?? null;
  if (botHasChannelPermission(channel, me, PermissionFlagsBits.ViewChannel) === false) {
    await interaction.reply({
      embeds: [errorEmbed(t('channelauto.publish.cantView', { channel: `<#${channel.id}>` }))],
      ephemeral: true,
    });
    return;
  }

  const config = await c.config<CommunityConfig>();
  const current = config.autoPublish.channelIds;
  if (!current.includes(channel.id) && current.length >= CHANNEL_AUTOMATION_MAX) {
    await interaction.reply({
      embeds: [errorEmbed(t('channelauto.publish.limit', { max: CHANNEL_AUTOMATION_MAX }))],
      ephemeral: true,
    });
    return;
  }

  const channelIds = current.includes(channel.id) ? current : [...current, channel.id];
  const saved = await saveConfig(c, { autoPublish: { ...config.autoPublish, channelIds } });
  if (!saved) return;

  const lines = [t('channelauto.publish.added', { channel: `<#${channel.id}>` })];
  const perms = me && 'permissionsFor' in channel ? channel.permissionsFor(me) : null;
  if (perms && !perms.has(PermissionFlagsBits.ManageMessages)) {
    lines.push(t('channelauto.publish.missingManageMessages', { channel: `<#${channel.id}>` }));
  }
  await interaction.reply({ embeds: [successEmbed(lines.join('\n'))], ephemeral: true });
}

async function handlePublishRemove(c: CommandContext): Promise<void> {
  const { interaction, t } = c;
  const channel = interaction.options.getChannel('channel', true);
  const config = await c.config<CommunityConfig>();
  if (!config.autoPublish.channelIds.includes(channel.id)) {
    await interaction.reply({
      embeds: [errorEmbed(t('channelauto.publish.notListed', { channel: `<#${channel.id}>` }))],
      ephemeral: true,
    });
    return;
  }
  const saved = await saveConfig(c, {
    autoPublish: {
      ...config.autoPublish,
      channelIds: config.autoPublish.channelIds.filter((id) => id !== channel.id),
    },
  });
  if (!saved) return;
  await interaction.reply({
    embeds: [successEmbed(t('channelauto.publish.removed', { channel: `<#${channel.id}>` }))],
    ephemeral: true,
  });
}

async function handlePublishList(c: CommandContext): Promise<void> {
  const { interaction, t } = c;
  const config = await c.config<CommunityConfig>();
  const { live, gone } = await splitLiveIds(c, config.autoPublish.channelIds);
  if (gone.length > 0) {
    const saved = await saveConfig(c, { autoPublish: { ...config.autoPublish, channelIds: live } });
    if (!saved) return;
  }
  if (live.length === 0) {
    const body =
      gone.length > 0
        ? `${t('channelauto.pruned', { count: gone.length })}\n${t('channelauto.publish.listEmpty')}`
        : t('channelauto.publish.listEmpty');
    await interaction.reply({
      embeds: [infoEmbed(t('channelauto.publish.listTitle'), body)],
      ephemeral: true,
    });
    return;
  }
  const lines = live.map((id) => `<#${id}>`);
  if (gone.length > 0) lines.push(t('channelauto.pruned', { count: gone.length }));
  if (config.autoPublish.includeBots) lines.push(t('channelauto.publish.includeBotsOn'));
  await interaction.reply({
    embeds: [listEmbed(t('channelauto.publish.listTitle'), lines)],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// thread
// ---------------------------------------------------------------------------

async function handleThreadAdd(c: CommandContext): Promise<void> {
  const { interaction, t } = c;
  const channel = interaction.options.getChannel('channel', true);
  if ((await channelPresence(interaction.guild, channel.id)) === 'gone') {
    await interaction.reply({ embeds: [errorEmbed(t('channelauto.channelGone'))], ephemeral: true });
    return;
  }
  const me = interaction.guild.members?.me ?? null;
  if (botHasChannelPermission(channel, me, PermissionFlagsBits.ViewChannel) === false) {
    await interaction.reply({
      embeds: [errorEmbed(t('channelauto.thread.cantView', { channel: `<#${channel.id}>` }))],
      ephemeral: true,
    });
    return;
  }

  const config = await c.config<CommunityConfig>();
  const existing = config.autoThreads.find((r) => r.channelId === channel.id);

  const nameRaw = interaction.options.getString('name');
  let nameTemplate: string;
  if (nameRaw === null) {
    nameTemplate = existing?.nameTemplate || '{user} — {date}';
  } else {
    const name = nonBlank(nameRaw);
    if (!name) {
      await interaction.reply({ embeds: [errorEmbed(t('channelauto.thread.emptyName'))], ephemeral: true });
      return;
    }
    nameTemplate = name;
  }

  const starterRaw = interaction.options.getString('starter');
  let starterMessage: string | null;
  if (starterRaw === null) {
    starterMessage = existing?.starterMessage ?? null;
  } else {
    const starter = nonBlank(starterRaw);
    if (!starter) {
      await interaction.reply({
        embeds: [errorEmbed(t('channelauto.thread.emptyStarter'))],
        ephemeral: true,
      });
      return;
    }
    starterMessage = starter;
  }

  if (!existing && config.autoThreads.length >= CHANNEL_AUTOMATION_MAX) {
    await interaction.reply({
      embeds: [errorEmbed(t('channelauto.thread.limit', { max: CHANNEL_AUTOMATION_MAX }))],
      ephemeral: true,
    });
    return;
  }

  const archive = interaction.options.getInteger('archive');
  const requireAttachment = interaction.options.getBoolean('require_attachment');

  const rule: AutoThreadRule = {
    channelId: channel.id,
    nameTemplate,
    archiveMinutes:
      archive !== null && (ARCHIVE_MINUTES as readonly number[]).includes(archive)
        ? (archive as ArchiveMinutes)
        : (existing?.archiveMinutes ?? 1440),
    requireAttachment: requireAttachment ?? existing?.requireAttachment ?? false,
    starterMessage,
  };

  const autoThreads = existing
    ? config.autoThreads.map((r) => (r.channelId === channel.id ? rule : r))
    : [...config.autoThreads, rule];

  const saved = await saveConfig(c, { autoThreads });
  if (!saved) return;

  const lines = [
    t('channelauto.thread.added', {
      channel: `<#${channel.id}>`,
      name: rule.nameTemplate,
      archive: formatArchive(rule.archiveMinutes),
    }),
  ];
  if (botHasChannelPermission(channel, me, PermissionFlagsBits.CreatePublicThreads) === false) {
    lines.push(t('channelauto.thread.missingCreateThreads', { channel: `<#${channel.id}>` }));
  }
  const unknown = [
    ...new Set([
      ...unknownThreadTokens(rule.nameTemplate),
      ...(rule.starterMessage ? unknownThreadTokens(rule.starterMessage) : []),
    ]),
  ];
  if (unknown.length > 0) {
    lines.push(
      t('channelauto.thread.unknownTokens', { tokens: unknown.map((token) => `{${token}}`).join(', ') }),
    );
  }
  await interaction.reply({ embeds: [successEmbed(lines.join('\n'))], ephemeral: true });
}

async function handleThreadRemove(c: CommandContext): Promise<void> {
  const { interaction, t } = c;
  const channel = interaction.options.getChannel('channel', true);
  const config = await c.config<CommunityConfig>();
  if (!config.autoThreads.some((r) => r.channelId === channel.id)) {
    await interaction.reply({
      embeds: [errorEmbed(t('channelauto.thread.notFound', { channel: `<#${channel.id}>` }))],
      ephemeral: true,
    });
    return;
  }
  const saved = await saveConfig(c, {
    autoThreads: config.autoThreads.filter((r) => r.channelId !== channel.id),
  });
  if (!saved) return;
  await interaction.reply({
    embeds: [successEmbed(t('channelauto.thread.removed', { channel: `<#${channel.id}>` }))],
    ephemeral: true,
  });
}

async function handleThreadList(c: CommandContext): Promise<void> {
  const { interaction, t } = c;
  const config = await c.config<CommunityConfig>();
  const { gone } = await splitLiveIds(
    c,
    config.autoThreads.map((rule) => rule.channelId),
  );
  const goneIds = new Set(gone);
  const liveRules = config.autoThreads.filter((rule) => !goneIds.has(rule.channelId));
  if (gone.length > 0) {
    const saved = await saveConfig(c, { autoThreads: liveRules });
    if (!saved) return;
  }
  if (liveRules.length === 0) {
    const body =
      gone.length > 0
        ? `${t('channelauto.pruned', { count: gone.length })}\n${t('channelauto.thread.listEmpty')}`
        : t('channelauto.thread.listEmpty');
    await interaction.reply({
      embeds: [infoEmbed(t('channelauto.thread.listTitle'), body)],
      ephemeral: true,
    });
    return;
  }
  const lines = liveRules.map((r) => {
    const flags = [formatArchive(r.archiveMinutes)];
    if (r.requireAttachment) flags.push('attachments only');
    if (r.starterMessage) flags.push('starter message');
    return `<#${r.channelId}> — \`${r.nameTemplate}\` (${flags.join(', ')})`;
  });
  if (gone.length > 0) lines.push(t('channelauto.pruned', { count: gone.length }));
  await interaction.reply({ embeds: [listEmbed(t('channelauto.thread.listTitle'), lines)], ephemeral: true });
}

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'admin', guildOnly: true },
  async execute(c) {
    const group = c.interaction.options.getSubcommandGroup(true);
    const sub = c.interaction.options.getSubcommand(true);
    if (group === 'publish') {
      if (sub === 'add') return handlePublishAdd(c);
      if (sub === 'remove') return handlePublishRemove(c);
      return handlePublishList(c);
    }
    if (sub === 'add') return handleThreadAdd(c);
    if (sub === 'remove') return handleThreadRemove(c);
    return handleThreadList(c);
  },
};
