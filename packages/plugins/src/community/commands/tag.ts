// `/tag` — custom commands + auto-responders (spec CG-02). Members can `show`/`list`; moderators
// `create`/`edit`/`delete`; admins configure keyword `trigger`s; helpers see `info`. Tags never run a scripting
// language: content is plain text / a flat embed rendered with the fixed welcome-engine variable set.
import {
  ActionRowBuilder,
  ChannelType,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type User,
} from 'discord.js';
import { AuditAction, ValidationError, hasStaffLevel, truncate } from '@pavisie/core';
import type { Tag } from '@pavisie/database';
import {
  assertStaffLevel,
  buildCustomId,
  errorEmbed,
  infoEmbed,
  listEmbed,
  paginatedReply,
  requestConfirmation,
  successEmbed,
  type AutocompleteContext,
  type CommandContext,
  type PluginCommand,
  type PluginContext,
} from '../../sdk';
import type { CommunityConfig } from '../manifest';
import { invalidateTagTriggerCache } from '../tag-cache';
import {
  TAG_CONTENT_MAX,
  TAG_NAME_MAX,
  TAG_TRIGGER_MAX,
  TAG_TRIGGER_MIN,
  isValidTagName,
  normalizeTagName,
  parseStoredTagEmbed,
  renderTag,
  tagTemplateVars,
  type TagTriggerModeValue,
} from '../tags';

export const TAG_MODAL_ACTION = 'tag-modal';
export const TAG_DELETE_ACTION = 'tag-delete';
const LIST_PAGE_SIZE = 15;

const TRIGGER_MODE_CHOICES: { name: string; value: TagTriggerModeValue }[] = [
  { name: 'None (turn the auto-responder off)', value: 'NONE' },
  { name: 'Exact — the whole message equals the phrase', value: 'EXACT' },
  { name: 'Contains — the phrase appears as a whole word', value: 'CONTAINS' },
  { name: 'Starts with — the message begins with the phrase', value: 'STARTS_WITH' },
];

const data = new SlashCommandBuilder()
  .setName('tag')
  .setDescription('Custom commands: show, list, and manage tags.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('show')
      .setDescription('Post a tag.')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true),
      )
      .addBooleanOption((opt) =>
        opt.setName('ephemeral').setDescription('Show it only to you').setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List the tags on this server.'))
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create a tag (moderator+). Omit content to open an editor with embed fields.')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Tag name (lowercase letters, numbers, - or _)')
          .setRequired(true)
          .setMaxLength(TAG_NAME_MAX),
      )
      .addStringOption((opt) =>
        opt
          .setName('content')
          .setDescription('Plain-text content. Vars: {user} {user.tag} {server} {memberCount} {mention}')
          .setRequired(false)
          .setMaxLength(TAG_CONTENT_MAX),
      )
      .addBooleanOption((opt) =>
        opt.setName('staff_only').setDescription('Only helpers and above can show it').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Edit a tag in a modal (moderator+).')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Delete a tag (moderator+).')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('trigger')
      .setDescription('Set or clear a keyword auto-responder for a tag (admin).')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('How incoming messages are matched')
          .setRequired(true)
          .addChoices(...TRIGGER_MODE_CHOICES),
      )
      .addStringOption((opt) =>
        opt
          .setName('phrase')
          .setDescription('Trigger phrase (2-100 chars); required unless mode is none')
          .setRequired(false)
          .setMinLength(TAG_TRIGGER_MIN)
          .setMaxLength(TAG_TRIGGER_MAX),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Only respond in this channel (omit = every channel)')
          .setRequired(false)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Show a tag’s uses, trigger, and history (helper+).')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true),
      ),
  );

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function requireTagsEnabled(c: CommandContext): Promise<CommunityConfig> {
  const config = await c.config<CommunityConfig>();
  if (!config.tags.enabled) {
    throw new ValidationError(c.t('tag.disabled'));
  }
  return config;
}

async function findTagOrReply(c: CommandContext, rawName: string): Promise<Tag | null> {
  const name = normalizeTagName(rawName);
  const tag = await c.ctx.prisma.tag.findUnique({ where: { guildId_name: { guildId: c.guildId, name } } });
  if (!tag) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('tag.notFound', { name }))], ephemeral: true });
    return null;
  }
  return tag;
}

async function auditTag(
  ctx: PluginContext,
  guildId: string,
  actorId: string,
  action: string,
  tagId: string,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action,
    targetType: 'tag',
    targetId: tagId,
    before,
    after,
    source: 'bot',
  });
}

