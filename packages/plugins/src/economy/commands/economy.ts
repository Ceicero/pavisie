import { SlashCommandBuilder } from 'discord.js';
import { hasStaffLevel } from '@pavisie/core';
import {
  errorEmbed,
  infoEmbed,
  listEmbed,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import type { EconomyConfig } from '../manifest';
import {
  DAILY_COOLDOWN_MS,
  encodeStreakNote,
  formatCurrency,
  parseStreakFromNote,
  rollDaily,
  validateGive,
} from '../service';

// Sentinels thrown from inside `$transaction` callbacks to unwind out of a failed conditional guard (a
// `updateMany` whose `where` re-checks the balance/cooldown at write time and affected zero rows) without
// committing anything else the callback had already queued. Caught just outside the transaction, where the
// existing user-facing message is sent. Never escape this module.
class InsufficientBalanceError extends Error {}
class BalanceWouldGoNegativeError extends Error {}
class DailyAlreadyClaimedError extends Error {}

const data = new SlashCommandBuilder()
  .setName('economy')
  .setDescription('Virtual currency — no real-money value, no purchases, no cash-out.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('balance')
      .setDescription('Check a balance.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Whose balance to check (default: you)').setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName('daily').setDescription('Claim your daily reward.'))
  .addSubcommand((sub) =>
    sub
      .setName('give')
      .setDescription('Give some of your balance to another member.')
      .addUserOption((opt) => opt.setName('user').setDescription('Who to give to').setRequired(true))
      .addIntegerOption((opt) =>
        opt.setName('amount').setDescription('How much to give').setRequired(true).setMinValue(1),
      ),
  )
  .addSubcommand((sub) => sub.setName('leaderboard').setDescription('Show the top balances.'))
  .addSubcommand((sub) =>
    sub
      .setName('config')
      .setDescription('View or change the currency name/symbol and reward amounts.')
      .addStringOption((opt) =>
        opt
          .setName('currency-name')
          .setDescription('Currency name, e.g. "Coins"')
          .setRequired(false)
          .setMaxLength(32),
      )
      .addStringOption((opt) =>
        opt
          .setName('currency-symbol')
          .setDescription('Currency symbol/emoji, e.g. "🪙"')
          .setRequired(false)
          .setMaxLength(8),
      )
      .addIntegerOption((opt) =>
        opt.setName('daily-min').setDescription('Minimum daily reward').setRequired(false).setMinValue(0),
      )
      .addIntegerOption((opt) =>
        opt.setName('daily-max').setDescription('Maximum daily reward').setRequired(false).setMinValue(0),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('give-min')
          .setDescription('Minimum /economy give amount')
          .setRequired(false)
          .setMinValue(1),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('give-max')
          .setDescription('Maximum /economy give amount')
          .setRequired(false)
          .setMinValue(1),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('admin')
      .setDescription('Admin balance adjustments.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription("Add to a member's balance.")
          .addUserOption((opt) => opt.setName('user').setDescription('Who to credit').setRequired(true))
          .addIntegerOption((opt) =>
            opt.setName('amount').setDescription('Amount to add').setRequired(true).setMinValue(1),
          )
          .addStringOption((opt) =>
            opt
              .setName('reason')
              .setDescription('Reason (recorded on the transaction)')
              .setRequired(false)
              .setMaxLength(200),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription("Remove from a member's balance.")
          .addUserOption((opt) => opt.setName('user').setDescription('Who to debit').setRequired(true))
          .addIntegerOption((opt) =>
            opt.setName('amount').setDescription('Amount to remove').setRequired(true).setMinValue(1),
          )
          .addStringOption((opt) =>
            opt
              .setName('reason')
              .setDescription('Reason (recorded on the transaction)')
              .setRequired(false)
              .setMaxLength(200),
          ),
      ),
  );

async function getOrCreateAccount(c: CommandContext, userId: string) {
  return c.ctx.prisma.economyAccount.upsert({
    where: { guildId_userId: { guildId: c.guildId, userId } },
    create: { guildId: c.guildId, userId },
    update: {},
  });
}

async function handleBalance(c: CommandContext): Promise<void> {
  const config = await c.config<EconomyConfig>();
  const target = c.interaction.options.getUser('user') ?? c.interaction.user;
  const account = await getOrCreateAccount(c, target.id);
  await c.interaction.reply({
    embeds: [
      infoEmbed(
        c.t('balanceTitle', { user: target.username }),
        formatCurrency(account.balance, config.currencySymbol),
      ),
    ],
    ephemeral: true,
  });
}

async function handleDaily(c: CommandContext): Promise<void> {
  const { ctx, guildId, t } = c;
  const config = await c.config<EconomyConfig>();
  const userId = c.interaction.user.id;

  const account = await getOrCreateAccount(c, userId);
  const lastDailyTx = await ctx.prisma.economyTransaction.findFirst({
    where: { guildId, toUserId: userId, type: 'daily' },
    orderBy: { createdAt: 'desc' },
  });
  const priorStreak = parseStreakFromNote(lastDailyTx?.note);

  const now = new Date();
  const result = rollDaily({
    now,
    lastDailyAt: account.lastDailyAt,
    priorStreak,
    config,
    rng: Math.random,
  });
  if (!result.ok) {
    const hours = Math.ceil(result.retryAfterMs / (60 * 60 * 1000));
    await c.interaction.reply({ embeds: [errorEmbed(t('dailyCooldown', { hours }))], ephemeral: true });
    return;
  }

  // `account.lastDailyAt` above was read before this transaction, so two fast `/economy daily` calls can both
  // pass the `rollDaily` cooldown check against the same stale timestamp. The conditional `updateMany` below
  // re-checks the cooldown at write time — it only claims the daily (and only then writes the ledger row) when
  // `lastDailyAt` is still null or past the cutoff — so only one of two racing calls can win.
  const amount = BigInt(result.amount);
  const cutoff = new Date(now.getTime() - DAILY_COOLDOWN_MS);
  try {
    await ctx.prisma.$transaction(async (tx) => {
      const claimed = await tx.economyAccount.updateMany({
        where: { id: account.id, OR: [{ lastDailyAt: null }, { lastDailyAt: { lte: cutoff } }] },
        data: { balance: { increment: amount }, lastDailyAt: now },
      });
      if (claimed.count === 0) throw new DailyAlreadyClaimedError();

      await tx.economyTransaction.create({
        data: {
          guildId,
          accountId: account.id,
          toUserId: userId,
          amount,
          type: 'daily',
          note: encodeStreakNote(result.streak),
        },
      });
    });
  } catch (err) {
    if (err instanceof DailyAlreadyClaimedError) {
      // Recompute from a fresh read so the hours shown reflect the claim that actually won the race, not the
      // stale `account.lastDailyAt` this handler started with.
      const fresh = await ctx.prisma.economyAccount.findUniqueOrThrow({ where: { id: account.id } });
      const elapsed = fresh.lastDailyAt ? Date.now() - fresh.lastDailyAt.getTime() : 0;
      const hours = Math.ceil(Math.max(0, DAILY_COOLDOWN_MS - elapsed) / (60 * 60 * 1000));
      await c.interaction.reply({ embeds: [errorEmbed(t('dailyCooldown', { hours }))], ephemeral: true });
      return;
    }
    throw err;
  }

  await c.interaction.reply({
    embeds: [
      successEmbed(
        t('dailyClaimed', { amount: formatCurrency(amount, config.currencySymbol), streak: result.streak }),
      ),
    ],
    ephemeral: true,
  });
}

async function handleGive(c: CommandContext): Promise<void> {
  const { ctx, guildId, t } = c;
  const config = await c.config<EconomyConfig>();
  const target = c.interaction.options.getUser('user', true);
  const amount = c.interaction.options.getInteger('amount', true);
  const senderId = c.interaction.user.id;

  const senderAccount = await getOrCreateAccount(c, senderId);
  const validation = validateGive({
    amount,
    senderBalance: senderAccount.balance,
    config: { giveMinAmount: config.giveMinAmount, giveMaxAmount: config.giveMaxAmount },
    targetIsSelf: target.id === senderId,
    targetIsBot: target.bot,
  });

  if (!validation.ok) {
    const key = `give.${validation.reason}` as const;
    await c.interaction.reply({
      embeds: [errorEmbed(t(key, { min: config.giveMinAmount, max: config.giveMaxAmount }))],
      ephemeral: true,
    });
    return;
  }

  const targetAccount = await getOrCreateAccount(c, target.id);
  const bigAmount = BigInt(amount);

  // `validateGive` above only checked `senderAccount.balance` as read before this transaction — two concurrent
  // `/economy give` calls could both pass that check and both reach here. The conditional `updateMany` is the
  // real guard: it only decrements (and only then does the rest of the transfer run) if the balance is still
  // sufficient at write time, so a second racing call that would overdraw finds zero rows affected instead.
  try {
    await ctx.prisma.$transaction(async (tx) => {
      const claimed = await tx.economyAccount.updateMany({
        where: { id: senderAccount.id, balance: { gte: bigAmount } },
        data: { balance: { decrement: bigAmount } },
      });
      if (claimed.count === 0) throw new InsufficientBalanceError();

      await tx.economyAccount.update({
        where: { id: targetAccount.id },
        data: { balance: { increment: bigAmount } },
      });
      await tx.economyTransaction.create({
        data: {
          guildId,
          accountId: senderAccount.id,
          fromUserId: senderId,
          toUserId: target.id,
          amount: bigAmount,
          type: 'give',
        },
      });
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      await c.interaction.reply({
        embeds: [
          errorEmbed(t('give.insufficient_balance', { min: config.giveMinAmount, max: config.giveMaxAmount })),
        ],
        ephemeral: true,
      });
      return;
    }
    throw err;
  }

  await c.interaction.reply({
    embeds: [
      successEmbed(
        t('gave', { amount: formatCurrency(bigAmount, config.currencySymbol), user: target.username }),
      ),
    ],
    ephemeral: true,
  });
}

async function handleLeaderboard(c: CommandContext): Promise<void> {
  const config = await c.config<EconomyConfig>();
  const rows = await c.ctx.prisma.economyAccount.findMany({
    where: { guildId: c.guildId },
    orderBy: { balance: 'desc' },
    take: 10,
  });
  const lines = rows.map(
    (row, i) => `**${i + 1}.** <@${row.userId}> — ${formatCurrency(row.balance, config.currencySymbol)}`,
  );
  await c.interaction.reply({ embeds: [listEmbed(c.t('leaderboardTitle'), lines)], ephemeral: true });
}

async function handleConfig(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const patch: Partial<EconomyConfig> = {};
  const currencyName = interaction.options.getString('currency-name');
  const currencySymbol = interaction.options.getString('currency-symbol');
  const dailyMin = interaction.options.getInteger('daily-min');
  const dailyMax = interaction.options.getInteger('daily-max');
  const giveMin = interaction.options.getInteger('give-min');
  const giveMax = interaction.options.getInteger('give-max');
  if (currencyName !== null) patch.currencyName = currencyName;
  if (currencySymbol !== null) patch.currencySymbol = currencySymbol;
  if (dailyMin !== null) patch.dailyMinAmount = dailyMin;
  if (dailyMax !== null) patch.dailyMaxAmount = dailyMax;
  if (giveMin !== null) patch.giveMinAmount = giveMin;
  if (giveMax !== null) patch.giveMaxAmount = giveMax;

  const config =
    Object.keys(patch).length > 0
      ? await ctx.setConfig<EconomyConfig>(guildId, patch, { id: interaction.user.id, source: 'bot' })
      : await c.config<EconomyConfig>();

  await interaction.reply({
    embeds: [
      infoEmbed(
        t('configTitle'),
        [
          `Currency: **${config.currencyName}** (${config.currencySymbol})`,
          `Daily reward: ${config.dailyMinAmount}-${config.dailyMaxAmount} (+streak bonus, ${config.streakBonusPerDay}/day up to ${config.streakBonusMax})`,
          `Give limits: ${config.giveMinAmount}-${config.giveMaxAmount}`,
        ].join('\n'),
      ),
    ],
    ephemeral: true,
  });
}

async function handleAdminAdjust(c: CommandContext, direction: 1 | -1): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const config = await c.config<EconomyConfig>();
  const target = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount', true);
  const reason = interaction.options.getString('reason') ?? undefined;

  const account = await getOrCreateAccount(c, target.id);
  const bigAmount = BigInt(amount);

  // Two concurrent admin adjustments used to both read the same stale `account.balance` and both write an
  // absolute `nextBalance` computed from it — the loser's write clobbered the winner's, yet both still wrote a
  // ledger row, overstating the movement. `increment`/`decrement` make each write relative instead of absolute,
  // and the `remove` direction re-checks the never-negative rule at write time via a conditional `updateMany`
  // (only writing the ledger row once that guard actually passes) rather than trusting the stale pre-read.
  let afterBalance: bigint;
  try {
    afterBalance = await ctx.prisma.$transaction(async (tx) => {
      if (direction === -1) {
        const claimed = await tx.economyAccount.updateMany({
          where: { id: account.id, balance: { gte: bigAmount } },
          data: { balance: { decrement: bigAmount } },
        });
        if (claimed.count === 0) throw new BalanceWouldGoNegativeError();
      } else {
        await tx.economyAccount.update({
          where: { id: account.id },
          data: { balance: { increment: bigAmount } },
        });
      }

      await tx.economyTransaction.create({
        data: {
          guildId,
          accountId: account.id,
          toUserId: direction === 1 ? target.id : undefined,
          fromUserId: direction === -1 ? target.id : undefined,
          amount: bigAmount,
          type: direction === 1 ? 'admin_add' : 'admin_remove',
          note: reason,
        },
      });

      // Read the true post-write balance back inside the transaction rather than trusting a computed value —
      // `updateMany` (used above for `remove`) only returns an affected-row count, not the row itself.
      const updated = await tx.economyAccount.findUniqueOrThrow({ where: { id: account.id } });
      return updated.balance;
    });
  } catch (err) {
    if (err instanceof BalanceWouldGoNegativeError) {
      await interaction.reply({ embeds: [errorEmbed(t('admin.wouldGoNegative'))], ephemeral: true });
      return;
    }
    throw err;
  }

  await ctx.audit({
    guildId,
    actorId: interaction.user.id,
    actorType: 'user',
    action: direction === 1 ? 'economy.admin.add' : 'economy.admin.remove',
    targetType: 'economy_account',
    targetId: account.id,
    after: { balance: afterBalance.toString(), amount, reason },
    source: 'bot',
  });

  await interaction.reply({
    embeds: [
      successEmbed(
        t(direction === 1 ? 'admin.added' : 'admin.removed', {
          amount: formatCurrency(BigInt(amount), config.currencySymbol),
          user: target.username,
        }),
      ),
    ],
    ephemeral: true,
  });
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true },
  async execute(c) {
    const group = c.interaction.options.getSubcommandGroup(false);
    const sub = c.interaction.options.getSubcommand(true);

    if (group === 'admin') {
      if (!hasStaffLevel(c.staffLevel, 'moderator')) {
        await c.interaction.reply({
          embeds: [errorEmbed(c.t('errors.missing_staff_level', { level: 'moderator' }))],
          ephemeral: true,
        });
        return;
      }
      return handleAdminAdjust(c, sub === 'add' ? 1 : -1);
    }

    if (sub === 'balance') return handleBalance(c);
    if (sub === 'daily') return handleDaily(c);
    if (sub === 'give') return handleGive(c);
    if (sub === 'leaderboard') return handleLeaderboard(c);
    if (sub === 'config') {
      if (!hasStaffLevel(c.staffLevel, 'moderator')) {
        await c.interaction.reply({
          embeds: [errorEmbed(c.t('errors.missing_staff_level', { level: 'moderator' }))],
          ephemeral: true,
        });
        return;
      }
      return handleConfig(c);
    }
  },
};
