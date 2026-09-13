import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import brand from '../src/data/brand.json';

// Same source-text convention as root-page.test.ts / nav.test.ts: BrandWordmark is a 'use client'
// component and this app's tests run under plain node (no jsdom/RTL), so it can't be rendered.
const wordmarkSrc = readFileSync(
  fileURLToPath(new URL('../src/components/dashboard/brand-wordmark.tsx', import.meta.url)),
  'utf8',
);

describe('BrandWordmark (sidebar logo)', () => {
  it('renders the logo path from the sync-brand-generated brand.json, not a hardcoded icon/path', () => {
    expect(wordmarkSrc).toContain('brand.json');
    expect(wordmarkSrc).toContain('brand.logo');
    expect(wordmarkSrc).not.toContain('Sparkles');
    expect(wordmarkSrc).not.toContain('lucide-react');
  });

  it('is what app-sidebar.tsx renders as the sidebar header, not a one-off logo box', () => {
    const sidebarSrc = readFileSync(
      fileURLToPath(new URL('../src/components/dashboard/app-sidebar.tsx', import.meta.url)),
      'utf8',
    );
    expect(sidebarSrc).toContain('BrandWordmark');
    expect(sidebarSrc).not.toContain('Sparkles');
  });

  it('brand.json (checked in, synced by scripts/sync-brand.mjs) points at the real skull asset, not a placeholder', () => {
    expect(brand.logo).toBe('/brand/pavisie-skull.png');
  });
});
