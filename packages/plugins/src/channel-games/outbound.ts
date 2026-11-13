// A per-channel, coalescing outbound queue for game chat output.
//
// Twitch lets the bot send about one message a second per channel, 500 characters each, and the bot's own sender
// (`sendChatMessage`) simply DROPS anything faster than that. A table with eight players acting at once would
// lose most of what it says. This queue is what makes a game safe to run in chat:
//   - at most one send per `intervalMs` per channel, however many lines are queued;
//   - queued lines are joined into one message, as many as fit in `maxChars`;
//   - a line queued with a `key` REPLACES an older queued line with the same key (the latest table state wins,
//     nobody needs the one before it);
//   - a line marked `keep` (a result, a refund notice) is never dropped: not for being stale, not when a send
//     fails. Everything else is best effort and expires after `staleMs`.
// Generic: it knows nothing about blackjack, and the same queue will carry the later games.
export type OutboundSendResult = 'sent' | 'retry' | 'failed';

export interface OutboundOptions {
  /** Sends one message. 'retry' means "not now, try the same text again" (the sender's own throttle was busy). */
  send: (channelKey: string, text: string) => Promise<OutboundSendResult>;
  intervalMs?: number;
  maxChars?: number;
  staleMs?: number;
  /** How many failed sends a `keep` line survives before it is finally given up on. */
  maxKeepAttempts?: number;
  /** Told when a line is given up on. Receives no text, only counts, so nothing typed or said can be logged. */
  onDrop?: (channelKey: string, info: { kept: boolean; reason: 'stale' | 'failed' }) => void;
  now?: () => number;
}

interface Line {
  text: string;
  key: string | null;
  keep: boolean;
  queuedAt: number;
  attempts: number;
}

interface ChannelQueue {
  lines: Line[];
  timer: ReturnType<typeof setTimeout> | null;
  sending: boolean;
  lastSendAt: number;
  idleWaiters: Array<() => void>;
}

const SEPARATOR = ' | ';

export class CoalescingOutbound {
  private readonly queues = new Map<string, ChannelQueue>();
  private readonly send: OutboundOptions['send'];
  private readonly intervalMs: number;
  private readonly maxChars: number;
  private readonly staleMs: number;
  private readonly maxKeepAttempts: number;
  private readonly onDrop: NonNullable<OutboundOptions['onDrop']>;
  private readonly now: () => number;
  private stopped = false;

  constructor(options: OutboundOptions) {
    this.send = options.send;
    this.intervalMs = options.intervalMs ?? 1100;
    this.maxChars = options.maxChars ?? 500;
    this.staleMs = options.staleMs ?? 15_000;
    this.maxKeepAttempts = options.maxKeepAttempts ?? 8;
    this.onDrop = options.onDrop ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /** Queues one line for `channelKey`. Returns at once; the line goes out with the next message that has room. */
  enqueue(channelKey: string, text: string, options: { key?: string; keep?: boolean } = {}): void {
    if (this.stopped || text.length === 0) return;
    const queue = this.queueFor(channelKey);
    const line: Line = {
      // A single line can never exceed one message.
      text: text.length > this.maxChars ? `${text.slice(0, this.maxChars - 1)}…` : text,
      key: options.key ?? null,
      keep: options.keep ?? false,
      queuedAt: this.now(),
      attempts: 0,
    };
    const existing = line.key === null ? -1 : queue.lines.findIndex((l) => l.key === line.key);
    if (existing === -1) {
      queue.lines.push(line);
    } else {
      // Same slot in the order, newest text. A kept line stays kept even if its replacement is not marked.
      line.keep = line.keep || (queue.lines[existing] as Line).keep;
      queue.lines[existing] = line;
    }
    this.schedule(channelKey, queue);
  }

  /** How many lines are waiting for `channelKey`. */
  pending(channelKey: string): number {
    return this.queues.get(channelKey)?.lines.length ?? 0;
  }

  /** Resolves once nothing is queued or being sent for `channelKey`. */
  idle(channelKey: string): Promise<void> {
    const queue = this.queues.get(channelKey);
    if (!queue || (queue.lines.length === 0 && !queue.sending)) return Promise.resolve();
    return new Promise((resolve) => queue.idleWaiters.push(resolve));
  }

  /** Cancels every timer and forgets everything queued. Used when the bot shuts down. */
  stop(): void {
    this.stopped = true;
    for (const queue of this.queues.values()) {
      if (queue.timer) clearTimeout(queue.timer);
      queue.timer = null;
      queue.lines = [];
      for (const wake of queue.idleWaiters.splice(0)) wake();
    }
    this.queues.clear();
  }

  private queueFor(channelKey: string): ChannelQueue {
    let queue = this.queues.get(channelKey);
    if (!queue) {
      queue = { lines: [], timer: null, sending: false, lastSendAt: 0, idleWaiters: [] };
      this.queues.set(channelKey, queue);
    }
    return queue;
  }

  private schedule(channelKey: string, queue: ChannelQueue): void {
    if (this.stopped || queue.timer || queue.sending) return;
    if (queue.lines.length === 0) {
      for (const wake of queue.idleWaiters.splice(0)) wake();
      // Nothing left to say. The bookkeeping is only dropped once a full interval has passed since the last
      // send: until then it is what stops the very next line from going out too soon.
      if (this.now() - queue.lastSendAt >= this.intervalMs) this.queues.delete(channelKey);
      return;
    }
    const wait = Math.max(0, queue.lastSendAt + this.intervalMs - this.now());
    queue.timer = setTimeout(() => {
      queue.timer = null;
      void this.flush(channelKey, queue);
    }, wait);
    // A pending chat line must never keep the process alive on shutdown.
    queue.timer.unref?.();
  }

  private async flush(channelKey: string, queue: ChannelQueue): Promise<void> {
    if (this.stopped || queue.sending) return;

    // Best-effort lines that waited too long are no longer worth saying. Kept lines never expire.
    const cutoff = this.now() - this.staleMs;
    queue.lines = queue.lines.filter((line) => {
      if (line.keep || line.queuedAt >= cutoff) return true;
      this.onDrop(channelKey, { kept: false, reason: 'stale' });
      return false;
    });

    // Take lines in order for as long as they fit in one message.
    const batch: Line[] = [];
    let length = 0;
    for (const line of queue.lines) {
      const added = (batch.length > 0 ? SEPARATOR.length : 0) + line.text.length;
      if (batch.length > 0 && length + added > this.maxChars) break;
      batch.push(line);
      length += added;
    }
    if (batch.length === 0) {
      this.schedule(channelKey, queue);
      return;
    }

    queue.sending = true;
    queue.lastSendAt = this.now();
    let result: OutboundSendResult;
    try {
      result = await this.send(channelKey, batch.map((line) => line.text).join(SEPARATOR));
    } catch {
      result = 'failed';
    }
    queue.sending = false;
    if (this.stopped) return;

    if (result === 'sent') {
      queue.lines = queue.lines.filter((line) => !batch.includes(line));
    } else if (result === 'failed') {
      for (const line of batch) line.attempts += 1;
      queue.lines = queue.lines.filter((line) => {
        if (!batch.includes(line)) return true;
        if (line.keep && line.attempts < this.maxKeepAttempts) return true;
        this.onDrop(channelKey, { kept: line.keep, reason: 'failed' });
        return false;
      });
    }
    // 'retry': the same lines stay queued and go out on the next slot.
    this.schedule(channelKey, queue);
  }
}
