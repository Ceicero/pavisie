// Pure formatting helpers shared by every screen (and unit-tested from Node — no DOM in here).

/** 1284 → "1,284"; 12900 → "12.9K"; 4200000 → "4.2M". Missing values show as an em dash, never as 0. */
export function formatCount(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs < 10_000) return Math.round(n).toLocaleString('en-US');
  for (const [limit, suffix] of [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]) {
    if (abs >= limit) {
      const scaled = n / limit;
      const text = Math.abs(scaled) >= 100 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '');
      return `${text}${suffix}`;
    }
  }
  return String(n);
}

/** Full, uncompacted number for tooltips and tables. */
export function formatExact(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Math.round(Number(value)).toLocaleString('en-US');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-03" → "Nov 3". Reads the string directly so a UTC day never shifts with the local time zone. */
export function formatDay(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate ?? ''));
  if (!match) return '—';
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}`;
}

/** ISO timestamp → "just now" / "5 min ago" / "3 hr ago" / "4 days ago" / "Nov 3, 2026". */
export function formatRelative(iso, now = Date.now()) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const date = new Date(then);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** Share of a whole as "46%"; a zero whole gives "0%" rather than NaN. */
export function formatShare(part, whole) {
  if (!whole) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

/** "GOOGLE_CALENDAR" → "Google Calendar"; "twitch_chat_earn" → "Twitch chat earn". */
export function humanize(value, { titleCase = false } = {}) {
  const words = String(value ?? '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '—';
  return words
    .map((word, i) => (titleCase || i === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * Clean axis ticks from zero up to at least `max`: [0, 500, 1000, 1500] rather than [0, 437, 874, 1311].
 * Counts are whole things, so the step never goes below 1.
 */
export function niceTicks(max, target = 4) {
  const top = Math.max(1, Number(max) || 0);
  const rough = top / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(
    1,
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude,
  );
  const ticks = [];
  for (let value = 0; value < top + step; value += step) {
    ticks.push(value);
    if (value >= top) break;
  }
  return ticks;
}

/** Sum of one numeric field across rows; missing values count as zero. */
export function sumOf(rows, key) {
  return (rows ?? []).reduce((total, row) => total + (Number(row?.[key]) || 0), 0);
}
