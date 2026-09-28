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
  formatCurrency,
  validateGive,
} from '../service';
import {
  type EconomyPlatform,
  type WalletKey,
  EARNED_TRANSACTION_TYPES,
  getOrCreateWallet,
  claimDaily,
  give as ledgerGive,
  adminAdjust as ledgerAdminAdjust,
} from '../ledger';

// Escape markdown special characters in a string (for Twitch names in leaderboard display)
function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/\|/g, '\\|')
    .replace(/>/g, '\\>');
}

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
  .addSubcommand((sub) =>
    sub
      .setName('leaderboard')
      .setDescription('Show the top balances.')
      .addStringOption((opt) =>
        opt
          .setName('platform')
          .setDescription('Which leaderboard to show (default: global)')
          .setRequired(false)
          .addChoices(
            { name: 'Global (all platforms)', value: 'global' },
            { name: 'Discord only', value: 'discord' },
            { name: 'Twitch only', value: 'twitch' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('config')
      .setDescription('View or change the currency name/symbol and reward amounts.')
      .addStringOption((opt) =>
        opt
          .setName('currency-name')
          .setDescription('Currency name, e.g. "Agis"')
          .setRequired(false)
          .setMaxLength(32),
      )
      .addStringOption((opt) =>
        opt
          .setName('currency-symbol')
          .setDescription('Currency symbol/emoji, e.g. "♦️"')
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

async function handleBalance(c: CommandContext): Promise<void> {
  const config = await c.config<EconomyConfig>();
  const target = c.interaction.options.getUser('user') ?? c.interaction.user;
  const key: WalletKey = { guildId: c.guildId, platform: 'DISCORD', userId: target.id };
  const account = await getOrCreateWallet(c.ctx.prisma, key);
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
  const key: WalletKey = { guildId, platform: 'DISCORD', userId };

  const now = new Date();
  const result = await claimDaily(ctx.prisma, key, config, now, Math.random);

  if (!result.ok) {
    const hours = Math.ceil(result.retryAfterMs / (60 * 60 * 1000));
    await c.interaction.reply({ embeds: [errorEmbed(t('dailyCooldown', { hours }))], ephemeral: true });
    return;
  }

  await c.interaction.reply({
    embeds: [
      successEmbed(
        t('dailyClaimed', { amount: formatCurrency(result.amount, config.currencySymbol), streak: result.streak }),
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

  const senderKey: WalletKey = { guildId, platform: 'DISCORD', userId: senderId };
  const targetKey: WalletKey = { guildId, platform: 'DISCORD', userId: target.id };

  // Validate before wallet operations
  const senderAccount = await getOrCreateWallet(ctx.prisma, senderKey);
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

  const result = await ledgerGive(ctx.prisma, senderKey, targetKey, amount, {
    giveMinAmount: config.giveMinAmount,
    giveMaxAmount: config.giveMaxAmount,
  });

  if (!result.ok) {
    const key = `give.${result.reason}` as const;
    await c.interaction.reply({
      embeds: [errorEmbed(t(key, { min: config.giveMinAmount, max: config.giveMaxAmount }))],
      ephemeral: true,
    });
    return;
  }

  await c.interaction.reply({
    embeds: [
      successEmbed(
        t('gave', { amount: formatCurrency(BigInt(amount), config.currencySymbol), user: target.username }),
      ),
    ],
    ephemeral: true,
  });
}

async function handleLeaderboard(c: CommandContext): Promise<void> {
  const config = await c.config<EconomyConfig>();
  const platformOption = (c.interaction.options.getString('platform') ?? 'global') as 'global' | 'discord' | 'twitch';

  if (platformOption === 'global') {
    // Global leaderboard: top 10 by current balance across all platforms
    const rows = await c.ctx.prisma.economyAccount.findMany({
      where: { guildId: c.guildId },
      orderBy: { balance: 'desc' },
      take: 10,
    });
    const lines = rows.map((row, i) => {
      const userStr =
        row.platform === 'TWITCH'
          ? `${escapeMarkdown(row.displayName || 'Twitch viewer')} (Twitch)`
          : `<@${row.userId}>`;
      return `**${i + 1}.** ${userStr} — ${formatCurrency(row.balance, config.currencySymbol)}`;
    });
    await c.interaction.reply({
      embeds: [listEmbed(c.t('leaderboardTitle'), lines)],
      ephemeral: true,
    });
  } else {
    // Platform-specific leaderboard: top 10 by lifetime earned (sum of earned transaction types)
    const platform: EconomyPlatform = platformOption === 'discord' ? 'DISCORD' : 'TWITCH';
    const titleKey = platformOption === 'discord' ? 'leaderboardDiscordTitle' : 'leaderboardTwitchTitle';

    const rows = await c.ctx.prisma.economyTransaction.groupBy({
      by: ['accountId'],
      where: {
        guildId: c.guildId,
        platform,
        accountId: { not: null },
        type: { in: [...EARNED_TRANSACTION_TYPES] },
      },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 10,
    });

    // Fetch the account details for each row
    const accountIds = rows.map((r) => r.accountId).filter(Boolean) as string[];
    const accounts = await c.ctx.prisma.economyAccount.findMany({
      where: { id: { in: accountIds } },
    });
    const accountMap = new Map(accounts.map((a) => [a.id, a]));

    const lines = rows.map((row, i) => {
      const account = accountMap.get(row.accountId!);
      if (!account) return null;
      const amount = row._sum.amount || 0n;
      const userStr =
        account.platform === 'TWITCH'
          ? `${escapeMarkdown(account.displayName || 'Twitch viewer')} (Twitch)`
          : `<@${account.userId}>`;
      return `**${i + 1}.** ${userStr} — ${formatCurrency(amount, config.currencySymbol)}`;
    });

    const filteredLines = lines.filter((line) => line !== null) as string[];
    await c.interaction.reply({
      embeds: [listEmbed(c.t(titleKey, { platform: platformOption }), filteredLines)],
      ephemeral: true,
    });
  }
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

  const key: WalletKey = { guildId, platform: 'DISCORD', userId: target.id };

  const result = await ledgerAdminAdjust(ctx.prisma, key, direction, amount, reason);

  if (!result.ok) {
    await interaction.reply({ embeds: [errorEmbed(t('admin.wouldGoNegative'))], ephemeral: true });
    return;
  }

  const account = await getOrCreateWallet(ctx.prisma, key);

  await ctx.audit({
    guildId,
    actorId: interaction.user.id,
    actorType: 'user',
    action: direction === 1 ? 'economy.admin.add' : 'economy.admin.remove',
    targetType: 'economy_account',
    targetId: account.id,
    after: { balance: result.newBalance.toString(), amount, reason },
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
