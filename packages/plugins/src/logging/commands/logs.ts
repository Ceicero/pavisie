import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, type EmbedBuilder } from 'discord.js';
import { parseDuration, truncate, validateUserRegex } from '@pavisie/core';
import {
  assertStaffLevel,
  brandEmbed,
  errorEmbed,
  listEmbed,
  paginatedReply,
  resolveTextChannel,
  successEmbed,
  type CommandContext,
  type LogKind,
  type PluginCommand,
} from '../../sdk';
import { ALL_LOG_KINDS, LOG_KIND_LABELS, REDACTION_PATTERN_MAX } from '../constants';
import type { LoggingConfig } from '../manifest';
import { getLoggingServiceInstance } from '../service';

const KIND_CHOICES = ALL_LOG_KINDS.map((kind) => ({ name: LOG_KIND_LABELS[kind], value: kind }));
const KIND_OR_DEFAULT_CHOICES = [
  ...KIND_CHOICES,
  { name: 'Default (fallback for any kind without its own channel)', value: 'default' },
];

function isRealKind(value: string): value is LogKind {
  return (ALL_LOG_KINDS as readonly string[]).includes(value);
}

const data = new SlashCommandBuilder()
  .setName('logs')
  .setDescription("Configure and search Pavisie's event logging.")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Route a kind of event to a log channel.')
      .addStringOption((opt) =>
        opt
          .setName('kind')
          .setDescription('Which events to route')
          .setRequired(true)
          .addChoices(...KIND_OR_DEFAULT_CHOICES),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Destination channel')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('disable')
      .setDescription('Stop logging a kind of event (keeps its channel mapping for later).')
      .addStringOption((opt) =>
        opt
          .setName('kind')
          .setDescription('Which events to stop logging')
          .setRequired(true)
          .addChoices(...KIND_CHOICES),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show current log channel mapping, retention, and intent status.'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('retention')
      .setDescription('Set how many days of log events to keep.')
      .addIntegerOption((opt) =>
        opt
          .setName('days')
          .setDescription('Days to keep log events')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(3650),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('test')
      .setDescription('Send a sample log entry through the real pipeline.')
      .addStringOption((opt) =>
        opt
          .setName('kind')
          .setDescription('Which kind to test')
          .setRequired(true)
          .addChoices(...KIND_CHOICES),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('search')
      .setDescription('Search stored log events for a user.')
      .addUserOption((opt) => opt.setName('user').setDescription('User to search for').setRequired(true))
      .addStringOption((opt) =>
        opt
          .setName('kind')
          .setDescription('Limit to one kind')
          .setRequired(false)
          .addChoices(...KIND_CHOICES),
      )
      .addStringOption((opt) =>
        opt
          .setName('since')
          .setDescription('Only events after this long ago, e.g. 7d, 12h')
          .setRequired(false),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('redact')
      .setDescription('Manage custom redaction patterns.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a custom redaction regex pattern.')
          .addStringOption((opt) =>
            opt.setName('pattern').setDescription('Regex pattern (case-insensitive)').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a custom redaction pattern.')
          .addStringOption((opt) =>
            opt
              .setName('pattern')
              .setDescription('Exact pattern to remove')
              .setRequired(true)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('List built-in and custom redaction patterns.'),
      ),
  );

function formatChannelCell(kind: string, config: LoggingConfig): string {
  const explicit = config.channels[kind as LogKind];
  const enabled = isRealKind(kind) ? config.enabledKinds.includes(kind) : true;
  const suffix = enabled ? '' : ' _(off)_';
  if (explicit) return `<#${explicit}>${suffix}`;
  if (config.channels.default) return `<#${config.channels.default}> _(default)_${suffix}`;
  return `_not set_${suffix}`;
}

async function handleStatus(c: CommandContext): Promise<void> {
  const config = await c.config<LoggingConfig>();
  const lines = ALL_LOG_KINDS.map(
    (kind) => `**${LOG_KIND_LABELS[kind]}**: ${formatChannelCell(kind, config)}`,
  );

  const embed = brandEmbed()
    .setTitle(c.t('status.title'))
    .addFields(
      { name: c.t('status.channelsField'), value: lines.join('\n').slice(0, 1024) || '_None configured._' },
      {
        name: c.t('status.storeEventsField'),
        value: config.storeEvents ? c.t('status.on') : c.t('status.off'),
        inline: true,
      },
      {
        name: c.t('status.captureContentField'),
        value: config.captureContent ? c.t('status.on') : c.t('status.off'),
        inline: true,
      },
      {
        name: c.t('status.retentionField'),
        value: c.t('status.retentionValue', { days: config.retentionDays }),
        inline: true,
      },
      {
        name: c.t('status.redactionField'),
        value: c.t('status.redactionValue', { count: config.redactionPatterns.length }),
      },
      {
        name: c.t('status.intentsField'),
        value: [
          `${c.t('status.intentsGuildMembers')}: ${c.ctx.intentsEnabled.guildMembers ? c.t('status.on') : c.t('status.off')}`,
          `${c.t('status.intentsMessageContent')}: ${c.ctx.intentsEnabled.messageContent ? c.t('status.on') : c.t('status.off')}`,
        ].join('\n'),
      },
    );

  await c.interaction.reply({ embeds: [embed], ephemeral: true });
}

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'moderator', guildOnly: true },
  async execute(c) {
    const group = c.interaction.options.getSubcommandGroup(false);
    const sub = c.interaction.options.getSubcommand(true);
    const actor = { id: c.interaction.user.id, source: 'bot' as const };

    if (group === 'redact') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);
      const config = await c.config<LoggingConfig>();

      if (sub === 'add') {
        const pattern = c.interaction.options.getString('pattern', true);
        const check = validateUserRegex(pattern);
        if (!check.ok) {
          await c.interaction.reply({
            embeds: [errorEmbed(c.t('redact.invalidPattern', { reason: check.error ?? 'invalid pattern' }))],
            ephemeral: true,
          });
          return;
        }
        if (config.redactionPatterns.length >= REDACTION_PATTERN_MAX) {
          await c.interaction.reply({
            embeds: [errorEmbed(c.t('redact.limitReached', { max: REDACTION_PATTERN_MAX }))],
            ephemeral: true,
          });
          return;
        }
        const nextPatterns = [...config.redactionPatterns, pattern];
        await c.ctx.setConfig<LoggingConfig>(c.guildId, { redactionPatterns: nextPatterns }, actor);
        await c.interaction.reply({
          embeds: [successEmbed(c.t('redact.added', { index: nextPatterns.length, pattern }))],
          ephemeral: true,
        });
        return;
      }

      if (sub === 'remove') {
        const pattern = c.interaction.options.getString('pattern', true);
        const index = config.redactionPatterns.indexOf(pattern);
        if (index === -1) {
          await c.interaction.reply({
            embeds: [errorEmbed(c.t('redact.notFound', { pattern }))],
            ephemeral: true,
          });
          return;
        }
        const nextPatterns = config.redactionPatterns.filter((_, i) => i !== index);
        await c.ctx.setConfig<LoggingConfig>(c.guildId, { redactionPatterns: nextPatterns }, actor);
        await c.interaction.reply({
          embeds: [successEmbed(c.t('redact.removed', { index: index + 1 }))],
          ephemeral: true,
        });
        return;
      }

      // sub === 'list'
      const customLines =
        config.redactionPatterns.length > 0
          ? config.redactionPatterns.map((pattern, i) => c.t('redact.customEntry', { index: i + 1, pattern }))
          : [c.t('redact.listEmpty')];
      const embed = listEmbed(c.t('redact.listTitle'), [c.t('redact.builtIn'), ...customLines]);
      await c.interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (sub === 'status') {
      await handleStatus(c);
      return;
    }

    if (sub === 'set') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);
      const kind = c.interaction.options.getString('kind', true) as LogKind | 'default';
      const channelOption = c.interaction.options.getChannel('channel', true);

      const resolved = await resolveTextChannel(c.interaction.guild, channelOption.id);
      if (!resolved) {
        await c.interaction.reply({
          embeds: [errorEmbed(c.t('set.missingPermission', { channel: `<#${channelOption.id}>` }))],
          ephemeral: true,
        });
        return;
      }

      const config = await c.config<LoggingConfig>();
      const nextChannels: LoggingConfig['channels'] = { ...config.channels, [kind]: resolved.id };
      const nextEnabledKinds = isRealKind(kind)
        ? Array.from(new Set([...config.enabledKinds, kind]))
        : config.enabledKinds;

      await c.ctx.setConfig<LoggingConfig>(
        c.guildId,
        { channels: nextChannels, enabledKinds: nextEnabledKinds },
        actor,
      );
      await c.interaction.reply({
        embeds: [
          successEmbed(
            c.t('set.success', {
              kind: isRealKind(kind) ? LOG_KIND_LABELS[kind] : 'default',
              channel: `<#${resolved.id}>`,
            }),
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'disable') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);
      const kind = c.interaction.options.getString('kind', true) as LogKind;
      const config = await c.config<LoggingConfig>();
      const nextEnabledKinds = config.enabledKinds.filter((k) => k !== kind);
      await c.ctx.setConfig<LoggingConfig>(c.guildId, { enabledKinds: nextEnabledKinds }, actor);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('disable.success', { kind: LOG_KIND_LABELS[kind] }))],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'retention') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);
      const days = c.interaction.options.getInteger('days', true);
      await c.ctx.setConfig<LoggingConfig>(c.guildId, { retentionDays: days }, actor);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('retention.success', { days }))],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'test') {
      const kind = c.interaction.options.getString('kind', true) as LogKind;
      const logging = getLoggingServiceInstance();
      if (!logging) {
        await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.generic'))], ephemeral: true });
        return;
      }
      await logging.sendTest(c.guildId, kind, c.interaction.user.id);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('test.success', { kind: LOG_KIND_LABELS[kind] }))],
        ephemeral: true,
      });
      return;
    }

    // sub === 'search'
    const config = await c.config<LoggingConfig>();
    if (!config.storeEvents) {
      await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.storeEventsOff'))], ephemeral: true });
      return;
    }

    const user = c.interaction.options.getUser('user', true);
    const kindFilter = c.interaction.options.getString('kind') as LogKind | null;
    const sinceRaw = c.interaction.options.getString('since');
    const sinceMs = sinceRaw ? parseDuration(sinceRaw) : null;

    const rows = await c.ctx.prisma.logEvent.findMany({
      where: {
        guildId: c.guildId,
        targetId: user.id,
        ...(kindFilter ? { kind: kindFilter } : {}),
        ...(sinceMs ? { createdAt: { gte: new Date(Date.now() - sinceMs) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const PAGE_SIZE = 8;
    const pages: EmbedBuilder[] = [];
    for (let i = 0; i < rows.length; i += PAGE_SIZE) {
      const chunk = rows.slice(i, i + PAGE_SIZE);
      const lines = chunk.map((row) => {
        const payload = (row.payload as { title?: string } | null) ?? {};
        const title = payload.title ? ` — ${truncate(payload.title, 80)}` : '';
        return c.t('search.entryLine', {
          kind: LOG_KIND_LABELS[row.kind as LogKind] ?? row.kind,
          timestamp: `<t:${Math.floor(row.createdAt.getTime() / 1000)}:R>`,
          title,
        });
      });
      pages.push(
        listEmbed(
          kindFilter
            ? c.t('search.title', { kind: LOG_KIND_LABELS[kindFilter] })
            : c.t('search.titleAllKinds'),
          lines,
        ),
      );
    }
    if (pages.length === 0) {
      pages.push(listEmbed(c.t('search.titleAllKinds'), [c.t('search.noResults')]));
    }

    await paginatedReply({
      interaction: c.interaction,
      pages,
      ownerId: c.interaction.user.id,
      pluginId: 'logging',
    });
  },
  async autocomplete(c) {
    if (
      c.interaction.options.getSubcommandGroup(false) !== 'redact' ||
      c.interaction.options.getSubcommand(false) !== 'remove'
    ) {
      await c.interaction.respond([]);
      return;
    }
    const config = await c.config<LoggingConfig>();
    const focused = String(c.interaction.options.getFocused() ?? '').toLowerCase();
    const matches = config.redactionPatterns.filter((p) => p.toLowerCase().includes(focused)).slice(0, 25);
    await c.interaction.respond(
      matches.map((p) => ({ name: p.length > 100 ? `${p.slice(0, 97)}...` : p, value: p })),
    );
  },
};
