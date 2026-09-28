// Agis Twitch Extension panel (ARCHITECTURE.md §19d). Plain TypeScript compiled straight to a browser-native
// ES module — no framework, no bundler (Twitch's extension review rejects both a bundler-introduced eval-ish
// pattern and any third-party script host besides their own helper). Everything DOM/Twitch-facing lives behind
// the `typeof window !== 'undefined'` guard at the bottom of this file so importing the module's pure helpers
// from a Node test runner (vitest) never touches `document`/`window`/`Twitch`.
//
// Text is always set via `textContent` (never `innerHTML`) — every string this file renders either comes from
// our own fixed copy or from the API (a Twitch display name, a formatted number), and none of it is ever
// trusted as markup.

// ---------------------------------------------------------------------------
// Pure, unit-tested helpers
// ---------------------------------------------------------------------------

/** Compile-time default; there is no runtime/inline override (Twitch's review disallows inline scripts, so a
 * page-supplied config object isn't an option here) — point at a different API by rebuilding with this
 * constant changed. */
export const DEFAULT_API_BASE_URL = 'https://api.pavisie.com';

export interface WalletSummaryResponse {
  enabled: boolean;
  currencyName?: string;
  currencySymbol?: string;
  identityShared?: boolean;
  wallet?: { balance: string; dailyAvailableAt: string | null; streak: number };
  leaderboard?: Array<{ displayName: string; earned: string }>;
}

export interface DailyClaimResponse {
  ok: boolean;
  amount?: string;
  streak?: number;
  retryAfterMs?: number;
}

/** Formats milliseconds remaining as a compact countdown: `H:MM:SS` once an hour or more remains, else `M:SS`.
 * Never negative — anything `<= 0` reads as `0:00` (claimable now). */
export function formatCountdown(msRemaining: number): string {
  const totalSeconds = msRemaining > 0 ? Math.ceil(msRemaining / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Formats a decimal-integer balance/earned string (as the API serializes a bigint) with thousands
 * separators. Falls back to the raw string on anything unparsable rather than throwing. */
export function formatAmount(raw: string): string {
  try {
    return BigInt(raw).toLocaleString('en-US');
  } catch {
    return raw;
  }
}

/** Milliseconds until `isoTimestamp`, clamped to 0. `null` means "claimable now" (no cooldown active). */
export function msUntil(isoTimestamp: string | null, now: number): number {
  if (!isoTimestamp) return 0;
  const target = Date.parse(isoTimestamp);
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, target - now);
}

// ---------------------------------------------------------------------------
// Twitch Extensions Helper types (the subset this panel uses)
// ---------------------------------------------------------------------------

interface TwitchExtAuth {
  token: string;
  userId?: string;
  channelId: string;
}

interface TwitchExtContext {
  theme?: 'light' | 'dark';
}

interface TwitchExtHelper {
  onAuthorized(callback: (auth: TwitchExtAuth) => void): void;
  onContext(callback: (context: TwitchExtContext, changedProperties: string[]) => void): void;
  actions: {
    requestIdShare(): void;
  };
}

declare global {
  interface Window {
    Twitch?: { ext: TwitchExtHelper };
  }
}

// ---------------------------------------------------------------------------
// DOM wiring — only ever runs in a real browser (see the guard at the bottom of this file)
// ---------------------------------------------------------------------------

type PanelState = 'loading' | 'disabled' | 'main';

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Agis panel: missing #${id} in panel.html`);
  return el;
}

function showState(state: PanelState): void {
  byId('state-loading').classList.toggle('hidden', state !== 'loading');
  byId('state-disabled').classList.toggle('hidden', state !== 'disabled');
  byId('state-main').classList.toggle('hidden', state !== 'main');
}

let cooldownIntervalId: ReturnType<typeof setInterval> | undefined;

function stopCooldownCountdown(): void {
  if (cooldownIntervalId !== undefined) {
    clearInterval(cooldownIntervalId);
    cooldownIntervalId = undefined;
  }
}

function startCooldownCountdown(dailyAvailableAt: string, claimButton: HTMLButtonElement, cooldownEl: HTMLElement): void {
  stopCooldownCountdown();

  const tick = (): void => {
    const remaining = msUntil(dailyAvailableAt, Date.now());
    if (remaining <= 0) {
      stopCooldownCountdown();
      claimButton.disabled = false;
      claimButton.textContent = 'Claim daily';
      cooldownEl.classList.add('hidden');
      cooldownEl.textContent = '';
      return;
    }
    claimButton.disabled = true;
    claimButton.textContent = 'Claim daily';
    cooldownEl.classList.remove('hidden');
    cooldownEl.textContent = `Next claim in ${formatCountdown(remaining)}`;
  };

  tick();
  cooldownIntervalId = setInterval(tick, 1000);
}

