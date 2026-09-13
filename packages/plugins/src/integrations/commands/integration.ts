import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { AuditAction, discordTimestamp } from '@pavisie/core';
import type { AlertProviderId } from '@pavisie/types/integrations';
import {
  assertStaffLevel,
  brandEmbed,
  errorEmbed,
  listEmbed,
  registerConfirmHandlers,
  requestConfirmation,
  successEmbed,
  type ComponentHandler,
  type PluginCommand,
} from '../../sdk';
import {
  createAlertConnection,
  createInboundWebhook,
  createOutboundWebhook,
  deleteWebhookEndpoint,
  disconnectConnection,
} from '../connections';
import { INTEGRATION_PROVIDER_IDS, ALERT_PROVIDER_IDS } from '@pavisie/types/integrations';
import { getProvider, PROVIDER_ENUM_MAP, providerIdFromEnum } from '../providers';
import { readAlertConfig } from '../providers/util';
import { OUTBOUND_PLATFORM_EVENTS } from '../service';

const PROVIDER_CHOICES = INTEGRATION_PROVIDER_IDS.map((id) => ({ name: id, value: id }));
const ALERT_PROVIDER_CHOICES = ALERT_PROVIDER_IDS.map((id) => ({ name: id, value: id }));

const data = new SlashCommandBuilder()
  .setName('integration')
  .setDescription('Connect external services: stream alerts, Instagram, webhooks, and more.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('connect')
      .setDescription('Connect an integration provider.')
      .addStringOption((opt) =>
        opt
          .setName('provider')
          .setDescription('Provider')
          .setRequired(true)
          .addChoices(...PROVIDER_CHOICES),
      )
      .addStringOption((opt) =>
        opt
          .setName('target')
          .setDescription('What to watch (login, channel id, subreddit, app id — provider-specific)')
          .setRequired(false),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to post alerts to')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('Role to mention on alert').setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName('template').setDescription('Custom alert message template').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('disconnect')
      .setDescription('Disconnect an integration.')
      .addStringOption((opt) =>
        opt.setName('connection').setDescription('Connection').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Show connection status.')
      .addStringOption((opt) =>
        opt.setName('connection').setDescription('Connection').setRequired(false).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List every connection and webhook endpoint.'))
  .addSubcommandGroup((group) =>
    group
      .setName('alerts')
      .setDescription('Manage stream/post/news alert watches.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Watch a target and alert when it posts.')
          .addStringOption((opt) =>
            opt
              .setName('provider')
              .setDescription('Provider')
              .setRequired(true)
              .addChoices(...ALERT_PROVIDER_CHOICES),
          )
          .addStringOption((opt) =>
            opt.setName('target').setDescription('Login / channel id / subreddit / app id').setRequired(true),
          )
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel to post alerts to')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true),
          )
          .addRoleOption((opt) => opt.setName('role').setDescription('Role to mention').setRequired(false))
          .addStringOption((opt) =>
            opt.setName('template').setDescription('Custom alert message template').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove an alert watch.')
          .addStringOption((opt) =>
            opt.setName('connection').setDescription('Alert watch').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List alert watches.')
          .addStringOption((opt) =>
            opt
              .setName('provider')
              .setDescription('Filter by provider')
              .setRequired(false)
              .addChoices(...ALERT_PROVIDER_CHOICES),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('webhook')
      .setDescription('Manage inbound webhook endpoints.')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create an inbound webhook endpoint.')
          .addStringOption((opt) => opt.setName('name').setDescription('Name').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('provider')
              .setDescription('Provider')
              .setRequired(false)
              // `github` was dropped as a connectable provider (2026-09-02): its receiver at
              // `/webhooks/github/:endpointId` is retained for endpoints created before the removal, but
              // `getProvider('github')` no longer resolves, so new endpoints would silently drop every
              // delivery. Offering it here would hand users a dead URL.
              .addChoices({ name: 'generic', value: 'generic' }),
          )
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel to post events to')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('template')
              .setDescription('Message template for generic payloads ({dot.path} placeholders)')
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List inbound webhook endpoints.'))
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete an inbound webhook endpoint.')
          .addStringOption((opt) =>
            opt.setName('endpoint').setDescription('Endpoint').setRequired(true).setAutocomplete(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('outbound')
      .setDescription('Manage outbound webhook notifications.')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create an outbound webhook.')
          .addStringOption((opt) => opt.setName('name').setDescription('Name').setRequired(true))
          .addStringOption((opt) =>
            opt.setName('url').setDescription('Destination URL (https, public)').setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('events')
              .setDescription('Comma-separated event types to send (see /integration outbound create docs)')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List outbound webhooks.'))
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete an outbound webhook.')
          .addStringOption((opt) =>
            opt.setName('endpoint').setDescription('Endpoint').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('test')
          .setDescription('Send a test delivery.')
          .addStringOption((opt) =>
            opt.setName('endpoint').setDescription('Endpoint').setRequired(true).setAutocomplete(true),
          ),
      ),
  );

function statusLabel(status: string): string {
  return (
    { CONNECTED: '🟢 Connected', DISCONNECTED: '⚪ Disconnected', ERROR: '🔴 Error', PENDING: '🟡 Pending' }[
      status
    ] ?? status
  );
}

async function handleConnect(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const providerId = c.interaction.options.getString('provider', true);
  const providerDef = getProvider(providerId);
  if (!providerDef) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('connect.unknownProvider', { provider: providerId }))],
      ephemeral: true,
    });
    return;
  }

  if (providerDef.kind === 'oauth') {
    const dashboardUrl = c.ctx.env.DASHBOARD_URL ?? 'the dashboard';
    const url = `${dashboardUrl}/dashboard/${c.guildId}/integrations`;
    await c.interaction.reply({
      embeds: [brandEmbed().setDescription(c.t('connect.oauthLink', { provider: providerDef.name, url }))],
      ephemeral: true,
    });
    return;
  }

  if (providerDef.kind === 'webhook') {
    await c.interaction.reply({
      embeds: [brandEmbed().setDescription(c.t('connect.webhookGuidance', { provider: providerDef.name }))],
      ephemeral: true,
    });
    return;
  }

  // apikey/public providers (youtube, steam, reddit): connect with inline options, or point at `alerts add`.
  const target = c.interaction.options.getString('target');
  const channel = c.interaction.options.getChannel('channel');
  if (!target || !channel) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('connect.needsTarget', { provider: providerDef.name }))],
      ephemeral: true,
    });
    return;
  }

  const role = c.interaction.options.getRole('role');
  const template = c.interaction.options.getString('template');

  const connection = await createAlertConnection(c.ctx, c.guildId, c.interaction.user.id, 'bot', {
    provider: providerId as AlertProviderId,
    target,
    channelId: channel.id,
    roleId: role?.id ?? null,
    template,
  });

  const embed =
    connection.status === 'ERROR'
      ? errorEmbed(
          c.t('connect.unavailable', {
            provider: providerDef.name,
            missingEnv: providerDef.requiredEnv.join(', '),
          }),
        )
      : successEmbed(c.t('connect.created', { provider: providerDef.name, target, channelId: channel.id }));
  await c.interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleDisconnect(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const connectionId = c.interaction.options.getString('connection', true);
  const connection = await c.ctx.prisma.integrationConnection.findFirst({
    where: { id: connectionId, guildId: c.guildId, deletedAt: null },
  });
  if (!connection) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('alerts.notFound'))], ephemeral: true });
    return;
  }

  const providerId = providerIdFromEnum(connection.provider) ?? connection.provider;
  const host = c.ctx.services.get('host');
  const guildConfig = host ? await host.getGuildConfig(c.guildId).catch(() => null) : null;

  const embed = brandEmbed()
    .setTitle(c.t('disconnect.confirmTitle'))
    .setDescription(
      c.t('disconnect.confirmBody', {
        provider: String(providerId),
        label: connection.label ?? connection.externalAccountName ?? connection.id,
      }),
    );

  const result = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'integrations',
    action: 'disconnect',
    ownerId: c.interaction.user.id,
    embed,
    payload: { connectionId },
    fastActions: Boolean(guildConfig?.fastActions),
  });

  if (result.confirmed) {
    // `fastActions` short-circuited requestConfirmation without sending any reply — this is the first reply.
    await disconnectConnection(c.ctx, c.guildId, connectionId, c.interaction.user.id, 'bot');
    await c.interaction.reply({ embeds: [successEmbed(c.t('disconnect.done'))], ephemeral: true });
  }
}

