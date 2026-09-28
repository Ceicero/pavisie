// Discord <-> Twitch chat bridge — outbound rate limiting for the Twitch -> Discord relay direction.
/** Per-channel token bucket for the Twitch -> Discord relay direction. The binding limit is not the per-webhook
 * ~5 requests/2s but the widely observed ~30 webhook messages per MINUTE per Discord channel (shared across every
 * webhook in that channel). A cap above that does not produce dropped messages — discord.js waits out the 429 and
 * QUEUES the rest in memory, so a busy Twitch chat would grow that queue without bound and deliver messages minutes
 * late. So the sustained rate sits at 30/minute (one every 2s) with a small burst, and everything beyond it is
 * dropped and counted here instead of queued. Refills continuously (not in fixed windows) so the cap is smooth. */
const REFILL_TOKENS_PER_SECOND = 0.5;
const MAX_BURST_TOKENS = 5;

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

/** Returns true and consumes one token if `channelId` has capacity to send right now; false (consuming nothing)
 * if the bucket is empty — the caller must drop the message rather than queue it (no unbounded growth). */
export function takeBridgeSendToken(channelId: string, now: number = Date.now()): boolean {
  let bucket = buckets.get(channelId);
  if (!bucket) {
    bucket = { tokens: MAX_BURST_TOKENS, lastRefillMs: now };
    buckets.set(channelId, bucket);
  }
  const elapsedSeconds = Math.max(0, (now - bucket.lastRefillMs) / 1000);
  bucket.tokens = Math.min(MAX_BURST_TOKENS, bucket.tokens + elapsedSeconds * REFILL_TOKENS_PER_SECOND);
  bucket.lastRefillMs = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Drops a channel's bucket state entirely — called when its bridge is fully disabled, mirroring
 * `bridge-metrics.ts`'s `pruneBridgeDropCount`. */
export function pruneBridgeSendBucket(channelId: string): void {
  buckets.delete(channelId);
}
