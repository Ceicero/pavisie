// Discord <-> Twitch chat bridge — outbound rate limiting for the Twitch -> Discord relay direction.
/** Per-channel token bucket for the Twitch -> Discord relay direction — caps outbound webhook sends well under
 * Discord's per-webhook rate limit (~5 requests/2s) so a busy Twitch chat can never produce enough 429s to risk
 * an IP-level temporary ban (which would take the whole bot process offline, not just this feature). Refills
 * continuously (not in fixed windows) so the cap is smooth rather than bursty-then-silent. */
const REFILL_TOKENS_PER_SECOND = 2;
const MAX_BURST_TOKENS = 4;

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