async function handleStatus(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const connectionId = c.interaction.options.getString('connection');

  if (!connectionId) {
    const connections = await c.ctx.prisma.integrationConnection.findMany({
      where: { guildId: c.guildId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const lines = connections.map((conn) => {
      const providerId = providerIdFromEnum(conn.provider) ?? conn.provider;
      return `${statusLabel(conn.status)} **${providerId}** — ${conn.label ?? conn.externalAccountName ?? conn.id}`;
    });
    await c.interaction.reply({
      embeds: [listEmbed(c.t('list.title'), lines.length > 0 ? lines : [c.t('list.empty')])],
      ephemeral: true,
    });
    return;
  }

  const connection = await c.ctx.prisma.integrationConnection.findFirst({
    where: { id: connectionId, guildId: c.guildId },
  });
  if (!connection) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('status.notFound'))], ephemeral: true });
    return;
  }

  const providerId = providerIdFromEnum(connection.provider) ?? connection.provider;
  const config = readAlertConfig(connection);
  const embed = brandEmbed()
    .setTitle(c.t('status.title', { provider: String(providerId) }))
    .setDescription(
      c.t('status.line', {
        status: statusLabel(connection.status),
        target: config.target || connection.externalAccountName || '—',
        lastSync: connection.lastSyncAt ? discordTimestamp(connection.lastSyncAt, 'R') : 'never',
        lastError: connection.lastError ?? '—',
      }),
    );
  await c.interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleList(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const [connections, webhooks] = await Promise.all([
    c.ctx.prisma.integrationConnection.findMany({
      where: { guildId: c.guildId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    }),
    c.ctx.prisma.webhookEndpoint.findMany({
      where: { guildId: c.guildId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const connLines = connections.map((conn) => {
    const providerId = providerIdFromEnum(conn.provider) ?? conn.provider;
    return `${statusLabel(conn.status)} **${providerId}** — ${conn.label ?? conn.externalAccountName ?? conn.id}`;
  });
  const webhookLines = webhooks.map(
    (w) =>
      `${w.enabled ? '🟢' : '⚪'} **${w.name}** (${w.direction.toLowerCase()}, ${w.provider ?? 'generic'})`,
  );

  const embeds = [
    listEmbed(c.t('list.title'), connLines.length > 0 ? connLines : [c.t('list.empty')]),
    listEmbed(c.t('list.webhooksTitle'), webhookLines.length > 0 ? webhookLines : [c.t('webhook.empty')]),
  ];
  await c.interaction.reply({ embeds, ephemeral: true });
}

async function handleAlertsAdd(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const providerId = c.interaction.options.getString('provider', true) as AlertProviderId;
  const target = c.interaction.options.getString('target', true);
  const channel = c.interaction.options.getChannel('channel', true);
  const role = c.interaction.options.getRole('role');
  const template = c.interaction.options.getString('template');

  const connection = await createAlertConnection(c.ctx, c.guildId, c.interaction.user.id, 'bot', {
    provider: providerId,
    target,
    channelId: channel.id,
    roleId: role?.id ?? null,
    template,
  });

  const embed =
    connection.status === 'ERROR'
      ? errorEmbed(
          c.t('connect.unavailable', {
            provider: providerId,
            missingEnv: (getProvider(providerId)?.requiredEnv ?? []).join(', '),
          }),
        )
      : successEmbed(c.t('alerts.added', { target, provider: providerId, channelId: channel.id }));
  await c.interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAlertsRemove(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const connectionId = c.interaction.options.getString('connection', true);
  const existing = await c.ctx.prisma.integrationConnection.findFirst({
    where: { id: connectionId, guildId: c.guildId, deletedAt: null },
  });
  if (!existing) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('alerts.notFound'))], ephemeral: true });
    return;
  }
  await c.ctx.prisma.integrationConnection.update({
    where: { id: connectionId },
    data: { status: 'DISCONNECTED', deletedAt: new Date() },
  });
  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: AuditAction.IntegrationDisconnect,
    targetType: 'integration_connection',
    targetId: connectionId,
    source: 'bot',
  });
  await c.interaction.reply({ embeds: [successEmbed(c.t('alerts.removed'))], ephemeral: true });
}

