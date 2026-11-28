import { describe, expect, it, vi } from 'vitest';
import { runShutdownSteps, settleAll } from '../src/shutdown';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('runShutdownSteps', () => {
  it('runs steps in order and reports durations', async () => {
    const order: string[] = [];
    const logger = makeLogger();
    const summary = await runShutdownSteps(
      [
        { name: 'a', run: () => void order.push('a') },
        { name: 'b', run: async () => void order.push('b') },
      ],
      { logger, stepTimeoutMs: 100 },
    );
    expect(order).toEqual(['a', 'b']);
    expect(summary.timedOut).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(Object.keys(summary.durations)).toEqual(['a', 'b']);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'a', ms: expect.any(Number) }),
      'shutdown step finished',
    );
  });

  it('times out a hanging step and still disconnects prisma afterwards', async () => {
    const logger = makeLogger();
    const prisma = vi.fn();
    const summary = await runShutdownSteps(
      [
        { name: 'workers', timeoutMs: 20, run: () => new Promise<void>(() => {}) },
        { name: 'prisma', run: prisma },
      ],
      { logger, stepTimeoutMs: 50 },
    );
    expect(prisma).toHaveBeenCalledOnce();
    expect(summary.timedOut).toEqual(['workers']);
    expect(logger.warn).toHaveBeenCalledWith(
      { step: 'workers', timeoutMs: 20 },
      'shutdown step timed out; continuing',
    );
  });

  it('bounds the whole sequence by the sum of step timeouts when every step hangs', async () => {
    const hang = () => new Promise<void>(() => {});
    const started = Date.now();
    const summary = await runShutdownSteps(
      [
        { name: 'a', timeoutMs: 30, run: hang },
        { name: 'b', timeoutMs: 30, run: hang },
        { name: 'c', timeoutMs: 30, run: hang },
      ],
      { logger: makeLogger() },
    );
    const elapsed = Date.now() - started;
    expect(summary.timedOut).toEqual(['a', 'b', 'c']);
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(500);
  });

  it('logs a throwing step and continues', async () => {
    const logger = makeLogger();
    const next = vi.fn();
    const boom = new Error('boom');
    const summary = await runShutdownSteps(
      [
        {
          name: 'bad',
          run: () => {
            throw boom;
          },
        },
        { name: 'next', run: next },
      ],
      { logger, stepTimeoutMs: 50 },
    );
    expect(next).toHaveBeenCalledOnce();
    expect(summary.failed).toEqual(['bad']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, step: 'bad' }),
      expect.any(String),
    );
  });

  it('uses the per-step timeout over the default and clears each timer', async () => {
    const timers: number[] = [];
    const cleared = vi.fn();
    let id = 0;
    await runShutdownSteps(
      [
        { name: 'a', timeoutMs: 3000, run: () => undefined },
        { name: 'b', run: () => undefined },
      ],
      {
        logger: makeLogger(),
        stepTimeoutMs: 750,
        setTimer: (_fn, ms) => {
          timers.push(ms);
          return ++id;
        },
        clearTimer: cleared,
      },
    );
    expect(timers).toEqual([3000, 750]);
    expect(cleared.mock.calls).toEqual([[1], [2]]);
  });
});

describe('settleAll', () => {
  it('waits for every promise and rethrows the first failure', async () => {
    const done = vi.fn();
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 10)).then(done);
    await expect(settleAll([Promise.reject(new Error('first')), slow])).rejects.toThrow('first');
    expect(done).toHaveBeenCalledOnce();
  });

  it('resolves when all succeed', async () => {
    await expect(settleAll([Promise.resolve(1), Promise.resolve()])).resolves.toBeUndefined();
  });
});
