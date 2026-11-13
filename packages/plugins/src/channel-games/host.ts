// The table host: runs a channel's table game in real time. It is the only part of channel-games that touches
// Redis, the ledger, the clock and chat. The rules live in pure modules (`blackjack/*`); this file decides when
// they run and makes sure the currency and the table can never disagree.
//
// Three guarantees, each of which survives a bot restart at any moment:
//   1. The table lives in Redis, not in memory. Every step saves before it moves on, so a restart mid-hand
//      resumes the same table with the same cards and the same turn (`resume`).
//   2. A viewer's currency and their seat change together. Before taking or returning currency the host writes
//      down what it is about to do (`table.pending`, with a note unique to that movement). After a crash it asks
//      the ledger whether that note exists and finishes or abandons the step accordingly (`resolvePending`).
//   3. A hand is settled exactly once. The table's id is the id of the `ChannelGameHand` row, and the ledger
//      settles a given id only once, so settling again after an interruption is always safe.
//
// One step at a time per channel: every command and every timer for a channel runs through `exclusive`, so two
// players acting in the same instant are applied one after the other.
//
// Privacy: nothing here ever receives chat text. Commands arrive as parsed intents (a kind and, at most, a
// number). Log lines carry ids and error messages only.
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';
import type { Prisma, PrismaClient } from '@pavisie/database';
import {
  creditChannel,
  debitChannel,
  findChannelTransactionByNote,
  settleChannelGameHand,
  type GameHandPayout,
} from '../channel-economy/ledger';
import type { BlackjackIntent } from './blackjack/commands';
import { handValue } from './blackjack/hand';
import * as say from './blackjack/messages';
import { createShoe, needsReshuffle, type Shoe } from './blackjack/shoe';
import {
  MAX_SEATS,
  addSeat,
  applyAction,
  checkAction,
  checkJoin,
  createLobby,
  dealHand,
  findSeatIndex,
  playDealer,
  removeSeat,
  safeDisplayName,
  stakesInPlay,
  tableResults,
  timeOutTurn,
  type BlackjackTable,
  type PendingMove,
  type PlayerAction,
} from './blackjack/table';
import type { CoalescingOutbound } from './outbound';
import { randomSeed } from './rng';

export interface GameHostTimings {
  /** How long a lobby stays open for bets. */
  lobbyMs: number;
  /** How long a player has to act before their hand stands by itself. */
  turnMs: number;
  /** How often the timer loop looks for a lobby to close or a turn to time out. */
  tickMs: number;
  /** After a restart, a turn or lobby gets at least this long, so nobody times out because the bot was down. */
  resumeGraceMs: number;
  /** How soon a settle that failed is tried again. */
  settleRetryMs: number;
}

export const DEFAULT_GAME_TIMINGS: GameHostTimings = {
  lobbyMs: 40_000,
  turnMs: 25_000,
  tickMs: 500,
  resumeGraceMs: 15_000,
  settleRetryMs: 5_000,
};

interface HostLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface GameHostDeps {
  prisma: PrismaClient;
  redis: Redis;
  logger: HostLogger;
  outbound: CoalescingOutbound;
  timings?: Partial<GameHostTimings>;
  now?: () => number;
  /** Seed for a new shoe. Injectable so tests can deal known cards. */
  newSeed?: () => number;
  newId?: () => string;
}

export interface GameChannel {
  broadcasterUserId: string;
  commandPrefix: string;
}

/** The parts of a channel's currency a NEW table needs. Null is passed when blackjack has been switched off but
 * a table is still running: that table finishes on the settings it was opened with, and no new one can open. */
export interface GameEconomy {
  id: string;
  currencySymbol: string;
  blackjackMinBet: number;
  blackjackMaxBet: number;
}

export interface GameChatter {
  userId: string;
  displayName: string;
  /** The streamer or one of their moderators. */
  isModerator: boolean;
}

const TABLE_TTL_SECONDS = 6 * 60 * 60;
const SHOE_TTL_SECONDS = 12 * 60 * 60;

function tableKey(broadcasterUserId: string): string {
  return redisKey('games', 'table', broadcasterUserId);
}

function shoeKey(broadcasterUserId: string): string {
  return redisKey('games', 'shoe', 'blackjack', broadcasterUserId);
}

const TABLE_KEY_PATTERN = redisKey('games', 'table', '*');

interface ActiveTable {
  deadlineAt: number;
  lobbyOpen: boolean;
  seated: ReadonlySet<string>;
}

