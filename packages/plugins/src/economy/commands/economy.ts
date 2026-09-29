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
  type WalletKey,
  getOrCreateWallet,
  getPlatformLeaderboard,
  claimDaily,
  give as ledgerGive,
  adminAdjust as ledgerAdminAdjust,
} from '../ledger';
import { getChannelBalanceLeaderboard, getChannelEarnedLeaderboard } from '../../channel-economy/ledger';

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
      )
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

/** A Twitch row of a leaderboard: one viewer in one linked channel's own currency. */
interface TwitchBoardRow {
  displayName: string | null;
  symbol: string;
  amount: bigint;
}

/**
 * The enabled Twitch-channel currencies of the channels linked to this server. A streamer's Twitch currency is
 * owned by the Twitch channel (`ChannelEconomy`, ARCHITECTURE.md §18b/§19e), not by the server: the server only
 * ever READS the currencies of channels it has linked, and only ones the streamer has switched on.
 */
async function loadLinkedTwitchEconomies(c: CommandContext) {
  const channels = await c.ctx.prisma.twitchChatChannel.findMany({
    where: { guildId: c.guildId },
    select: { broadcasterUserId: true },
  });
  if (channels.length === 0) return [];
  return c.ctx.prisma.channelEconomy.findMany({
    where: { platform: 'TWITCH', enabled: true, channelUserId: { in: channels.map((ch) => ch.broadcasterUserId) } },
  });
}

/** Top viewers across the linked channels, ranked together by `amount` (each row keeps its own channel's symbol). */
function rankTwitchRows(rows: TwitchBoardRow[], limit: number): TwitchBoardRow[] {
  return [...rows].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0)).slice(0, limit);
}

function twitchLine(row: TwitchBoardRow, index: number): string {
  return `**${index + 1}.** ${escapeMarkdown(row.displayName || 'Twitch viewer')} (Twitch) — ${formatCurrency(row.amount, row.symbol)}`;
}

async function handleLeaderboard(c: CommandContext): Promise<void> {
  const config = await c.config<EconomyConfig>();
  const platformOption = (c.interaction.options.getString('platform') ?? 'global') as 'global' | 'discord' | 'twitch';

  if (platformOption === 'global') {
    // Global leaderboard: top 10 by current balance — this server's Discord wallets plus the wallets of the Twitch
    // channels linked to it (each in its own currency; wallets are never merged across platforms).
    const [discordRows, economies] = await Promise.all([
      c.ctx.prisma.economyAccount.findMany({
        where: { guildId: c.guildId, platform: 'DISCORD' },
        orderBy: { balance: 'desc' },
        take: 10,
      }),
      loadLinkedTwitchEconomies(c),
    ]);
    const twitchRows: TwitchBoardRow[] = [];
    for (const economy of economies) {
      const top = await getChannelBalanceLeaderboard(c.ctx.prisma, economy.id, 10);
      for (const row of top) {
        twitchRows.push({ displayName: row.displayName, symbol: economy.currencySymbol, amount: row.balance });
      }
    }

    const combined: Array<{ amount: bigint; render: () => string }> = [
      ...discordRows.map((row) => ({
        amount: row.balance,
        render: () => `<@${row.userId}> — ${formatCurrency(row.balance, config.currencySymbol)}`,
      })),
      ...twitchRows.map((row) => ({
        amount: row.amount,
        render: () =>
          `${escapeMarkdown(row.displayName || 'Twitch viewer')} (Twitch) — ${formatCurrency(row.amount, row.symbol)}`,
      })),
    ];
    const lines = combined
      .sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0))
      .slice(0, 10)
      .map((row, i) => `**${i + 1}.** ${row.render()}`);

    await c.interaction.reply({
      embeds: [listEmbed(c.t('leaderboardTitle'), lines)],
      ephemeral: true,
    });
    return;
  }

  if (platformOption === 'twitch') {
    // Twitch board: lifetime earned in the linked channels' own currencies. Honest empty state when no channel is
    // linked (or none has switched its currency on) — never an empty-looking board that hides the reason.
    const economies = await loadLinkedTwitchEconomies(c);
    if (economies.length === 0) {
      await c.interaction.reply({
        embeds: [infoEmbed(c.t('leaderboardTwitchTitle'), c.t('leaderboardTwitchNone'))],
        ephemeral: true,
      });
      return;
    }
    const rows: TwitchBoardRow[] = [];
    for (const economy of economies) {
      const top = await getChannelEarnedLeaderboard(c.ctx.prisma, economy.id, 10);
      for (const row of top) {
        rows.push({ displayName: row.displayName, symbol: economy.currencySymbol, amount: row.earned });
      }
    }
    const lines = rankTwitchRows(rows, 10).map(twitchLine);
    await c.interaction.reply({
      embeds: [listEmbed(c.t('leaderboardTwitchTitle'), lines)],
      ephemeral: true,
    });
    return;
  }

  // Discord board: top 10 by lifetime earned (sum of earned transaction types).
  const rows = await getPlatformLeaderboard(c.ctx.prisma, c.guildId, 'DISCORD', 10);
  const lines = rows.map(
    (row, i) => `**${i + 1}.** <@${row.userId}> — ${formatCurrency(row.earned, config.currencySymbol)}`,
  );
  await c.interaction.reply({
    embeds: [listEmbed(c.t('leaderboardDiscordTitle', { platform: platformOption }), lines)],
    ephemeral: true,
  });
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
