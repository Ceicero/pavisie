import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { assertPublicHttpUrl, SsrfError, ValidationError } from '@pavisie/core';
import { errorEmbed, listEmbed, successEmbed, type CommandContext, type PluginCommand } from '../../sdk';
import { describeAvailability } from '../service';
import type { AiConfig } from '../manifest';
import { DEFAULT_PERSONA } from '../prompt';
import { openSetKeyModal } from '../components/set-key-modal';
import { openPersonaModal } from '../components/persona-modal';

const PROVIDER_CHOICES = [
  { name: 'OpenAI', value: 'openai' },
  { name: 'Anthropic', value: 'anthropic' },
  { name: 'OpenAI-compatible', value: 'compatible' },
] as const;

const CHANNEL_ACTION_CHOICES = [
  { name: 'Add', value: 'add' },
  { name: 'Remove', value: 'remove' },
  { name: 'List', value: 'list' },
] as const;

const PERSONA_ACTION_CHOICES = [
  { name: 'Set', value: 'set' },
  { name: 'Clear', value: 'clear' },
  { name: 'View', value: 'view' },
] as const;

const data = new SlashCommandBuilder()
  .setName('ai')
  .setDescription('Configure the AI assistant for this server.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup((group) =>
    group
      .setName('config')
      .setDescription('AI assistant configuration')
      .addSubcommand((sub) =>
        sub.setName('view').setDescription('View the current AI assistant configuration.'),
      )
      .addSubcommand((sub) =>
        sub.setName('set-key').setDescription('Set the API key for the configured provider.'),
      )
      .addSubcommand((sub) => sub.setName('clear-key').setDescription('Remove the configured API key.'))
      .addSubcommand((sub) =>
        sub
          .setName('provider')
          .setDescription('Set the AI provider.')
          .addStringOption((opt) =>
            opt
              .setName('provider')
              .setDescription('Provider')
              .setRequired(true)
              .addChoices(...PROVIDER_CHOICES),
          )
          .addStringOption((opt) =>
            opt
              .setName('base-url')
              .setDescription('Base URL (only used for OpenAI-compatible)')
              .setMaxLength(300),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('model')
          .setDescription('Set the model name.')
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription('Model name, e.g. gpt-4o-mini')
              .setRequired(true)
              .setMaxLength(200),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('channels')
          .setDescription('Add or remove an allowed channel for /ask and /summarize.')
          .addStringOption((opt) =>
            opt
              .setName('action')
              .setDescription('add or remove')
              .setRequired(true)
              .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }),
          )
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel')
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.PublicThread,
                ChannelType.PrivateThread,
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('budget')
          .setDescription('Set daily token budgets.')
          .addIntegerOption((opt) =>
            opt
              .setName('daily')
              .setDescription('Server-wide daily token budget')
              .setRequired(true)
              .setMinValue(1000)
              .setMaxValue(10_000_000),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('per-user')
              .setDescription('Per-user daily token budget')
              .setRequired(true)
              .setMinValue(100)
              .setMaxValue(1_000_000),
          ),
      ),
  )
  // A separate top-level group (rather than nesting under `config`) because Discord slash commands only support
  // two levels below the base command (`/ai <group> <subcommand>`) — `/ai config chat enable` isn't expressible.
  .addSubcommandGroup((group) =>
    group
      .setName('chat')
      .setDescription('Mention chat — talk to the bot by @mentioning it in a channel.')
      .addSubcommand((sub) => sub.setName('enable').setDescription('Turn mention chat on for this server.'))
      .addSubcommand((sub) => sub.setName('disable').setDescription('Turn mention chat off for this server.'))
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Add, remove, or list the channels mention chat responds in.')
          .addStringOption((opt) =>
            opt
              .setName('action')
              .setDescription('add, remove, or list')
              .setRequired(true)
              .addChoices(...CHANNEL_ACTION_CHOICES),
          )
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel (required for add/remove)')
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.PublicThread,
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('persona')
          .setDescription('Set, clear, or view the mention-chat persona.')
          .addStringOption((opt) =>
            opt
              .setName('action')
              .setDescription('set, clear, or view')
              .setRequired(true)
              .addChoices(...PERSONA_ACTION_CHOICES),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('history')
          .setDescription('How many recent messages to include as context (0-10).')
          .addIntegerOption((opt) =>
            opt
              .setName('count')
              .setDescription('Message count')
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(10),
          ),
      ),
  );