function summarize(table: BlackjackTable): ActiveTable {
  return {
    deadlineAt: table.deadlineAt,
    lobbyOpen: table.phase === 'lobby',
    seated: new Set(table.seats.map((seat) => seat.viewerUserId)),
  };
}

interface Loaded {
  table: BlackjackTable | null;
  shoe: Shoe | null;
}

export class ChannelGameHost {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private readonly logger: HostLogger;
  private readonly outbound: CoalescingOutbound;
  private readonly timings: GameHostTimings;
  private readonly now: () => number;
  private readonly newSeed: () => number;
  private readonly newId: () => string;

  /** Channels with a table: when each next needs the timer loop, plus just enough to answer `aliasApplies`
   * without touching Redis. The table itself is always read from Redis before anything is decided. */
  private readonly active = new Map<string, ActiveTable>();
  private readonly chains = new Map<string, Promise<void>>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(deps: GameHostDeps) {
    this.prisma = deps.prisma;
    this.redis = deps.redis;
    this.logger = deps.logger;
    this.outbound = deps.outbound;
    this.timings = { ...DEFAULT_GAME_TIMINGS, ...deps.timings };
    this.now = deps.now ?? Date.now;
    this.newSeed = deps.newSeed ?? randomSeed;
    this.newId = deps.newId ?? randomUUID;
  }

  // -------------------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------------------