/** Opens the create/edit modal. Custom id: `community:tag-modal:<ownerUserId>:<create|edit>:<name>[:<staffOnly>]`. */
async function showTagModal(
  c: CommandContext,
  mode: 'create' | 'edit',
  name: string,
  existing?: { content?: string | null; embedTitle?: string; embedDescription?: string; staffOnly?: boolean },
): Promise<void> {
  const args =
    mode === 'create'
      ? [c.interaction.user.id, mode, name, existing?.staffOnly ? '1' : '0']
      : [c.interaction.user.id, mode, name];
  const modal = new ModalBuilder()
    .setCustomId(buildCustomId('community', TAG_MODAL_ACTION, ...args))
    .setTitle(c.t(mode === 'create' ? 'tag.modalCreateTitle' : 'tag.modalEditTitle', { name }).slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('content')
          .setLabel(c.t('tag.modalContentLabel').slice(0, 45))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(TAG_CONTENT_MAX)
          .setValue(existing?.content ?? ''),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('embed_title')
          .setLabel(c.t('tag.modalEmbedTitleLabel').slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(256)
          .setValue(existing?.embedTitle ?? ''),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('embed_description')
          .setLabel(c.t('tag.modalEmbedDescriptionLabel').slice(0, 45))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(4000)
          .setValue(existing?.embedDescription ?? ''),
      ),
    );
  await c.interaction.showModal(modal);
}

function describeTrigger(c: CommandContext, tag: Tag): string | null {
  if (tag.triggerMode === 'NONE' || !tag.trigger) return null;
  const modeKey =
    tag.triggerMode === 'EXACT'
      ? 'tag.triggerModeExact'
      : tag.triggerMode === 'CONTAINS'
        ? 'tag.triggerModeContains'
        : 'tag.triggerModeStartsWith';
  return c.t('tag.triggerMarker', { mode: c.t(modeKey), phrase: tag.trigger });
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function handleShow(c: CommandContext): Promise<void> {
  await requireTagsEnabled(c);
  const tag = await findTagOrReply(c, c.interaction.options.getString('name', true));
  if (!tag) return;
  if (tag.staffOnly) {
    assertStaffLevel(c.staffLevel, 'helper', c.t);
  }
  const ephemeral = c.interaction.options.getBoolean('ephemeral') ?? false;
  const rendered = renderTag(
    tag,
    tagTemplateVars(c.interaction.user as User, c.interaction.guild as Guild),
    c.interaction.user.id,
  );
  await c.interaction.reply({ ...rendered, ephemeral });
  await c.ctx.prisma.tag.update({ where: { id: tag.id }, data: { uses: { increment: 1 } } });
}

async function handleList(c: CommandContext): Promise<void> {
  await requireTagsEnabled(c);
  const isStaff = hasStaffLevel(c.staffLevel, 'helper');
  const tags = await c.ctx.prisma.tag.findMany({
    where: { guildId: c.guildId, ...(isStaff ? {} : { staffOnly: false }) },
    orderBy: { name: 'asc' },
    select: { name: true, staffOnly: true, triggerMode: true, uses: true },
  });
  if (tags.length === 0) {
    await c.interaction.reply({
      embeds: [infoEmbed(c.t('tag.listTitle', { count: 0 }), c.t('tag.listEmpty'))],
      ephemeral: true,
    });
    return;
  }
  const lines = tags.map((tag) => {
    const markers: string[] = [];
    if (tag.staffOnly) markers.push(c.t('tag.staffOnlyMarker'));
    if (tag.triggerMode !== 'NONE') markers.push('⚡');
    return `\`${tag.name}\`${markers.length > 0 ? ` ${markers.join(' ')}` : ''} — ${tag.uses} uses`;
  });
  const pages = [];
  for (let i = 0; i < lines.length; i += LIST_PAGE_SIZE) {
    pages.push(listEmbed(c.t('tag.listTitle', { count: tags.length }), lines.slice(i, i + LIST_PAGE_SIZE)));
  }
  await paginatedReply({
    interaction: c.interaction,
    pages,
    ownerId: c.interaction.user.id,
    pluginId: 'community',
    ephemeral: true,
  });
}

async function handleCreate(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  const config = await requireTagsEnabled(c);
  const name = normalizeTagName(c.interaction.options.getString('name', true));
  const content = c.interaction.options.getString('content');
  const staffOnly = c.interaction.options.getBoolean('staff_only') ?? false;

  if (!isValidTagName(name)) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('tag.badName'))], ephemeral: true });
    return;
  }
  const existing = await c.ctx.prisma.tag.findUnique({
    where: { guildId_name: { guildId: c.guildId, name } },
    select: { id: true },
  });
  if (existing) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('tag.exists', { name }))], ephemeral: true });
    return;
  }
  const count = await c.ctx.prisma.tag.count({ where: { guildId: c.guildId } });
  if (count >= config.tags.maxTags) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('tag.limit', { max: config.tags.maxTags }))],
      ephemeral: true,
    });
    return;
  }

  if (content === null || content.trim().length === 0) {
    await showTagModal(c, 'create', name, { staffOnly });
    return;
  }

  const created = await c.ctx.prisma.tag.create({
    data: { guildId: c.guildId, name, content, staffOnly, createdBy: c.interaction.user.id },
  });
  await auditTag(
    c.ctx,
    c.guildId,
    c.interaction.user.id,
    AuditAction.CommunityTagCreate,
    created.id,
    undefined,
    {
      name,
      staffOnly,
      hasContent: true,
      hasEmbed: false,
    },
  );
  await c.interaction.reply({ embeds: [successEmbed(c.t('tag.created', { name }))], ephemeral: true });
}