async function handleAlertsList(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const providerFilter = c.interaction.options.getString('provider');
  const where: Record<string, unknown> = { guildId: c.guildId, deletedAt: null };
  if (providerFilter) where.provider = PROVIDER_ENUM_MAP[providerFilter as AlertProviderId];
  else where.provider = { in: ALERT_PROVIDER_IDS.map((id) => PROVIDER_ENUM_MAP[id]) };

  const connections = await c.ctx.prisma.integrationConnection.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
  const lines = connections.map((conn) => {
    const providerId = providerIdFromEnum(conn.provider) ?? conn.provider;
    const config = readAlertConfig(conn);
    return `${statusLabel(conn.status)} **${providerId}** \`${config.target}\` → <#${config.channelId}>`;
  });
  await c.interaction.reply({
    embeds: [
      listEmbed(
        c.t('list.title'),
        lines.length > 0 ? lines : [c.t('alerts.empty', { provider: providerFilter ?? 'any provider' })],
      ),
    ],
    ephemeral: true,
  });
}

async function handleWebhookCreate(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const name = c.interaction.options.getString('name', true);
  const provider = c.interaction.options.getString('provider') ?? 'generic';
  const channel = c.interaction.options.getChannel('channel');
  const template = c.interaction.options.getString('template');

  const { endpoint, secret } = await createInboundWebhook(c.ctx, c.guildId, c.interaction.user.id, 'bot', {
    name,
    provider,
    channelId: channel?.id ?? null,
    template,
  });

  const base = c.ctx.env.PUBLIC_WEBHOOK_BASE_URL ?? c.ctx.env.API_BASE_URL ?? '';
  // `generic` is the only provider this subcommand can create (see the `provider` option above), so the
  // endpoint always lives under the generic receiver.
  const path = `/webhooks/generic/${endpoint.id}`;
  await c.interaction.reply({
    embeds: [brandEmbed().setDescription(c.t('webhook.created', { url: `${base}${path}`, secret }))],
    ephemeral: true,
  });
}

