import { describe, expect, it, vi } from 'vitest';
import type { ChannelEconomy } from '@pavisie/database';
import { buildFakeChannelPrisma } from '../../channel-economy/__tests__/fake-channel-prisma';
import { CHANNEL_ECONOMY_DEFAULTS } from '../../channel-economy/settings';
import { CommandCooldowns } from '../twitch-chat/engine';
import { handleEconomyChatCommand, type EconomyCommandInput } from '../twitch-chat/economy-commands';
import { createEconomyChatPort } from '../twitch-chat/economy-port';

// The port binds ONE channel's `ChannelEconomy` settings to the channel-economy ledger. These tests run the real
// ledger (over an in-memory fake) end to end through the pure chat handler, so the wiring — settings -> ledger ->
// reply — is exercised without mocks.

function economyRow(overrides: Partial<ChannelEconomy> = {}): ChannelEconomy {
  return {
    id: 'economy-1',
    platform: 'TWITCH',
    channelUserId: 'b-1',
    ...CHANNEL_ECONOMY_DEFAULTS,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ChannelEconomy;
}

interface RunOptions {
  economy: ChannelEconomy;
  prisma: ReturnType<typeof buildFakeChannelPrisma>['prisma'];
  chatter?: string;
  helixUser?: { id: string; login: string; displayName: string } | null;
}

function run(text: string, opts: RunOptions) {
  const input: EconomyCommandInput = {
    event: { chatterUserId: opts.chatter ?? 'viewer-1', chatterDisplayName: 'ViewerOne', messageText: text },
    commandPrefix: '!',
    channelId: 'channel-a',
    customCommandNames: new Set(),
    loadEconomy: async () => createEconomyChatPort(opts.prisma, opts.economy, 'bot-1'),
    botTwitchUserId: 'bot-1',
    helix: { getUserByLogin: vi.fn(async () => ({ ok: true as const, value: opts.helixUser ?? null })) },
    cooldowns: new CommandCooldowns(),
  };
  return handleEconomyChatCommand(input);
}

describe('createEconomyChatPort (real ledger, in-memory store)', () => {
  it('!daily pays inside the channel economy and creates the viewer wallet with their display name', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma();
    const economy = economyRow({ dailyMinAmount: 40, dailyMaxAmount: 40, streakBonusPerDay: 0, currencySymbol: '💎' });

    const result = await run('!daily', { economy, prisma });

    expect(result).toEqual({ handled: true, reply: '@ViewerOne, you claimed 40 💎! Streak: 1 day(s).' });
    expect(getWallet('economy-1', 'viewer-1')).toMatchObject({ balance: 40n, displayName: 'ViewerOne' });
    expect(getTransactions()).toHaveLength(1);
    expect(getTransactions()[0]).toMatchObject({ economyId: 'economy-1', type: 'daily' });
  });

  it('a second !daily reports the cooldown and does not pay again', async () => {
    const { prisma, getWallet } = buildFakeChannelPrisma();
    const economy = economyRow({ dailyMinAmount: 40, dailyMaxAmount: 40, streakBonusPerDay: 0 });
    await run('!daily', { economy, prisma });

    const again = await run('!daily', { economy, prisma });

    expect((again as { reply: string }).reply).toMatch(/already claimed today/);
    expect(getWallet('economy-1', 'viewer-1')?.balance).toBe(40n);
  });

  it("!give moves balance between two viewers of this channel, bounded by the channel's own give limits", async () => {
    const { prisma, getWallet } = buildFakeChannelPrisma([{ economyId: 'economy-1', viewerUserId: 'viewer-1', balance: 100n }]);
    const economy = economyRow({ giveMinAmount: 5, giveMaxAmount: 50 });
    const target = { id: 'target-1', login: 'someone', displayName: 'Someone' };

    const ok = await run('!give someone 30', { economy, prisma, helixUser: target });
    expect(ok).toEqual({ handled: true, reply: '@ViewerOne, gave 30 ♦️ to Someone.' });
    expect(getWallet('economy-1', 'viewer-1')?.balance).toBe(70n);
    expect(getWallet('economy-1', 'target-1')).toMatchObject({ balance: 30n, displayName: 'Someone' });

    const tooBig = await run('!give someone 60', { economy, prisma, helixUser: target });
    expect((tooBig as { reply: string }).reply).toBe('@ViewerOne, that amount is too large.');
    const tooSmall = await run('!give someone 4', { economy, prisma, helixUser: target });
    expect((tooSmall as { reply: string }).reply).toBe('@ViewerOne, that amount is too small.');
    expect(getWallet('economy-1', 'viewer-1')?.balance).toBe(70n);
  });

  it('a rejected !give leaves no wallet behind for the (never-seen) recipient', async () => {
    const { prisma, getWallet } = buildFakeChannelPrisma([{ economyId: 'economy-1', viewerUserId: 'viewer-1', balance: 1n }]);
    const result = await run('!give someone 50', {
      economy: economyRow(),
      prisma,
      helixUser: { id: 'stranger-1', login: 'someone', displayName: 'Stranger' },
    });
    expect((result as { reply: string }).reply).toBe("@ViewerOne, you don't have enough for that.");
    expect(getWallet('economy-1', 'stranger-1')).toBeUndefined();
  });

  it('!give to the bot account and to yourself is refused', async () => {
    const { prisma } = buildFakeChannelPrisma([{ economyId: 'economy-1', viewerUserId: 'viewer-1', balance: 100n }]);
    const toBot = await run('!give pavisiebot 5', {
      economy: economyRow(),
      prisma,
      helixUser: { id: 'bot-1', login: 'pavisiebot', displayName: 'PavisieBot' },
    });
    expect((toBot as { reply: string }).reply).toBe("@ViewerOne, you can't give to the bot.");
    const toSelf = await run('!give viewerone 5', {
      economy: economyRow(),
      prisma,
      helixUser: { id: 'viewer-1', login: 'viewerone', displayName: 'ViewerOne' },
    });
    expect((toSelf as { reply: string }).reply).toBe("@ViewerOne, you can't give to yourself.");
  });

  it('!top ranks by lifetime earned in THIS channel only, falling back to a placeholder for a nameless wallet', async () => {
    const { prisma, seedTransaction, getWallet } = buildFakeChannelPrisma([
      { economyId: 'economy-1', viewerUserId: 'a', displayName: 'Alice' },
      { economyId: 'economy-1', viewerUserId: 'b' },
      { economyId: 'economy-2', viewerUserId: 'x', displayName: 'Elsewhere' },
    ]);
    seedTransaction({ economyId: 'economy-1', walletId: getWallet('economy-1', 'a')!.id, amount: 200n, type: 'twitch_chat_earn' });
    seedTransaction({ economyId: 'economy-1', walletId: getWallet('economy-1', 'b')!.id, amount: 100n, type: 'daily' });
    seedTransaction({ economyId: 'economy-2', walletId: getWallet('economy-2', 'x')!.id, amount: 9999n, type: 'daily' });

    const result = await run('!top', { economy: economyRow(), prisma });

    expect(result).toEqual({ handled: true, reply: 'Top Twitch earners: 1. Alice (200 ♦️), 2. Twitch viewer (100 ♦️)' });
  });

  it('!balance reports the balance without creating a second wallet for the same viewer', async () => {
    const { prisma, allWallets } = buildFakeChannelPrisma([{ economyId: 'economy-1', viewerUserId: 'viewer-1', balance: 12n }]);
    const result = await run('!balance', { economy: economyRow(), prisma });
    expect(result).toEqual({ handled: true, reply: '@ViewerOne, you have 12 ♦️' });
    expect(allWallets()).toHaveLength(1);
  });
});
