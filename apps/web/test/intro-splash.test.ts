import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INTRO_BOOT_SCRIPT,
  INTRO_DURATION_MS,
  INTRO_SKIP_ATTRIBUTE,
  INTRO_SKIP_VALUE,
  INTRO_STORAGE_KEY,
} from '../src/components/intro/intro-config';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Runs the inline boot script against fake browser globals and returns the attribute it set, if any. */
function runBootScript({ webdriver = false, seen = false, storageThrows = false } = {}) {
  const attrs: Record<string, string> = {};
  const document = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
  const navigator = { webdriver };
  const window = {
    sessionStorage: {
      getItem: (key: string) => {
        if (storageThrows) throw new Error('SecurityError');
        return seen && key === INTRO_STORAGE_KEY ? '1' : null;
      },
    },
  };
  new Function('document', 'navigator', 'window', INTRO_BOOT_SCRIPT)(document, navigator, window);
  return attrs[INTRO_SKIP_ATTRIBUTE];
}

describe('intro splash boot script', () => {
  it('lets the intro play on the first load of a session', () => {
    expect(runBootScript()).toBeUndefined();
  });

  it('skips the intro once it has played this session', () => {
    expect(runBootScript({ seen: true })).toBe(INTRO_SKIP_VALUE);
  });

  it('skips the intro in automated browsers so e2e tests never wait behind it', () => {
    expect(runBootScript({ webdriver: true })).toBe(INTRO_SKIP_VALUE);
  });

  it('leaves the intro on (it still ends on its own timer) when storage is blocked', () => {
    expect(runBootScript({ storageThrows: true })).toBeUndefined();
  });
});

describe('intro splash wiring', () => {
  it('runs for 8 seconds', () => {
    expect(INTRO_DURATION_MS).toBe(8000);
  });

  it('is mounted in the root layout, with the boot script rendered ahead of it', () => {
    const layout = read('../src/app/layout.tsx');
    const scriptAt = layout.indexOf('INTRO_BOOT_SCRIPT }}');
    const splashAt = layout.indexOf('<IntroSplash />');
    expect(scriptAt).toBeGreaterThan(-1);
    expect(splashAt).toBeGreaterThan(scriptAt);
  });

  it('is hidden by CSS when the boot script marks the page, and has a no-JS failsafe', () => {
    const css = read('../src/app/globals.css');
    expect(css).toContain(`html[${INTRO_SKIP_ATTRIBUTE}='${INTRO_SKIP_VALUE}'] .intro-splash`);
    expect(css).toMatch(/\.intro-splash \{[^}]*animation: intro-splash-failsafe/);
  });

  it('reads the logo from the sync-brand manifest rather than a hardcoded path', () => {
    const splash = read('../src/components/intro/IntroSplash.tsx');
    expect(splash).toContain('brand.json');
    expect(splash).toContain('brand.logo');
  });
});
