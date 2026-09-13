import { EventEmitter } from 'node:events';
import type { PlatformEventMap, PlatformEventName } from '@pavisie/types';
import type { Logger } from 'pino';

type PlatformListener<K extends PlatformEventName> = (payload: PlatformEventMap[K]) => void | Promise<void>;

// Minimal shape shared by pino's Logger and node's Console, so callers can pass either (or omit it).
interface ErrorLoggable {
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Typed wrapper around node's `EventEmitter` for the platform's in-process event bus.
 * `emit` never throws — listener errors (sync or async/rejected) are caught and logged.
 */
export class PlatformEvents {
  private readonly emitter = new EventEmitter();
  private readonly logger?: ErrorLoggable;

  constructor(logger?: Logger | ErrorLoggable) {
    this.emitter.setMaxListeners(100);
    this.logger = logger;
  }

  on<K extends PlatformEventName>(event: K, listener: PlatformListener<K>): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends PlatformEventName>(event: K, listener: PlatformListener<K>): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  once<K extends PlatformEventName>(event: K, listener: PlatformListener<K>): void {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
  }

  /** Emits `event` to all listeners. Never throws — listener failures are caught and logged individually. */
  emit<K extends PlatformEventName>(event: K, payload: PlatformEventMap[K]): void {
    const listeners = this.emitter.listeners(event) as PlatformListener<K>[];
    for (const listener of listeners) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          result.catch((err: unknown) => this.logListenerError(event, err));
        }
      } catch (err) {
        this.logListenerError(event, err);
      }
    }
  }

  private logListenerError(event: PlatformEventName, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.logger) {
      this.logger.error({ event, err: message }, 'PlatformEvents listener threw');
    } else {
      // last-resort fallback when no logger was supplied
      console.error(`PlatformEvents listener for "${event}" threw:`, message);
    }
  }
}

/** Creates a new `PlatformEvents` bus, optionally logging listener errors with the given logger. */
export function createPlatformEvents(logger?: Logger | ErrorLoggable): PlatformEvents {
  return new PlatformEvents(logger);
}
