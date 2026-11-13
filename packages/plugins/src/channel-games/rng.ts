// Seeded, injectable randomness for channel games. Every game takes its randomness as a plain `() => number`
// (the same pattern `rollDaily` uses for the daily reward), so tests can script it and a finished hand can be
// replayed from the seed stored on its `ChannelGameHand` row. Not for anything security-sensitive: the stakes are
// a virtual currency, and the seed is recorded so a streamer can audit a hand, not so a viewer can predict one.
import { randomInt } from 'node:crypto';

/** A fresh 32-bit seed. Uses the OS source so two tables opened in the same millisecond never share a shuffle. */
export function randomSeed(): number {
  return randomInt(0, 0x1_0000_0000);
}

/** mulberry32: a small, fast generator with a full 32-bit state. Returns floats in [0, 1). */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle of a copy of `items`, driven by `rng`. */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
