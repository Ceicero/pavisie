/**
 * In-memory registry of open OBS-overlay SSE connections, keyed by `TwitchChatChannel.id` (channel-points
 * spec v1, "Overlay transport"). A module-level singleton is correct here: `apps/api/src/index.ts` builds
 * exactly one `buildApp()` per running API process, and every SSE connection is one long-lived HTTP request
 * pinned to whichever replica accepted it — a published message only ever needs to reach connections
 * registered on the SAME replica that received it. `apps/api/src/app.ts` wires a dedicated Redis subscriber
 * (see the comment there) that calls `dispatchOverlayMessage` on every replica for every published message;
 * each replica's dispatch only writes into its own local map below, which is exactly what makes this design
 * correct with N replicas — no cross-replica coordination needed.
 */

export interface OverlayConnection {
  write(chunk: string): void;
}

interface OverlaySoundEvent {
  id: string;
  kind: 'sound';
  url: string;
  volume: number;
}

interface OverlayTtsEvent {
  id: string;
  kind: 'tts';
  audioId: string;
  volume: number;
}

export type OverlayEvent = OverlaySoundEvent | OverlayTtsEvent;

const connectionsByChannel = new Map<string, Set<OverlayConnection>>();

/**
 * Registers `conn` to receive future events published for `channelId`. Callers MUST call
 * `unregisterOverlayConnection` with the same pair when the connection closes/errors, or it leaks forever —
 * `routes/overlay.ts`'s `/stream` handler does this from the request's `close`/`error` events.
 */
export function registerOverlayConnection(channelId: string, conn: OverlayConnection): void {
  let set = connectionsByChannel.get(channelId);
  if (!set) {
    set = new Set();
    connectionsByChannel.set(channelId, set);
  }
  set.add(conn);
}

export function unregisterOverlayConnection(channelId: string, conn: OverlayConnection): void {
  const set = connectionsByChannel.get(channelId);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) connectionsByChannel.delete(channelId);
}

/** Number of currently-open overlay connections for `channelId`. Exported for tests and lightweight ops visibility. */
export function overlayConnectionCount(channelId: string): number {
  return connectionsByChannel.get(channelId)?.size ?? 0;
}

function parseOverlayEvent(raw: string): OverlayEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec.id !== 'string' || rec.id.length === 0) return null;
  const volume = typeof rec.volume === 'number' && Number.isFinite(rec.volume) ? rec.volume : 0;

  if (rec.kind === 'sound' && typeof rec.url === 'string' && rec.url.length > 0) {
    return { id: rec.id, kind: 'sound', url: rec.url, volume };
  }
  if (rec.kind === 'tts' && typeof rec.audioId === 'string' && rec.audioId.length > 0) {
    return { id: rec.id, kind: 'tts', audioId: rec.audioId, volume };
  }
  return null;
}

/**
 * Parses and re-serializes `raw` (the exact string published to `pavisie:overlay:<channelId>` by the bot,
 * per the fixed SOUND/TTS payload contract) into a normalized SSE `data:` frame, then writes it to every
 * connection currently registered for `channelId`. Re-serializing rather than forwarding `raw` verbatim both
 * validates the shape and guarantees the frame can never contain a bare newline that would corrupt SSE
 * framing or let a malformed publish smuggle extra `data:`/`event:` lines into the stream. Malformed or
 * unrecognized messages are dropped silently — one bad publish must not take down connections for other
 * channels or crash the API. Returns the number of connections written to (0 for an invalid message or a
 * channel with no open connections), which is also what tests assert on.
 */
export function dispatchOverlayMessage(channelId: string, raw: string): number {
  const event = parseOverlayEvent(raw);
  if (!event) return 0;
  const set = connectionsByChannel.get(channelId);
  if (!set || set.size === 0) return 0;
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const conn of set) conn.write(frame);
  return set.size;
}