  /** Starts the timer loop. The one-minute job tick is far too coarse for a 25-second turn, so this is its own. */
  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      void this.tick();
    }, this.timings.tickMs);
    this.ticker.unref?.();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /**
   * Picks up every table that was open when the bot last stopped. Called once at startup. Each table carries on
   * from exactly where it was; the players are told, and whoever's turn it is gets a fresh prompt.
   */
  async resume(): Promise<number> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', TABLE_KEY_PATTERN, 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');

    let resumed = 0;
    for (const key of keys) {
      const broadcasterUserId = key.slice(TABLE_KEY_PATTERN.length - 1);
      await this.exclusive(broadcasterUserId, async () => {
        const { table, shoe } = await this.load(broadcasterUserId);
        if (!table) return;
        resumed += 1;
        const earliest = this.now() + this.timings.resumeGraceMs;
        if (table.phase !== 'settling' && table.deadlineAt < earliest) table.deadlineAt = earliest;
        await this.save(table, shoe);
        this.outbound.enqueue(broadcasterUserId, say.resumed(), { keep: true });
        if (table.phase === 'lobby') {
          this.outbound.enqueue(broadcasterUserId, say.lobbySeats(table), { key: 'lobby' });
        } else if (table.phase === 'playing') {
          this.outbound.enqueue(broadcasterUserId, say.dealt(table), { key: 'state', keep: true });
          this.promptTurn(table);
        } else {
          await this.settle(table, shoe);
        }
      });
    }
    return resumed;
  }

  /** True while this channel has a table (lobby or hand). */
  hasActiveTable(broadcasterUserId: string): boolean {
    return this.active.has(broadcasterUserId);
  }

  /**
   * Whether a short alias (`!hit`, `!join`, ...) from this viewer belongs to the table: only while a lobby is open
   * or the viewer holds a seat. Otherwise the message is none of the table's business and must fall through to
   * the channel's own commands. Synchronous and in memory, because it is asked for every alias-shaped chat
   * message in every channel and must cost nothing where nobody is playing.
   */
  aliasApplies(broadcasterUserId: string, viewerUserId: string): boolean {
    const table = this.active.get(broadcasterUserId);
    return Boolean(table) && (table!.lobbyOpen || table!.seated.has(viewerUserId));
  }

  /** Resolves once every queued step for the channel has run. For tests and orderly shutdown. */
  async settled(broadcasterUserId: string): Promise<void> {
    await (this.chains.get(broadcasterUserId) ?? Promise.resolve());
  }

  // -------------------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------------------

  /** Runs one parsed blackjack command. Never throws: a failure is logged and the viewer is told to try again. */
  async handleBlackjack(
    channel: GameChannel,
    economy: GameEconomy | null,
    chatter: GameChatter,
    intent: BlackjackIntent,
  ): Promise<void> {
    const who: GameChatter = { ...chatter, displayName: safeDisplayName(chatter.displayName) };
    await this.exclusive(channel.broadcasterUserId, async () => {
      try {
        await this.run(channel, economy, who, intent);
      } catch (err) {
        this.logger.error(
          { broadcasterUserId: channel.broadcasterUserId, kind: intent.kind, err: errorText(err) },
          'channel-games: blackjack command failed',
        );
        this.notify(channel.broadcasterUserId, 'busy', who, null, channel.commandPrefix);
      }
    });
  }

  private async run(
    channel: GameChannel,
    economy: GameEconomy | null,
    who: GameChatter,
    intent: BlackjackIntent,
  ): Promise<void> {
    const id = channel.broadcasterUserId;
    const prefix = channel.commandPrefix;
    const { table, shoe } = await this.load(id);

    switch (intent.kind) {
      case 'help':
        this.outbound.enqueue(id, say.help(prefix), { key: 'help' });
        return;

      case 'start': {
        if (!who.isModerator) return this.notify(id, 'mods_only', who, table, prefix);
        if (table) return this.notify(id, 'table_exists', who, table, prefix);
        // No currency settings means blackjack was switched off while a table was closing: nothing to open.
        if (!economy) return;
        const opened = createLobby({
          tableId: this.newId(),
          economyId: economy.id,
          broadcasterUserId: id,
          currencySymbol: economy.currencySymbol,
          commandPrefix: prefix,
          minBet: economy.blackjackMinBet,
          maxBet: economy.blackjackMaxBet,
          now: this.now(),
          lobbyMs: this.timings.lobbyMs,
        });
        await this.save(opened, shoe);
        this.outbound.enqueue(id, say.lobbyOpened(opened, prefix, Math.round(this.timings.lobbyMs / 1000)), {
          keep: true,
        });
        return;
      }

      case 'stop': {
        if (!who.isModerator) return this.notify(id, 'mods_only', who, table, prefix);
        if (!table) return this.notify(id, 'no_table', who, null, prefix);
        if (table.phase === 'settling') return;
        table.phase = 'settling';
        table.closing = 'cancelled';
        await this.save(table, shoe);
        await this.settle(table, shoe);
        return;
      }

      case 'deal': {
        if (!who.isModerator) return this.notify(id, 'mods_only', who, table, prefix);
        if (!table) return this.notify(id, 'no_table', who, null, prefix);
        if (table.phase !== 'lobby') return this.notify(id, 'not_lobby', who, table, prefix);
        await this.closeLobby(table, shoe);
        return;
      }

      case 'status': {
        if (!table) return this.notify(id, 'no_table', who, null, prefix);
        if (table.phase === 'lobby') this.outbound.enqueue(id, say.lobbySeats(table), { key: 'lobby' });
        else if (table.phase === 'playing') {
          this.outbound.enqueue(id, say.dealt(table), { key: 'state' });
          this.promptTurn(table);
        }
        return;
      }

      case 'join': {
        if (!table) return this.notify(id, 'no_table', who, null, prefix);
        const problem = checkJoin(table, who.userId, intent.amount);
        if (problem) return this.notify(id, problem, who, table, prefix);
        const bet = intent.amount as number;
        const paid = await this.debit(table, shoe, who.userId, bet, {
          type: 'seat',
          displayName: who.displayName,
        });
        if (!paid) return this.notify(id, 'insufficient', who, table, prefix);
        this.outbound.enqueue(id, say.lobbySeats(table), { key: 'lobby' });
        if (table.seats.length >= MAX_SEATS) await this.closeLobby(table, shoe);
        return;
      }

      case 'leave': {
        if (!table) return this.notify(id, 'no_table', who, null, prefix);
        if (findSeatIndex(table, who.userId) === -1) return this.notify(id, 'not_seated', who, table, prefix);
        const seat = removeSeat(table, who.userId);
        if (!seat) return this.notify(id, 'cannot_leave', who, table, prefix);
        await this.credit(table, shoe, seat.viewerUserId, seat.bet);
        this.outbound.enqueue(id, say.lobbySeats(table), { key: 'lobby' });
        return;
      }

      case 'hit':
      case 'stand':
      case 'double':
      case 'split': {
        if (!table) return this.notify(id, 'no_table', who, null, prefix);
        if (!shoe) throw new Error('table is in play without a shoe');
        const action: PlayerAction = intent.kind;
        const check = checkAction(table, who.userId, action);
        if (check.problem === 'not_playing') return this.notify(id, 'not_seated', who, table, prefix);
        if (check.problem) return this.notify(id, check.problem, who, table, prefix);
        const seatIndex = (table.turn as { seat: number }).seat;
        if (check.cost > 0) {
          const paid = await this.debit(table, shoe, who.userId, check.cost, {
            type: action as 'double' | 'split',
          });
          if (!paid) return this.notify(id, 'insufficient', who, table, prefix);
        } else {
          applyAction(table, shoe, action);
        }
        await this.afterAction(table, shoe, seatIndex);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Table flow
  // -------------------------------------------------------------------------------------------------------

  /** The lobby is over (time ran out, a mod dealt, or the table filled): deal, or close an empty table. */
  private async closeLobby(table: BlackjackTable, previousShoe: Shoe | null): Promise<void> {
    const id = table.broadcasterUserId;
    if (table.seats.length === 0) {
      await this.remove(id);
      this.outbound.enqueue(id, say.lobbyClosedEmpty(), { keep: true });
      return;
    }
    // Carry the shoe over from the last hand unless the cut card came out.
    const shoe = previousShoe && !needsReshuffle(previousShoe) ? previousShoe : createShoe(this.newSeed());
    dealHand(table, shoe);
    this.outbound.enqueue(id, say.dealt(table), { key: 'state', keep: true });
    if (table.turn) {
      table.deadlineAt = this.now() + this.timings.turnMs;
      await this.save(table, shoe);
      this.promptTurn(table);
    } else {
      // Nobody has a decision to make (naturals all round, or the dealer has blackjack).
      await this.finishHand(table, shoe);
    }
  }

  /** A player has acted (or timed out): show their cards, then prompt the next player or finish the hand. */
  private async afterAction(table: BlackjackTable, shoe: Shoe, seatIndex: number): Promise<void> {
    const id = table.broadcasterUserId;
    const seat = table.seats[seatIndex];
    if (seat) this.outbound.enqueue(id, say.seatUpdate(seat), { key: `seat:${seatIndex}` });
    if (table.turn) {
      table.deadlineAt = this.now() + this.timings.turnMs;
      await this.save(table, shoe);
      this.promptTurn(table);
    } else {
      await this.finishHand(table, shoe);
    }
  }

  private promptTurn(table: BlackjackTable): void {
    const prompt = say.turnPrompt(table, table.commandPrefix, Math.round(this.timings.turnMs / 1000));
    // Keyed: if the turn moves on before this is sent, only the current player's prompt goes out.
    if (prompt) this.outbound.enqueue(table.broadcasterUserId, prompt, { key: 'turn', keep: true });
  }

  private async finishHand(table: BlackjackTable, shoe: Shoe): Promise<void> {
    playDealer(table, shoe);
    table.phase = 'settling';
    table.closing = 'played';
    // Saved BEFORE paying: from here a restart finds a table that only needs settling, never one to replay.
    await this.save(table, shoe);
    await this.settle(table, shoe);
  }

  /**
   * Pays the table out (or refunds it, for a cancellation) and closes it. Safe to call again for the same table:
   * the ledger settles a hand id once. If the ledger cannot be reached the table stays in "settling" and the
   * timer loop tries again, so a result is delayed rather than lost.
   */
  private async settle(table: BlackjackTable, shoe: Shoe | null): Promise<void> {
    const id = table.broadcasterUserId;
    const cancelled = table.closing === 'cancelled';
    const results = cancelled ? [] : tableResults(table);

    const payouts: GameHandPayout[] = [];
    if (cancelled) {
      for (const stake of stakesInPlay(table)) {
        payouts.push({ viewerUserId: stake.viewerUserId, amount: stake.amount, type: 'blackjack_push' });
      }
    } else {
      for (const seat of results) {
        // A pushed hand returns the bet; anything won is a payout. Kept as separate rows so the ledger shows which.
        const pushed = seat.hands.filter((h) => h.outcome === 'push').reduce((sum, h) => sum + h.payout, 0);
        const won = seat.payout - pushed;
        if (won > 0) payouts.push({ viewerUserId: seat.viewerUserId, amount: won, type: 'blackjack_payout' });
        if (pushed > 0)
          payouts.push({ viewerUserId: seat.viewerUserId, amount: pushed, type: 'blackjack_push' });
      }
    }

    const result = cancelled
      ? {
          cancelled: true,
          seats: stakesInPlay(table).map((s) => ({
            viewerUserId: s.viewerUserId,
            displayName: s.displayName,
            refunded: s.amount,
          })),
        }
      : {
          cancelled: false,
          dealer: { cards: table.dealer, total: handValue(table.dealer).total },
          seats: results,
        };

    try {
      await settleChannelGameHand(this.prisma, {
        handId: table.tableId,
        economyId: table.economyId,
        game: 'BLACKJACK',
        seed: table.dealtFrom ? `${table.dealtFrom.seed}:${table.dealtFrom.offset}` : 'not-dealt',
        startedAt: new Date(table.createdAt),
        endedAt: new Date(this.now()),
        // Round-tripped through JSON so it is stored as plain data, exactly as it will be read back.
        result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
        payouts,
      });
    } catch (err) {
      this.logger.error(
        { broadcasterUserId: id, tableId: table.tableId, err: errorText(err) },
        'channel-games: settling a blackjack table failed; it will be retried',
      );
      table.deadlineAt = this.now() + this.timings.settleRetryMs;
      await this.save(table, shoe).catch(() => undefined);
      this.active.set(id, summarize(table));
      return;
    }

    await this.remove(id);
    // The result is the one line a table must never lose.
    this.outbound.enqueue(id, cancelled ? say.cancelled() : say.results(table, results), { keep: true });
  }

  // -------------------------------------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------------------------------------

  /** One pass of the timer loop: every table whose lobby or turn has run out gets its deadline handled. */
  async tick(): Promise<void> {
    const now = this.now();
    const due = [...this.active.entries()].filter(([, t]) => t.deadlineAt <= now).map(([id]) => id);
    await Promise.all(
      due.map((id) =>
        this.exclusive(id, async () => {
          try {
            await this.onDeadline(id);
          } catch (err) {
            this.logger.error(
              { broadcasterUserId: id, err: errorText(err) },
              'channel-games: blackjack timer step failed',
            );
          }
        }),
      ),
    );
  }

  private async onDeadline(broadcasterUserId: string): Promise<void> {
    const { table, shoe } = await this.load(broadcasterUserId);
    if (!table) return;
    // A command may have moved the table on while this step waited its turn.
    if (table.deadlineAt > this.now()) return;

    if (table.phase === 'lobby') {
      await this.closeLobby(table, shoe);
    } else if (table.phase === 'playing') {
      if (!shoe) throw new Error('table is in play without a shoe');
      const seatIndex = table.turn?.seat ?? -1;
      const seat = table.seats[seatIndex];
      timeOutTurn(table);
      if (seat) this.outbound.enqueue(broadcasterUserId, say.timedOut(seat), { key: `timeout:${seatIndex}` });
      if (table.turn) {
        table.deadlineAt = this.now() + this.timings.turnMs;
        await this.save(table, shoe);
        this.promptTurn(table);
      } else {
        await this.finishHand(table, shoe);
      }
    } else {
      await this.settle(table, shoe);
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Currency: write the intention down, move the currency, then change the table
  // -------------------------------------------------------------------------------------------------------

  /** Takes `amount` from a viewer and, only if that succeeded, applies `then` to the table. False = not enough. */
  private async debit(
    table: BlackjackTable,
    shoe: Shoe | null,
    viewerUserId: string,
    amount: number,
    then: PendingMove['then'],
  ): Promise<boolean> {
    table.moveSeq += 1;
    const move: PendingMove = {
      kind: 'debit',
      viewerUserId,
      amount,
      note: `bj:${table.tableId}:${table.moveSeq}`,
      then,
    };
    table.pending = move;
    await this.save(table, shoe);

    const displayName = then.type === 'seat' ? then.displayName : undefined;
    const result = await debitChannel(
      this.prisma,
      { economyId: table.economyId, viewerUserId },
      amount,
      'blackjack_bet',
      { note: move.note, displayName },
    );
    if (result.ok) this.applyMove(table, shoe, move);
    table.pending = null;
    await this.save(table, shoe);
    return result.ok;
  }

  /** Returns `amount` to a viewer (leaving the lobby). The table has already been changed by the caller. */
  private async credit(
    table: BlackjackTable,
    shoe: Shoe | null,
    viewerUserId: string,
    amount: number,
  ): Promise<void> {
    table.moveSeq += 1;
    const move: PendingMove = {
      kind: 'credit',
      viewerUserId,
      amount,
      note: `bj:${table.tableId}:${table.moveSeq}`,
      then: { type: 'none' },
    };
    table.pending = move;
    await this.save(table, shoe);
    await creditChannel(this.prisma, { economyId: table.economyId, viewerUserId }, amount, 'blackjack_push', {
      note: move.note,
    });
    table.pending = null;
    await this.save(table, shoe);
  }

  private applyMove(table: BlackjackTable, shoe: Shoe | null, move: PendingMove): void {
    if (move.then.type === 'seat') {
      addSeat(table, {
        viewerUserId: move.viewerUserId,
        displayName: move.then.displayName,
        bet: move.amount,
      });
    } else if ((move.then.type === 'double' || move.then.type === 'split') && shoe) {
      applyAction(table, shoe, move.then.type);
    }
  }

  /**
   * Finishes a currency step that was interrupted. The ledger row's note says whether the currency moved: a debit
   * that happened gets its seat or its card; one that did not is forgotten; a refund that did not happen is paid.
   */
  private async resolvePending(table: BlackjackTable, shoe: Shoe | null): Promise<void> {
    const move = table.pending;
    if (!move) return;
    const happened = await findChannelTransactionByNote(this.prisma, table.economyId, move.note);
    if (move.kind === 'debit') {
      if (happened) {
        this.applyMove(table, shoe, move);
        // An interrupted double or split may have moved the turn on: the next player gets a full turn.
        if (move.then.type !== 'seat' && table.turn) table.deadlineAt = this.now() + this.timings.turnMs;
      }
    } else if (!happened) {
      await creditChannel(
        this.prisma,
        { economyId: table.economyId, viewerUserId: move.viewerUserId },
        move.amount,
        'blackjack_push',
        {
          note: move.note,
        },
      );
    }
    table.pending = null;
    await this.save(table, shoe);
    // An interrupted double or split on the last hand leaves nobody to act: the hand has to be finished.
    if (table.phase === 'playing' && !table.turn && shoe) await this.finishHand(table, shoe);
  }

  // -------------------------------------------------------------------------------------------------------
  // Redis
  // -------------------------------------------------------------------------------------------------------

  private async load(broadcasterUserId: string): Promise<Loaded> {
    const [rawTable, rawShoe] = await this.redis.mget(
      tableKey(broadcasterUserId),
      shoeKey(broadcasterUserId),
    );
    const shoe = rawShoe ? (JSON.parse(rawShoe) as Shoe) : null;
    let table = rawTable ? (JSON.parse(rawTable) as BlackjackTable) : null;
    if (!table) {
      this.active.delete(broadcasterUserId);
      return { table: null, shoe };
    }
    if (table.pending) {
      await this.resolvePending(table, shoe);
      // Resolving may have finished and closed the table.
      const again = await this.redis.get(tableKey(broadcasterUserId));
      table = again ? (JSON.parse(again) as BlackjackTable) : null;
      if (!table) return { table: null, shoe };
    }
    this.active.set(broadcasterUserId, summarize(table));
    return { table, shoe };
  }

  /** Saves the table and its shoe together, so the cards on the table and the cards left to deal always agree. */
  private async save(table: BlackjackTable, shoe: Shoe | null): Promise<void> {
    const multi = this.redis
      .multi()
      .set(tableKey(table.broadcasterUserId), JSON.stringify(table), 'EX', TABLE_TTL_SECONDS);
    if (shoe) multi.set(shoeKey(table.broadcasterUserId), JSON.stringify(shoe), 'EX', SHOE_TTL_SECONDS);
    const results = await multi.exec();
    if (!results) throw new Error('channel-games: saving the table was discarded by Redis');
    for (const [error] of results) {
      if (error) throw error;
    }
    this.active.set(table.broadcasterUserId, summarize(table));
  }

  /** Closes the table. The shoe is kept: the next table in this channel deals from the same one. */
  private async remove(broadcasterUserId: string): Promise<void> {
    await this.redis.del(tableKey(broadcasterUserId));
    this.active.delete(broadcasterUserId);
  }

  // -------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------

  private notify(
    broadcasterUserId: string,
    kind: say.NoticeKind,
    who: GameChatter,
    table: BlackjackTable | null,
    prefix: string,
  ): void {
    // Keyed per viewer: someone spamming a bad command gets one reply, not a queue of them.
    this.outbound.enqueue(broadcasterUserId, say.notice(kind, who.displayName, table, prefix), {
      key: `notice:${who.userId}`,
    });
  }

  /** Runs `step` after every earlier step for the same channel has finished. */
  private exclusive(broadcasterUserId: string, step: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(broadcasterUserId) ?? Promise.resolve();
    const next = previous.then(step, step);
    this.chains.set(broadcasterUserId, next);
    void next.finally(() => {
      if (this.chains.get(broadcasterUserId) === next) this.chains.delete(broadcasterUserId);
    });
    return next;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
