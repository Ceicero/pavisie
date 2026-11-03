import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { RETIRED_JOB_SCHEDULERS, removeRetiredJobSchedulers } from '../retired-jobs';

const logger = pino({ enabled: false });

function fakeQueue(fail = false) {
  return {
    removeJobScheduler: vi.fn(async () => {
      if (fail) throw new Error('redis down');
      return true;
    }),
    obliterate: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('removeRetiredJobSchedulers', () => {
  it('removes the scheduler and clears the queue for every retired job, then closes it', async () => {
    const queues = new Map<string, ReturnType<typeof fakeQueue>>();
    await removeRetiredJobSchedulers({}, logger, (name) => {
      const q = fakeQueue();
      queues.set(name, q);
      return q as never;
    });

    expect([...queues.keys()]).toEqual(['gamestats.gamestats-refresh', 'integrations.poll-steam']);
    for (const { queue, scheduler } of RETIRED_JOB_SCHEDULERS) {
      const q = queues.get(queue)!;
      expect(q.removeJobScheduler).toHaveBeenCalledWith(scheduler);
      expect(q.obliterate).toHaveBeenCalledWith({ force: true });
      expect(q.close).toHaveBeenCalled();
    }
  });

  it('never throws and still processes the rest when one queue fails', async () => {
    const made: ReturnType<typeof fakeQueue>[] = [];
    await expect(
      removeRetiredJobSchedulers({}, logger, () => {
        const q = fakeQueue(made.length === 0);
        made.push(q);
        return q as never;
      }),
    ).resolves.toBeUndefined();

    expect(made).toHaveLength(2);
    expect(made[0]!.close).toHaveBeenCalled();
    expect(made[1]!.removeJobScheduler).toHaveBeenCalled();
  });
});
