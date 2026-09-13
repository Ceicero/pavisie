import type { EmbedBuilder } from 'discord.js';
import { EMBED_LIMITS } from '@pavisie/core';

export interface LogBatcherOptions {
  /** Flush a channel's queued embeds after this many ms of inactivity since its first unflushed embed. Default 2000 (ARCHITECTURE.md's logging task: "flush every 2s or 5 embeds"). */
  flushIntervalMs?: number;
  /** Flush immediately once a channel's queue reaches this many embeds. Default 5. */
  maxBatchSize?: number;
  send: (channelId: string, embeds: EmbedBuilder[]) => Promise<void>;
  onError?: (channelId: string, err: unknown) => void;
}

interface ChannelBatch {
  embeds: EmbedBuilder[];
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BATCH_SIZE = 5;

/**
 * Calculates the total character count of an embed as Discord counts it for the 6000-character per-message limit.
 * Per Discord's API docs, this includes title, description, field names, field values, footer text, and author name.
 */
function embedCharacterSize(embed: EmbedBuilder): number {
  const data = embed.toJSON();
  let size = (data.title?.length ?? 0) + (data.description?.length ?? 0);
  size += data.footer?.text.length ?? 0;
  size += data.author?.name.length ?? 0;
  for (const field of data.fields ?? []) {
    size += field.name.length + field.value.length;
  }
  return size;
}

/**
 * Buffers embeds per Discord channel in memory and flushes them as a single `channel.send({ embeds })` call
 * every `flushIntervalMs` or once `maxBatchSize` embeds have queued up (whichever comes first), so a burst of
 * events (e.g. a raid, a bulk role change, a purge) doesn't send one Discord message per event and trip the
 * channel's rate limit. `send`/`onError` are injected so this class has no Discord.js client dependency and is
 * fully unit-testable with fake timers and a recording `send` stub.
 */
export class LogBatcher {
  private readonly batches = new Map<string, ChannelBatch>();
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly sendFn: LogBatcherOptions['send'];
  private readonly onError?: LogBatcherOptions['onError'];

  constructor(options: LogBatcherOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.sendFn = options.send;
    this.onError = options.onError;
  }

  /** Queues `embed` for `channelId`, flushing immediately if the queue just hit `maxBatchSize`, else (re)arming the flush timer. */
  enqueue(channelId: string, embed: EmbedBuilder): void {
    let batch = this.batches.get(channelId);
    if (!batch) {
      batch = { embeds: [], timer: null };
      this.batches.set(channelId, batch);
    }
    batch.embeds.push(embed);

    if (batch.embeds.length >= this.maxBatchSize) {
      this.flush(channelId);
      return;
    }

    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(channelId), this.flushIntervalMs);
      // Node-only guard: never keep the event loop alive just for a pending log flush (irrelevant in browser-ish test runners).
      batch.timer.unref?.();
    }
  }

  /** Immediately sends whatever is queued for `channelId` (no-op if empty) and clears its timer. Send failures go to `onError` and never throw. */
  flush(channelId: string): void {
    const batch = this.batches.get(channelId);
    if (!batch || batch.embeds.length === 0) return;

    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }

    const embeds = batch.embeds.splice(0, batch.embeds.length);
    const [first, ...rest] = this.splitBatchBySize(embeds);
    if (!first) return;

    // The common case is a single group, dispatched exactly as it always was. When the size cap forces a split,
    // chain the extra groups behind the first rather than firing them together: a log channel is read
    // chronologically, and concurrent sends would let Discord deliver a later group before an earlier one.
    const report = (err: unknown) => this.onError?.(channelId, err);
    let chain = this.sendFn(channelId, first).catch(report);
    for (const group of rest) {
      chain = chain.then(() => this.sendFn(channelId, group)).catch(report);
    }
  }

  /** Splits a batch of embeds into multiple groups so no single group exceeds Discord's 6000-character per-message limit. */
  private splitBatchBySize(embeds: EmbedBuilder[]): EmbedBuilder[][] {
    const batches: EmbedBuilder[][] = [];
    let currentBatch: EmbedBuilder[] = [];
    let currentSize = 0;

    for (const embed of embeds) {
      const embedSize = embedCharacterSize(embed);

      if (currentSize + embedSize > EMBED_LIMITS.total && currentBatch.length > 0) {
        // Current batch would exceed the limit; flush it and start a new one
        batches.push(currentBatch);
        currentBatch = [embed];
        currentSize = embedSize;
      } else {
        currentBatch.push(embed);
        currentSize += embedSize;
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  /** Flushes every channel with a pending batch (e.g. on plugin shutdown). */
  flushAll(): void {
    for (const channelId of [...this.batches.keys()]) {
      this.flush(channelId);
    }
  }

  /** Number of embeds currently queued for `channelId` (test helper). */
  pendingCount(channelId: string): number {
    return this.batches.get(channelId)?.embeds.length ?? 0;
  }
}