async function handleWebhookList(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const endpoints = await c.ctx.prisma.webhookEndpoint.findMany({
    where: { guildId: c.guildId, direction: 'INBOUND', deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  const lines = endpoints.map(
    (e) =>
      `${e.enabled ? '🟢' : '⚪'} **${e.name}** (${e.provider ?? 'generic'})${e.channelId ? ` → <#${e.channelId}>` : ''}`,
  );
  await c.interaction.reply({
    embeds: [listEmbed(c.t('list.webhooksTitle'), lines.length > 0 ? lines : [c.t('webhook.empty')])],
    ephemeral: true,
  });
}

async function handleWebhookDelete(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const endpointId = c.interaction.options.getString('endpoint', true);
  const existing = await c.ctx.prisma.webhookEndpoint.findFirst({
    where: { id: endpointId, guildId: c.guildId, direction: 'INBOUND', deletedAt: null },
  });
  if (!existing) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('webhook.notFound'))], ephemeral: true });
    return;
  }
  await deleteWebhookEndpoint(c.ctx, c.guildId, endpointId, c.interaction.user.id, 'bot');
  await c.interaction.reply({ embeds: [successEmbed(c.t('webhook.deleted'))], ephemeral: true });
}

async function handleOutboundCreate(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const name = c.interaction.options.getString('name', true);
  const url = c.interaction.options.getString('url', true);
  const events = c.interaction.options
    .getString('events', true)
    .split(/[,\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  const invalid = events.filter((e) => !(OUTBOUND_PLATFORM_EVENTS as readonly string[]).includes(e));
  if (invalid.length > 0) {
    await c.interaction.reply({
      embeds: [
        errorEmbed(
          c.t('outbound.invalidEvents', {
            events: invalid.join(', '),
            validEvents: OUTBOUND_PLATFORM_EVENTS.join(', '),
          }),
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  try {
    const { secret } = await createOutboundWebhook(c.ctx, c.guildId, c.interaction.user.id, 'bot', {
      name,
      url,
      events,
    });
    await c.interaction.reply({
      embeds: [brandEmbed().setDescription(c.t('outbound.created', { secret, events: events.join(', ') }))],
      ephemeral: true,
    });
  } catch (err) {
    await c.interaction.reply({
      embeds: [
        errorEmbed(c.t('errors.invalidUrl', { reason: err instanceof Error ? err.message : String(err) })),
      ],
      ephemeral: true,
    });
  }
}

async function handleOutboundList(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const endpoints = await c.ctx.prisma.webhookEndpoint.findMany({
    where: { guildId: c.guildId, direction: 'OUTBOUND', deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  const lines = endpoints.map((e) =>
    c.t('outbound.list', {
      name: e.name,
      status: e.enabled ? 'enabled' : 'disabled',
      events: e.events.join(', '),
      failureCount: String(e.failureCount),
    }),
  );
  await c.interaction.reply({
    embeds: [listEmbed(c.t('list.webhooksTitle'), lines.length > 0 ? lines : [c.t('outbound.empty')])],
    ephemeral: true,
  });
}

async function handleOutboundDelete(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const endpointId = c.interaction.options.getString('endpoint', true);
  const existing = await c.ctx.prisma.webhookEndpoint.findFirst({
    where: { id: endpointId, guildId: c.guildId, direction: 'OUTBOUND', deletedAt: null },
  });
  if (!existing) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('outbound.notFound'))], ephemeral: true });
    return;
  }
  await deleteWebhookEndpoint(c.ctx, c.guildId, endpointId, c.interaction.user.id, 'bot');
  await c.interaction.reply({ embeds: [successEmbed(c.t('outbound.deleted'))], ephemeral: true });
}

async function handleOutboundTest(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const endpointId = c.interaction.options.getString('endpoint', true);
  await c.interaction.deferReply({ ephemeral: true });
  const service = c.ctx.services.get('integrations');
  const result = service
    ? await service.testWebhook(c.guildId, endpointId)
    : { delivered: false, error: 'Integrations service is not available.' };
  await c.interaction.editReply({
    embeds: [
      result.delivered
        ? successEmbed(c.t('outbound.testSent'))
        : errorEmbed(c.t('outbound.testFailed', { error: result.error ?? 'unknown error' })),
    ],
  });
}

export const command: PluginCommand = {
  data,
  requirement: {
    staffLevel: 'admin',
    guildOnly: true,
    discordPermissions: [PermissionFlagsBits.ManageGuild],
  },
  async execute(c) {
    assertStaffLevel(c.staffLevel, 'admin', c.t);
    const group = c.interaction.options.getSubcommandGroup(false);
    const sub = c.interaction.options.getSubcommand(true);

    if (!group) {
      if (sub === 'connect') return handleConnect(c);
      if (sub === 'disconnect') return handleDisconnect(c);
      if (sub === 'status') return handleStatus(c);
      if (sub === 'list') return handleList(c);
    }

    if (group === 'alerts') {
      if (sub === 'add') return handleAlertsAdd(c);
      if (sub === 'remove') return handleAlertsRemove(c);
      if (sub === 'list') return handleAlertsList(c);
    }

    if (group === 'webhook') {
      if (sub === 'create') return handleWebhookCreate(c);
      if (sub === 'list') return handleWebhookList(c);
      if (sub === 'delete') return handleWebhookDelete(c);
    }

    if (group === 'outbound') {
      if (sub === 'create') return handleOutboundCreate(c);
      if (sub === 'list') return handleOutboundList(c);
      if (sub === 'delete') return handleOutboundDelete(c);
      if (sub === 'test') return handleOutboundTest(c);
    }
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    const group = c.interaction.options.getSubcommandGroup(false);
    const sub = c.interaction.options.getSubcommand(false);
    const query = String(focused.value).toLowerCase();

    if (focused.name === 'connection') {
      const isAlertsScope = group === 'alerts';
      const where: Record<string, unknown> = { guildId: c.guildId, deletedAt: null };
      if (isAlertsScope) where.provider = { in: ALERT_PROVIDER_IDS.map((id) => PROVIDER_ENUM_MAP[id]) };
      const connections = await c.ctx.prisma.integrationConnection.findMany({
        where,
        take: 25,
        orderBy: { createdAt: 'desc' },
      });
      const results = connections
        .map((conn) => ({
          id: conn.id,
          label: `${providerIdFromEnum(conn.provider) ?? conn.provider}: ${conn.label ?? conn.externalAccountName ?? conn.id}`,
        }))
        .filter((c2) => c2.label.toLowerCase().includes(query))
        .slice(0, 25);
      await c.interaction.respond(results.map((r) => ({ name: r.label.slice(0, 100), value: r.id })));
      return;
    }

    if (focused.name === 'endpoint') {
      const direction = group === 'outbound' ? 'OUTBOUND' : 'INBOUND';
      const endpoints = await c.ctx.prisma.webhookEndpoint.findMany({
        where: { guildId: c.guildId, direction, deletedAt: null },
        take: 25,
        orderBy: { createdAt: 'desc' },
      });
      const results = endpoints.filter((e) => e.name.toLowerCase().includes(query)).slice(0, 25);
      await c.interaction.respond(results.map((e) => ({ name: e.name.slice(0, 100), value: e.id })));
      return;
    }

    void sub;
    await c.interaction.respond([]);
  },
};

/** Confirmation-flow button handlers for `/integration disconnect` (destructive-action convention, ARCHITECTURE.md §7.7). */
export const integrationConfirmComponents: ComponentHandler[] = registerConfirmHandlers<{
  connectionId: string;
}>('disconnect', async (c, payload) => {
  await disconnectConnection(c.ctx, c.guildId, payload.connectionId, c.interaction.user.id, 'bot');
  await c.interaction.followUp({ embeds: [successEmbed(c.t('disconnect.done'))], ephemeral: true });
});
