import {
  ActionRowBuilder,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  StringSelectMenuBuilder,
  type MessageContextMenuCommandInteraction,
  type SlashCommandBuilder,
} from 'discord.js';
import { AuditAction } from '@pavisie/core';
import {
  assertStaffLevel,
  buildCustomId,
  successEmbed,
  PendingStore,
  type CommandContext,
  type ContextMenuContext,
  type PluginCommand,
} from '../../sdk';
import { flagRecord } from '../service';

export function addFlagSubcommand(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addSubcommand((sub) =>
    sub
      .setName('flag')
      .setDescription('Manually flag a user for non-message behaviour (no message to point at).')
      .addUserOption((opt) => opt.setName('user').setDescription('The user to flag.').setRequired(true))
      .addStringOption((opt) =>
        opt.setName('reason').setDescription('What happened.').setRequired(true).setMaxLength(1000),
      )
      .addStringOption((opt) =>
        opt
          .setName('policy')
          .setDescription('Related policy, if any.')
          .setRequired(false)
          .setAutocomplete(true),
      ),
  ) as SlashCommandBuilder;
}

export async function executeFlag(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'helper', c.t);

  const targetUser = c.interaction.options.getUser('user', true);
  const reason = c.interaction.options.getString('reason', true);
  const policyId = c.interaction.options.getString('policy');

  let policyName: string | undefined;
  if (policyId) {
    const policy = await c.ctx.prisma.enforcerPolicy.findFirst({
      where: { id: policyId, guildId: c.guildId, deletedAt: null },
    });
    policyName = policy?.name;
  }

  const result = await flagRecord(c.ctx, {
    guildId: c.guildId,
    userId: targetUser.id,
    content: reason,
    policyId: policyId ?? undefined,
    policyName,
    source: 'MANUAL',
    flaggedBy: c.interaction.user.id,
  });

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: AuditAction.ModerationCaseCreate,
    targetType: 'enforcer_record',
    targetId: result.recordId,
    after: { userId: targetUser.id, recordNumber: result.recordNumber },
    source: 'bot',
  });

  await c.interaction.reply({
    embeds: [successEmbed(c.t('flag.created', { number: result.recordNumber }))],
    ephemeral: true,
  });
}

/** "Flag for review" message context menu (ARCHITECTURE.md §19) — a separate top-level command, staff >= helper.
 * No `setDefaultMemberPermissions` — that's a Discord-side visibility gate on top of (not instead of) the
 * `staffLevel: 'helper'` requirement below, and ModerateMembers would hide the menu item from helper-level
 * staff whose role lacks that specific Discord permission even though they're allowed to use it. */
export const flagContextMenuCommand: PluginCommand = {
  data: new ContextMenuCommandBuilder()
    .setName('Flag for review')
    .setType(ApplicationCommandType.Message)
    .setDMPermission(false),
  requirement: { staffLevel: 'helper', guildOnly: true },
  async execute() {
    // Slash-only entry point unused for a message context menu command.
  },
  async executeContextMenu(c: ContextMenuContext): Promise<void> {
    // The base `ContextMenuCommandInteraction` type (ARCHITECTURE.md §7.2's `ContextMenuContext`) doesn't carry
    // `.targetMessage` — only its `MessageContextMenuCommandInteraction` subclass does. This command always
    // registers with `ApplicationCommandType.Message`, so the cast is safe (same pattern as router.ts/sdk/confirm.ts).
    const interaction = c.interaction as unknown as MessageContextMenuCommandInteraction<'cached'>;
    const message = interaction.targetMessage;

    const policies = await c.ctx.prisma.enforcerPolicy.findMany({
      where: { guildId: c.guildId, enabled: true, deletedAt: null },
      take: 24,
      orderBy: { name: 'asc' },
    });

    const pendingStore = new PendingStore(c.ctx.redis);
    const pendingId = await pendingStore.put(
      {
        targetUserId: message.author.id,
        channelId: message.channelId,
        messageId: message.id,
        content: message.content ?? '',
      },
      120,
    );

    const select = new StringSelectMenuBuilder()
      .setCustomId(buildCustomId('enforcer', 'flag-select-policy', c.interaction.user.id, pendingId))
      .setPlaceholder('Select a policy (optional)')
      .addOptions(
        { label: 'No specific policy', value: 'none' },
        ...policies.map((p) => ({
          label: p.name.slice(0, 100),
          value: p.id,
          description: p.description.slice(0, 100),
        })),
      );

    const contentWarning =
      message.content.length === 0
        ? '\n-# This message has no readable content here (the Message Content intent may be off) — the flag will carry only a jump link unless your note adds context.'
        : '';

    await c.interaction.reply({
      content: `Flagging this message for review. Pick a policy (or none), then add an optional note.${contentWarning}`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      ephemeral: true,
    });
  },
};
