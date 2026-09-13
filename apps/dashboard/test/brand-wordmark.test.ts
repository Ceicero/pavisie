import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import brand from '../src/data/brand.json';

// BrandWordmark is a 'use client' component and this app's tests run under plain node (no
// jsdom/RTL — see apps/dashboard/vitest.config.ts), so it can't be rendered; a plain source-text
// check is still a meaningful regression guard. This is a copy of the same component the config
// dashboard uses (apps/web/src/components/dashboard/brand-wordmark.tsx) kept here so this
// service's own placeholder page (src/app/page.tsx) — and whatever ops console replaces it —
// has a working brand mark without depending on apps/web.
const wordmarkSrc = readFileSync(
  fileURLToPath(new URL('../src/components/brand-wordmark.tsx', import.meta.url)),
  'utf8',
);

describe('BrandWordmark', () => {
  it('renders the logo path from the sync-brand-generated brand.json, not a hardcoded icon/path', () => {
    expect(wordmarkSrc).toContain('brand.json');
    expect(wordmarkSrc).toContain('brand.logo');
    expect(wordmarkSrc).not.toContain('Sparkles');
    expect(wordmarkSrc).not.toContain('lucide-react');
  });

  it('brand.json (checked in, synced by scripts/sync-brand.mjs) points at the real skull asset, not a placeholder', () => {
    expect(brand.logo).toBe('/brand/pavisie-skull.png');
  });
});