async function handleEdit(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  await requireTagsEnabled(c);
  const tag = await findTagOrReply(c, c.interaction.options.getString('name', true));
  if (!tag) return;
  const embed = parseStoredTagEmbed(tag.embed);
  await showTagModal(c, 'edit', tag.name, {
    content: tag.content,
    embedTitle: embed?.title,
    embedDescription: embed?.description,
  });
}

async function handleDelete(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'moderator', c.t);
  await requireTagsEnabled(c);
  const tag = await findTagOrReply(c, c.interaction.options.getString('name', true));
  if (!tag) return;
  await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'community',
    action: TAG_DELETE_ACTION,
    ownerId: c.interaction.user.id,
    embed: infoEmbed(
      c.t('tag.deleteConfirmTitle'),
      c.t('tag.deleteConfirmBody', { name: tag.name, uses: tag.uses }),
    ),
    payload: { tagId: tag.id, name: tag.name },
    fastActions: false,
  });
}

async function handleTrigger(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'admin', c.t);
  const config = await requireTagsEnabled(c);
  const tag = await findTagOrReply(c, c.interaction.options.getString('name', true));
  if (!tag) return;
  const mode = c.interaction.options.getString('mode', true) as TagTriggerModeValue;
  const phrase = c.interaction.options.getString('phrase')?.trim() ?? '';
  const channel = c.interaction.options.getChannel('channel');

  // Staff-only tags must never auto-respond publicly (same rule enforced in `tagBodySchema` for the API/dashboard).
  if (mode !== 'NONE' && tag.staffOnly) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('tag.staffOnlyNoTrigger', { name: tag.name }))],
      ephemeral: true,
    });
    return;
  }

  const before = {
    triggerMode: tag.triggerMode,
    trigger: tag.trigger,
    triggerChannelIds: tag.triggerChannelIds,
  };

  if (mode === 'NONE') {
    await c.ctx.prisma.tag.update({
      where: { id: tag.id },
      data: { triggerMode: 'NONE', trigger: null, triggerChannelIds: [], updatedBy: c.interaction.user.id },
    });
    await invalidateTagTriggerCache(c.ctx.redis, c.guildId);
    await auditTag(c.ctx, c.guildId, c.interaction.user.id, AuditAction.CommunityTagUpdate, tag.id, before, {
      triggerMode: 'NONE',
      trigger: null,
      triggerChannelIds: [],
    });
    await c.interaction.reply({
      embeds: [successEmbed(c.t('tag.triggerCleared', { name: tag.name }))],
      ephemeral: true,
    });
    return;
  }

  if (phrase.length < TAG_TRIGGER_MIN || phrase.length > TAG_TRIGGER_MAX) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('tag.badTrigger'))], ephemeral: true });
    return;
  }
  const triggerChannelIds = channel ? [channel.id] : [];
  await c.ctx.prisma.tag.update({
    where: { id: tag.id },
    data: { triggerMode: mode, trigger: phrase, triggerChannelIds, updatedBy: c.interaction.user.id },
  });
  await invalidateTagTriggerCache(c.ctx.redis, c.guildId);
  await auditTag(c.ctx, c.guildId, c.interaction.user.id, AuditAction.CommunityTagUpdate, tag.id, before, {
    triggerMode: mode,
    trigger: phrase,
    triggerChannelIds,
  });

  const modeKey =
    mode === 'EXACT'
      ? 'tag.triggerModeExact'
      : mode === 'CONTAINS'
        ? 'tag.triggerModeContains'
        : 'tag.triggerModeStartsWith';
  const lines = [
    c.t('tag.triggerSet', {
      name: tag.name,
      mode: c.t(modeKey),
      phrase,
      where: channel
        ? c.t('tag.triggerInChannel', { channel: `<#${channel.id}>` })
        : c.t('tag.triggerAnyChannel'),
    }),
  ];
  if (!c.ctx.intentsEnabled.messageContent) {
    lines.push(c.t('tag.triggersNeedIntent'));
  } else if (!config.tags.triggersEnabled) {
    lines.push(c.t('tag.triggersOffConfig'));
  }
  await c.interaction.reply({ embeds: [successEmbed(lines.join('\n\n'))], ephemeral: true });
}