function renderLeaderboard(rows: Array<{ displayName: string; earned: string }>): void {
  const list = byId('leaderboard-list');
  list.textContent = '';
  if (rows.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'leaderboard-empty';
    empty.textContent = 'No one has earned anything here yet.';
    list.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'leaderboard-name';
    name.textContent = row.displayName;
    const earned = document.createElement('span');
    earned.className = 'leaderboard-earned';
    earned.textContent = formatAmount(row.earned);
    item.appendChild(name);
    item.appendChild(earned);
    list.appendChild(item);
  }
}

async function apiFetch<T>(apiBaseUrl: string, path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Agis panel: request to ${path} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

class PanelController {
  private auth: TwitchExtAuth | null = null;
  private readonly apiBaseUrl: string;

  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl;
  }

  setAuth(auth: TwitchExtAuth): void {
    this.auth = auth;
    void this.load();
  }

  private async load(): Promise<void> {
    if (!this.auth) return;
    showState('loading');
    try {
      const summary = await apiFetch<WalletSummaryResponse>(this.apiBaseUrl, '/twitch-ext/summary', this.auth.token);
      this.render(summary);
    } catch {
      // Network/API failure: keep the panel in a non-broken state rather than showing a raw error — treat it
      // the same as "not enabled" from the viewer's point of view (nothing actionable for them to do).
      showState('disabled');
    }
  }

  private render(summary: WalletSummaryResponse): void {
    if (!summary.enabled) {
      showState('disabled');
      return;
    }

    byId('currency-name').textContent = summary.currencyName ?? 'currency';

    const balanceShown = byId('balance-shown');
    const identityGate = byId('identity-gate');

    if (!summary.identityShared) {
      balanceShown.classList.add('hidden');
      identityGate.classList.remove('hidden');
    } else {
      identityGate.classList.add('hidden');
      balanceShown.classList.remove('hidden');

      const wallet = summary.wallet ?? { balance: '0', dailyAvailableAt: null, streak: 0 };
      byId('balance-value').textContent = formatAmount(wallet.balance);
      byId('balance-symbol').textContent = summary.currencySymbol ?? '';
      byId('streak-value').textContent = wallet.streak > 0 ? `${wallet.streak} day streak` : '';

      const claimButton = byId('claim-button') as HTMLButtonElement;
      const cooldownEl = byId('cooldown');
      if (wallet.dailyAvailableAt) {
        startCooldownCountdown(wallet.dailyAvailableAt, claimButton, cooldownEl);
      } else {
        stopCooldownCountdown();
        claimButton.disabled = false;
        claimButton.textContent = 'Claim daily';
        cooldownEl.classList.add('hidden');
      }
    }

    renderLeaderboard(summary.leaderboard ?? []);
    showState('main');
  }

  async claimDaily(): Promise<void> {
    if (!this.auth) return;
    const claimButton = byId('claim-button') as HTMLButtonElement;
    claimButton.disabled = true;
    try {
      const result = await apiFetch<DailyClaimResponse>(this.apiBaseUrl, '/twitch-ext/daily', this.auth.token, {
        method: 'POST',
      });
      if (result.ok) {
        await this.load(); // refresh balance/streak/cooldown from the server rather than guessing locally
      } else if (result.retryAfterMs !== undefined) {
        const cooldownEl = byId('cooldown');
        startCooldownCountdown(new Date(Date.now() + result.retryAfterMs).toISOString(), claimButton, cooldownEl);
      } else {
        claimButton.disabled = false;
      }
    } catch {
      claimButton.disabled = false;
    }
  }

  requestIdentityShare(): void {
    window.Twitch?.ext.actions.requestIdShare();
  }
}

function init(): void {
  if (!window.Twitch) return;

  showState('loading');
  const controller = new PanelController(DEFAULT_API_BASE_URL);

  window.Twitch.ext.onContext((context) => {
    document.body.dataset.theme = context.theme === 'light' ? 'light' : 'dark';
  });

  window.Twitch.ext.onAuthorized((auth) => {
    controller.setAuth(auth);
  });

  byId('claim-button').addEventListener('click', () => {
    void controller.claimDaily();
  });
  byId('share-identity-button').addEventListener('click', () => {
    controller.requestIdentityShare();
  });
}

if (typeof window !== 'undefined') {
  // DOMContentLoaded may have already fired by the time a deferred `type="module"` script runs (modules are
  // deferred by default), but guarding costs nothing and protects against a future non-module load order change.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
