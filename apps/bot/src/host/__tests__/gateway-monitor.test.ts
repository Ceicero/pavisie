import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Client } from 'discord.js';
import { createGatewayMonitor } from '../gateway-monitor';

const logger = pino({ enabled: false });
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function fakeClient() {
  const state = { ready: false };
  return { client: { isReady: () => state.ready } as unknown as Client, state };
}

describe('createGatewayMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts from creation until the gateway first becomes ready, then reports 0', async () => {
    const { client, state } = fakeClient();
    const monitor = createGatewayMonitor({ client, logger });

    await vi.advanceTimersByTimeAsync(45 * SECOND);
    expect(monitor.notReadyForMs()).toBe(45 * SECOND);

    state.ready = true;
    expect(monitor.notReadyForMs()).toBe(0);
    monitor.stop();
  });

  it('restarts the count from the moment a ready gateway drops', async () => {
    const { client, state } = fakeClient();
    state.ready = true;
    const monitor = createGatewayMonitor({ client, logger });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(monitor.notReadyForMs()).toBe(0);

    state.ready = false;
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    // The drop is noticed on the next sample, so the count is the time since then, not since startup.
    expect(monitor.notReadyForMs()).toBeLessThanOrEqual(30 * SECOND);
    expect(monitor.notReadyForMs()).toBeGreaterThan(0);
    monitor.stop();
  });

  describe('watchdog', () => {
    it('trips once after the gateway has been down for the threshold', async () => {
      const { client } = fakeClient();
      const onTrip = vi.fn();
      const monitor = createGatewayMonitor({
        client,
        logger,
        watchdog: { afterMs: 5 * MINUTE, onTrip },
      });

      await vi.advanceTimersByTimeAsync(5 * MINUTE - SECOND);
      expect(onTrip).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10 * SECOND);
      expect(onTrip).toHaveBeenCalledTimes(1);
      expect(onTrip.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(5 * MINUTE);

      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(onTrip).toHaveBeenCalledTimes(1);
      monitor.stop();
    });

    it('does not trip when the gateway comes back before the threshold', async () => {
      const { client, state } = fakeClient();
      const onTrip = vi.fn();
      const monitor = createGatewayMonitor({
        client,
        logger,
        watchdog: { afterMs: 5 * MINUTE, onTrip },
      });

      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      state.ready = true;
      await vi.advanceTimersByTimeAsync(20 * SECOND);
      state.ready = false;
      // Down again, but the clock restarted when it was last seen ready.
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(onTrip).not.toHaveBeenCalled();
      monitor.stop();
    });

    it('does nothing without a watchdog configured, and nothing after stop()', async () => {
      const { client } = fakeClient();
      const onTrip = vi.fn();
      const idle = createGatewayMonitor({ client, logger });
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
      idle.stop();

      const stopped = createGatewayMonitor({ client, logger, watchdog: { afterMs: MINUTE, onTrip } });
      stopped.stop();
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
      expect(onTrip).not.toHaveBeenCalled();
    });

    it('survives a throwing handler', async () => {
      const { client } = fakeClient();
      const monitor = createGatewayMonitor({
        client,
        logger,
        watchdog: {
          afterMs: MINUTE,
          onTrip: () => {
            throw new Error('boom');
          },
        },
      });
      await expect(vi.advanceTimersByTimeAsync(2 * MINUTE)).resolves.not.toThrow();
      monitor.stop();
    });
  });
});