function formatChannels(channelIds: string[]): string {
  return channelIds.length > 0
    ? channelIds.map((id) => `<#${id}>`).join(', ')
    : '_None — /ask and /summarize are disabled until at least one channel is added_';
}

function formatChatChannels(channelIds: string[]): string {
  return channelIds.length > 0
    ? channelIds.map((id) => `<#${id}>`).join(', ')
    : '_None — mention chat never triggers until at least one channel is added_';
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true, staffLevel: 'admin' },
  async execute(c) {
    const group = c.interaction.options.getSubcommandGroup(false);
    const sub = c.interaction.options.getSubcommand(true);
    const actor = { id: c.interaction.user.id, source: 'bot' as const };

    if (group === 'chat') {
      await executeChat(c, sub, actor);
      return;
    }

    if (sub === 'view') {
      const config = await c.config<AiConfig>();
      const availability = describeAvailability(config, {
        OPENAI_API_KEY: c.ctx.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: c.ctx.env.ANTHROPIC_API_KEY,
      });
      await c.interaction.reply({
        embeds: [
          listEmbed(c.t('config.viewTitle'), [
            `Status: ${availability.available ? '✅ Ready' : `⚠️ ${availability.reason}`}`,
            `Provider: ${config.provider}${config.provider === 'compatible' && config.baseUrl ? ` (${config.baseUrl})` : ''}`,
            `Model: ${config.model}`,
            `API key: ${config.apiKeyEnc ? 'Set for this server' : config.allowEnvKeys ? 'Not set — using environment key fallback if available' : 'Not set, and environment fallback is off'}`,
            `Allowed channels (/ask, /summarize): ${formatChannels(config.allowedChannelIds)}`,
            `Per-user cooldown: ${config.userCooldownSeconds}s`,
            `Daily token budget (server): ${config.dailyTokenBudget.toLocaleString()}`,
            `Daily token budget (per user): ${config.perUserDailyTokenBudget.toLocaleString()}`,
            `Mention chat: ${config.chat.enabled ? '✅ On' : 'Off'} — ${formatChatChannels(config.chat.channelIds)}`,
            `Mention-chat persona: ${config.chat.persona ? `"${config.chat.persona}"` : `_Default — "${DEFAULT_PERSONA}"_`}`,
            `Mention-chat history: ${config.chat.historyMessages} message(s), max reply ${config.chat.maxReplyChars} chars`,
          ]),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'set-key') {
      await openSetKeyModal(c.interaction, c.interaction.user.id);
      return;
    }

    if (sub === 'clear-key') {
      await c.ctx.setConfig<AiConfig>(c.guildId, { apiKeyEnc: null }, actor);
      await c.interaction.reply({ embeds: [successEmbed(c.t('config.keyCleared'))], ephemeral: true });
      return;
    }

    if (sub === 'provider') {
      const provider = c.interaction.options.getString('provider', true) as AiConfig['provider'];
      const baseUrl = c.interaction.options.getString('base-url');
      if (provider === 'compatible' && !baseUrl) {
        throw new ValidationError(c.t('errors.compatibleNeedsBaseUrl'));
      }
      if (provider === 'compatible' && baseUrl) {
        try {
          await assertPublicHttpUrl(baseUrl);
        } catch (err) {
          throw new ValidationError(err instanceof SsrfError ? err.message : 'That base URL is not allowed.');
        }
      }
      await c.ctx.setConfig<AiConfig>(
        c.guildId,
        { provider, baseUrl: provider === 'compatible' ? baseUrl : null },
        actor,
      );
      await c.interaction.reply({
        embeds: [successEmbed(c.t('config.providerSet', { provider }))],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'model') {
      const name = c.interaction.options.getString('name', true);
      await c.ctx.setConfig<AiConfig>(c.guildId, { model: name }, actor);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('config.modelSet', { model: name }))],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'channels') {
      const action = c.interaction.options.getString('action', true);
      const channel = c.interaction.options.getChannel('channel', true);
      const config = await c.config<AiConfig>();
      const next =
        action === 'add'
          ? [...new Set([...config.allowedChannelIds, channel.id])]
          : config.allowedChannelIds.filter((id) => id !== channel.id);
      await c.ctx.setConfig<AiConfig>(c.guildId, { allowedChannelIds: next }, actor);
      await c.interaction.reply({
        embeds: [
          successEmbed(
            action === 'add'
              ? c.t('config.channelAdded', { channel: channel.name })
              : c.t('config.channelRemoved', { channel: channel.name }),
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'budget') {
      const daily = c.interaction.options.getInteger('daily', true);
      const perUser = c.interaction.options.getInteger('per-user', true);
      if (perUser > daily) {
        throw new ValidationError(c.t('errors.perUserBudgetExceedsDaily'));
      }
      await c.ctx.setConfig<AiConfig>(
        c.guildId,
        { dailyTokenBudget: daily, perUserDailyTokenBudget: perUser },
        actor,
      );
      await c.interaction.reply({
        embeds: [successEmbed(c.t('config.budgetSet', { daily, perUser }))],
        ephemeral: true,
      });
      return;
    }

    await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.generic'))], ephemeral: true });
  },
};

/**
 * Handles every `/ai chat <sub>` subcommand. `setConfig` shallow-merges only at the top level (see
 * `config-store.ts`), so every branch here spreads the *current* `config.chat` before patching one field —
 * patching `{ chat: { enabled } }` directly would silently reset `channelIds`/`persona`/etc back to defaults.
 */
async function executeChat(
  c: CommandContext,
  sub: string,
  actor: { id: string; source: 'bot' },
): Promise<void> {
  const config = await c.config<AiConfig>();

  if (sub === 'enable') {
    await c.ctx.setConfig<AiConfig>(c.guildId, { chat: { ...config.chat, enabled: true } }, actor);
    await c.interaction.reply({ embeds: [successEmbed(c.t('config.chat.enabled'))], ephemeral: true });
    return;
  }

  if (sub === 'disable') {
    await c.ctx.setConfig<AiConfig>(c.guildId, { chat: { ...config.chat, enabled: false } }, actor);
    await c.interaction.reply({ embeds: [successEmbed(c.t('config.chat.disabled'))], ephemeral: true });
    return;
  }

  if (sub === 'channel') {
    const action = c.interaction.options.getString('action', true);
    const channel = c.interaction.options.getChannel('channel', false);

    if (action === 'list') {
      await c.interaction.reply({
        embeds: [
          listEmbed(c.t('config.chat.channelListTitle'), [formatChatChannels(config.chat.channelIds)]),
        ],
        ephemeral: true,
      });
      return;
    }

    if (!channel) {
      throw new ValidationError(c.t('errors.chatChannelRequired'));
    }

    if (
      action === 'add' &&
      config.chat.channelIds.length >= 20 &&
      !config.chat.channelIds.includes(channel.id)
    ) {
      throw new ValidationError(c.t('errors.chatChannelLimit'));
    }

    const next =
      action === 'add'
        ? [...new Set([...config.chat.channelIds, channel.id])]
        : config.chat.channelIds.filter((id) => id !== channel.id);
    await c.ctx.setConfig<AiConfig>(c.guildId, { chat: { ...config.chat, channelIds: next } }, actor);
    await c.interaction.reply({
      embeds: [
        successEmbed(
          action === 'add'
            ? c.t('config.chat.channelAdded', { channel: channel.name })
            : c.t('config.chat.channelRemoved', { channel: channel.name }),
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'persona') {
    const action = c.interaction.options.getString('action', true);

    if (action === 'set') {
      await openPersonaModal(c.interaction, c.interaction.user.id, config.chat.persona);
      return;
    }

    if (action === 'clear') {
      await c.ctx.setConfig<AiConfig>(c.guildId, { chat: { ...config.chat, persona: null } }, actor);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('config.chat.personaCleared'))],
        ephemeral: true,
      });
      return;
    }

    // action === 'view'
    await c.interaction.reply({
      embeds: [
        listEmbed(c.t('config.chat.personaViewTitle'), [
          config.chat.persona ? config.chat.persona : `_Default — "${DEFAULT_PERSONA}"_`,
        ]),
      ],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'history') {
    const count = c.interaction.options.getInteger('count', true);
    await c.ctx.setConfig<AiConfig>(c.guildId, { chat: { ...config.chat, historyMessages: count } }, actor);
    await c.interaction.reply({
      embeds: [successEmbed(c.t('config.chat.historySet', { count }))],
      ephemeral: true,
    });
    return;
  }

  await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.generic'))], ephemeral: true });
}
