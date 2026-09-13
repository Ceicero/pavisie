// `/tag create|edit` modal submit + `/tag delete` confirm/cancel buttons (spec CG-02).
// Modal custom id: `community:tag-modal:<ownerUserId>:<create|edit>:<name>[:<staffOnly 0|1>]`.
import type { ModalSubmitInteraction } from 'discord.js';
import { AuditAction } from '@pavisie/core';
import { Prisma } from '@pavisie/database';
import { errorEmbed, registerConfirmHandlers, successEmbed, type ComponentHandler } from '../../sdk';
import type { CommunityConfig } from '../manifest';
import { invalidateTagTriggerCache } from '../tag-cache';
import {
  isTagEmbedEmpty,
  isValidTagName,
  parseStoredTagEmbed,
  tagEmbedSchema,
  type TagEmbedInput,
} from '../tags';

const TAG_MODAL_ACTION = 'tag-modal';
const TAG_DELETE_ACTION = 'tag-delete';

function readField(interaction: ModalSubmitInteraction<'cached'>, id: string): string {
  try {
    return interaction.fields.getTextInputValue(id).trim();
  } catch {
    return '';
  }
}

const tagModalHandler: ComponentHandler = {
  action: TAG_MODAL_ACTION,
  kind: 'modal',
  ownerOnly: true,
  requirement: { staffLevel: 'moderator' },
  async handler(c) {
    const interaction = c.interaction as unknown as ModalSubmitInteraction<'cached'>;
    const [, mode, name, staffOnlyFlag] = c.args;
    if ((mode !== 'create' && mode !== 'edit') || !name || !isValidTagName(name)) {
      await interaction.reply({ embeds: [errorEmbed(c.t('tag.badName'))], ephemeral: true });
      return;
    }

    const config = await c.config<CommunityConfig>();
    if (!config.tags.enabled) {
      await interaction.reply({ embeds: [errorEmbed(c.t('tag.disabled'))], ephemeral: true });
      return;
    }

    const content = readField(interaction, 'content');
    const embedTitle = readField(interaction, 'embed_title');
    const embedDescription = readField(interaction, 'embed_description');

    const existing = await c.ctx.prisma.tag.findUnique({
      where: { guildId_name: { guildId: c.guildId, name } },
    });

    // Merge the modal's title/description over whatever embed fields the tag already has (color, image, footer
    // are only editable from the dashboard) so an edit never silently drops them.
    const priorEmbed: TagEmbedInput | undefined =
      mode === 'edit' && existing ? parseStoredTagEmbed(existing.embed) : undefined;
    const mergedEmbed = tagEmbedSchema.parse({
      ...(priorEmbed ?? {}),
      title: embedTitle || undefined,
      description: embedDescription || undefined,
    });
    const embed = isTagEmbedEmpty(mergedEmbed) ? null : mergedEmbed;

    if (!content && !embed) {
      await interaction.reply({ embeds: [errorEmbed(c.t('tag.noContent'))], ephemeral: true });
      return;
    }

    if (mode === 'create') {
      if (existing) {
        await interaction.reply({ embeds: [errorEmbed(c.t('tag.exists', { name }))], ephemeral: true });
        return;
      }
      const count = await c.ctx.prisma.tag.count({ where: { guildId: c.guildId } });
      if (count >= config.tags.maxTags) {
        await interaction.reply({
          embeds: [errorEmbed(c.t('tag.limit', { max: config.tags.maxTags }))],
          ephemeral: true,
        });
        return;
      }
      const staffOnly = staffOnlyFlag === '1';
      const created = await c.ctx.prisma.tag.create({
        data: {
          guildId: c.guildId,
          name,
          content: content || null,
          embed: embed ?? undefined,
          staffOnly,
          createdBy: interaction.user.id,
        },
      });
      await c.ctx.audit({
        guildId: c.guildId,
        actorId: interaction.user.id,
        actorType: 'user',
        action: AuditAction.CommunityTagCreate,
        targetType: 'tag',
        targetId: created.id,
        after: { name, staffOnly, hasContent: Boolean(content), hasEmbed: Boolean(embed) },
        source: 'bot',
      });
      await interaction.reply({ embeds: [successEmbed(c.t('tag.created', { name }))], ephemeral: true });
      return;
    }

    if (!existing) {
      await interaction.reply({ embeds: [errorEmbed(c.t('tag.notFound', { name }))], ephemeral: true });
      return;
    }
    const updated = await c.ctx.prisma.tag.update({
      where: { id: existing.id },
      data: {
        content: content || null,
        // Prisma's nullable Json columns need the `Prisma.DbNull` sentinel (not a bare `null`) to clear.
        embed: embed ?? Prisma.DbNull,
        updatedBy: interaction.user.id,
      },
    });
    // Content edits don't change trigger matching, but keep the cache honest anyway (cheap DEL).
    await invalidateTagTriggerCache(c.ctx.redis, c.guildId);
    await c.ctx.audit({
      guildId: c.guildId,
      actorId: interaction.user.id,
      actorType: 'user',
      action: AuditAction.CommunityTagUpdate,
      targetType: 'tag',
      targetId: updated.id,
      before: {
        hasContent: Boolean(existing.content),
        hasEmbed: Boolean(parseStoredTagEmbed(existing.embed)),
      },
      after: { hasContent: Boolean(content), hasEmbed: Boolean(embed) },
      source: 'bot',
    });
    await interaction.reply({ embeds: [successEmbed(c.t('tag.updated', { name }))], ephemeral: true });
  },
};

const tagDeleteConfirmHandlers: ComponentHandler[] = registerConfirmHandlers<{ tagId: string; name: string }>(
  TAG_DELETE_ACTION,
  async (c, payload) => {
    const existing = await c.ctx.prisma.tag.findFirst({ where: { id: payload.tagId, guildId: c.guildId } });
    if (!existing) {
      await c.interaction.followUp({
        embeds: [errorEmbed(c.t('tag.notFound', { name: payload.name }))],
        ephemeral: true,
      });
      return;
    }
    await c.ctx.prisma.tag.delete({ where: { id: existing.id } });
    await invalidateTagTriggerCache(c.ctx.redis, c.guildId);
    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: AuditAction.CommunityTagDelete,
      targetType: 'tag',
      targetId: existing.id,
      before: { name: existing.name, uses: existing.uses, triggerMode: existing.triggerMode },
      source: 'bot',
    });
    await c.interaction.followUp({
      embeds: [successEmbed(c.t('tag.deleted', { name: existing.name }))],
      ephemeral: true,
    });
  },
);

export const tagComponents: ComponentHandler[] = [tagModalHandler, ...tagDeleteConfirmHandlers];
