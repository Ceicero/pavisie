import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { EmbedBuilder } from 'discord.js';
import { LogBatcher } from '../batcher';

/** Shared across every fake so two `fakeEmbed(1)` values stay deep-equal — a per-instance closure would not be. */
function fakeToJSON(this: { json: object }): object {
  return this.json;
}

/** A stand-in for an `EmbedBuilder`: `id` keeps each one identifiable, `toJSON` mirrors the real builder's API so
 * the batcher's size accounting sees a payload of `charCount` characters. */
function fakeEmbed(id: number, charCount: number = 0): EmbedBuilder {
  const json = charCount === 0 ? {} : { description: 'x'.repeat(charCount) };
  return { id, json, toJSON: fakeToJSON } as unknown as EmbedBuilder;
}

describe('LogBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes automatically after the configured interval with everything queued so far', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const batcher = new LogBatcher({ send, flushIntervalMs: 2000, maxBatchSize: 5 });

    batcher.enqueue('chan-1', fakeEmbed(1));
    batcher.enqueue('chan-1', fakeEmbed(2));
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('chan-1', [fakeEmbed(1), fakeEmbed(2)]);
  });

  it('flushes immediately once maxBatchSize is reached, without waiting for the timer', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const batcher = new LogBatcher({ send, flushIntervalMs: 2000, maxBatchSize: 3 });

    batcher.enqueue('chan-1', fakeEmbed(1));
    batcher.enqueue('chan-1', fakeEmbed(2));
    expect(send).not.toHaveBeenCalled();
    batcher.enqueue('chan-1', fakeEmbed(3));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('chan-1', [fakeEmbed(1), fakeEmbed(2), fakeEmbed(3)]);
    expect(batcher.pendingCount('chan-1')).toBe(0);
  });

  it('batches each channel independently', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const batcher = new LogBatcher({ send, flushIntervalMs: 2000, maxBatchSize: 5 });

    batcher.enqueue('chan-1', fakeEmbed(1));
    batcher.enqueue('chan-2', fakeEmbed(2));

    await vi.advanceTimersByTimeAsync(2000);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('chan-1', [fakeEmbed(1)]);
    expect(send).toHaveBeenCalledWith('chan-2', [fakeEmbed(2)]);
  });

  it('starts a fresh batch after a flush instead of re-sending old embeds', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const batcher = new LogBatcher({ send, flushIntervalMs: 2000, maxBatchSize: 2 });

    batcher.enqueue('chan-1', fakeEmbed(1));
    batcher.enqueue('chan-1', fakeEmbed(2)); // hits maxBatchSize, flushes
    batcher.enqueue('chan-1', fakeEmbed(3));

    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.pendingCount('chan-1')).toBe(1);
  });

  it('reports send failures via onError instead of throwing', async () => {
    const err = new Error('rate limited');
    const send = vi.fn().mockRejectedValue(err);
    const onError = vi.fn();
    const batcher = new LogBatcher({ send, onError, flushIntervalMs: 2000, maxBatchSize: 1 });

    batcher.enqueue('chan-1', fakeEmbed(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith('chan-1', err);
  });

  it('flushAll flushes every channel with a pending batch', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const batcher = new LogBatcher({ send, flushIntervalMs: 2000, maxBatchSize: 5 });

    batcher.enqueue('chan-1', fakeEmbed(1));
    batcher.enqueue('chan-2', fakeEmbed(2));
    batcher.flushAll();

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('flush() on a channel with nothing queued is a harmless no-op', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const batcher = new LogBatcher({ send });
    expect(() => batcher.flush('never-used')).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('splits a batch into multiple sends when combined embed size exceeds 6000 characters', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const batcher = new LogBatcher({ send, maxBatchSize: 10 });

    // Create embeds: each 2000 chars, so 3 of them = 6000, but a 4th would exceed the limit
    const embed1 = fakeEmbed(1, 2000);
    const embed2 = fakeEmbed(2, 2000);
    const embed3 = fakeEmbed(3, 2000);
    const embed4 = fakeEmbed(4, 1500);
    const embed5 = fakeEmbed(5, 500);

    batcher.enqueue('chan-1', embed1);
    batcher.enqueue('chan-1', embed2);
    batcher.enqueue('chan-1', embed3);
    batcher.enqueue('chan-1', embed4);
    batcher.enqueue('chan-1', embed5);

    batcher.flush('chan-1');
    // Groups after the first are chained behind it, so let the microtask queue drain.
    await vi.advanceTimersByTimeAsync(0);

    // Should have sent twice: first batch with embeds 1-3 (6000 chars), second with embeds 4-5 (2000 chars)
    expect(send).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = send.mock.calls;

    expect((firstCall?.[1] as EmbedBuilder[])?.length).toBe(3); // embed1, embed2, embed3
    expect((secondCall?.[1] as EmbedBuilder[])?.length).toBe(2); // embed4, embed5
  });

  it('handles a single embed larger than 6000 characters by sending it alone', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const batcher = new LogBatcher({ send, maxBatchSize: 5 });

    // One embed with 7000 chars (exceeds the limit)
    const embed1 = fakeEmbed(1, 7000);
    const embed2 = fakeEmbed(2, 500);

    batcher.enqueue('chan-1', embed1);
    batcher.enqueue('chan-1', embed2);

    batcher.flush('chan-1');
    // Groups after the first are chained behind it, so let the microtask queue drain.
    await vi.advanceTimersByTimeAsync(0);

    // Should have sent twice: embed1 alone, then embed2 alone
    expect(send).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = send.mock.calls;

    expect((firstCall?.[1] as EmbedBuilder[])?.length).toBe(1); // just embed1
    expect((secondCall?.[1] as EmbedBuilder[])?.length).toBe(1); // just embed2
  });
});
