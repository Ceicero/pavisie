import type { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';
import type { PrismaClient } from '@pavisie/database';
import { errorEmbed, type ComponentHandler } from '../../sdk';
import { refreshPollMessage } from '../actions';
import { decidePollVote } from '../service';

async function applyVote(
  pollId: string,
  optionId: string,
  userId: string,
  ctxPrisma: PrismaClient,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const poll = await ctxPrisma.poll.findUnique({ where: { id: pollId } });
  if (!poll || poll.closed) {
    return { ok: false, message: 'This poll is no longer accepting votes.' };
  }
  const option = await ctxPrisma.pollOption.findUnique({ where: { id: optionId } });
  if (!option || option.pollId !== pollId) {
    return { ok: false, message: 'That option no longer exists.' };
  }

  const existingVotes = await ctxPrisma.pollVote.findMany({ where: { pollId, userId } });
  const decision = decidePollVote(
    optionId,
    existingVotes.map((v) => v.optionId),
    poll.multiSelect,
  );

  if (decision.removeOptionIds.length > 0) {
    await ctxPrisma.pollVote.deleteMany({
      where: { pollId, userId, optionId: { in: decision.removeOptionIds } },
    });
  }
  if (decision.add) {
    await ctxPrisma.pollVote.upsert({
      where: { pollId_optionId_userId: { pollId, optionId, userId } },
      create: { pollId, optionId, userId },
      update: {},
    });
  }

  return { ok: true };
}

const voteButton: ComponentHandler = {
  action: 'vote',
  kind: 'button',
  ownerOnly: false,
  async handler(c) {
    const interaction = c.interaction as ButtonInteraction<'cached'>;
    const [pollId, optionId] = c.args;
    if (!pollId || !optionId) {
      await interaction.reply({ embeds: [errorEmbed('Malformed vote button.')], ephemeral: true });
      return;
    }
    const result = await applyVote(pollId, optionId, interaction.user.id, c.ctx.prisma);
    if (!result.ok) {
      await interaction.reply({ embeds: [errorEmbed(result.message)], ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    await refreshPollMessage(c.ctx, pollId);
  },
};

const voteSelect: ComponentHandler = {
  action: 'vote-select',
  kind: 'select',
  ownerOnly: false,
  async handler(c) {
    const interaction = c.interaction as unknown as StringSelectMenuInteraction<'cached'>;
    const [pollId] = c.args;
    const optionId = interaction.values[0];
    if (!pollId || !optionId) {
      await interaction.reply({ embeds: [errorEmbed('Malformed vote menu.')], ephemeral: true });
      return;
    }
    const result = await applyVote(pollId, optionId, interaction.user.id, c.ctx.prisma);
    if (!result.ok) {
      await interaction.reply({ embeds: [errorEmbed(result.message)], ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    await refreshPollMessage(c.ctx, pollId);
  },
};

export const pollComponents: ComponentHandler[] = [voteButton, voteSelect];