async function handleInfo(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'helper', c.t);
  await requireTagsEnabled(c);
  const tag = await findTagOrReply(c, c.interaction.options.getString('name', true));
  if (!tag) return;
  const trigger = describeTrigger(c, tag);
  const channels =
    tag.triggerChannelIds.length > 0
      ? tag.triggerChannelIds.map((id) => `<#${id}>`).join(', ')
      : c.t('tag.infoAllChannels');
  const preview = tag.content
    ? truncate(tag.content, 300)
    : parseStoredTagEmbed(tag.embed)?.title || parseStoredTagEmbed(tag.embed)?.description || '';
  const embed = infoEmbed(
    c.t('tag.infoTitle', { name: tag.name }),
    preview.length > 0 ? preview : c.t('tag.infoEmbedOnly'),
  ).addFields(
    { name: c.t('tag.infoUses'), value: String(tag.uses), inline: true },
    { name: c.t('tag.infoStaffOnly'), value: c.t(tag.staffOnly ? 'tag.yes' : 'tag.no'), inline: true },
    { name: c.t('tag.infoTrigger'), value: trigger ?? c.t('tag.infoTriggerNone'), inline: false },
    { name: c.t('tag.infoChannels'), value: channels, inline: false },
    { name: c.t('tag.infoCreatedBy'), value: `<@${tag.createdBy}>`, inline: true },
    {
      name: c.t('tag.infoUpdatedBy'),
      value: tag.updatedBy ? `<@${tag.updatedBy}>` : '—',
      inline: true,
    },
    {
      name: c.t('tag.infoUpdatedAt'),
      value: `<t:${Math.floor(tag.updatedAt.getTime() / 1000)}:R>`,
      inline: true,
    },
  );
  await c.interaction.reply({ embeds: [embed], ephemeral: true });
}

async function tagAutocomplete(c: AutocompleteContext): Promise<void> {
  const focused = c.interaction.options.getFocused(true);
  if (focused.name !== 'name') {
    await c.interaction.respond([]);
    return;
  }
  const query = normalizeTagName(String(focused.value));
  const sub = c.interaction.options.getSubcommand(false);
  // Non-staff never see staff-only tags in `/tag show` suggestions (they couldn't run them anyway).
  const hideStaffOnly = sub === 'show' && !hasStaffLevel(c.staffLevel, 'helper');
  const rows = await c.ctx.prisma.tag.findMany({
    where: {
      guildId: c.guildId,
      ...(query ? { name: { startsWith: query } } : {}),
      ...(hideStaffOnly ? { staffOnly: false } : {}),
    },
    orderBy: { name: 'asc' },
    take: 25,
    select: { name: true },
  });
  await c.interaction.respond(rows.map((row) => ({ name: row.name, value: row.name })));
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true, cooldown: { seconds: 3, scope: 'user' } },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'show') return handleShow(c);
    if (sub === 'list') return handleList(c);
    if (sub === 'create') return handleCreate(c);
    if (sub === 'edit') return handleEdit(c);
    if (sub === 'delete') return handleDelete(c);
    if (sub === 'trigger') return handleTrigger(c);
    if (sub === 'info') return handleInfo(c);
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('errors.not_found', { thing: 'Subcommand' }))],
      ephemeral: true,
    });
  },
  async autocomplete(c) {
    await tagAutocomplete(c);
  },
};
