/**
 * Ordered, time-bounded shutdown. A step that hangs (e.g. a BullMQ worker waiting on an active job, or a Redis
 * connection that never answers) must not stop later steps — above all the final Redis/Prisma steps that release
 * connections — from running before the platform SIGKILLs the container (~10 s after SIGTERM on Railway). When
 * that kill lands first, Postgres logs one "unexpected eof / connection reset" per pooled connection.
 *
 * Every step has its own timeout, so the worst case is simply the sum of the step timeouts; callers keep that sum
 * under the platform's kill window. A step that times out is left running in the background (it cannot be
 * cancelled) and the sequence moves on.
 */
export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown> | unknown;
  /** Overrides `stepTimeoutMs` for this step. */
  timeoutMs?: number;
}

export interface ShutdownLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ShutdownOptions {
  logger: ShutdownLogger;
  /** Timeout for steps that do not set their own. */
  stepTimeoutMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ShutdownSummary {
  timedOut: string[];
  failed: string[];
  durations: Record<string, number>;
}

const TIMEOUT = Symbol('shutdown-step-timeout');

export async function runShutdownSteps(
  steps: ShutdownStep[],
  opts: ShutdownOptions,
): Promise<ShutdownSummary> {
  const {
    logger,
    stepTimeoutMs = 1000,
    now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h as NodeJS.Timeout),
  } = opts;
  const summary: ShutdownSummary = { timedOut: [], failed: [], durations: {} };

  for (const step of steps) {
    const timeoutMs = step.timeoutMs ?? stepTimeoutMs;
    const stepStart = now();
    let timer: unknown;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimer(() => resolve(TIMEOUT), timeoutMs);
    });
    try {
      const result = await Promise.race([Promise.resolve().then(step.run), timeout]);
      if (result === TIMEOUT) {
        summary.timedOut.push(step.name);
        logger.warn({ step: step.name, timeoutMs }, 'shutdown step timed out; continuing');
      }
    } catch (err) {
      summary.failed.push(step.name);
      logger.error({ err, step: step.name }, 'error during shutdown step; continuing');
    } finally {
      clearTimer(timer);
    }
    const ms = now() - stepStart;
    summary.durations[step.name] = ms;
    logger.info({ step: step.name, ms }, 'shutdown step finished');
  }
  return summary;
}

/** Runs every promise to completion and rethrows the first failure, so one bad close does not hide the rest. */
export async function settleAll(promises: Iterable<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
}
