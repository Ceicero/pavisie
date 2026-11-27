import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Decorative lucide icons passed as EmptyState `icon=` must be hidden from assistive tech
 * (`aria-hidden="true"`), matching the threats empty state in #87.
 */

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/** Paths relative to `apps/web/src`. Analytics is waiting on Brandon; the #93 panels tab is out of scope. */
const EXCLUDED: string[] = [
  'app/dashboard/[guildId]/analytics/page.tsx',
  'components/dashboard/roles/panels-tab.tsx',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function lucideNames(source: string): string[] {
  const names: string[] = [];
  const re = /import\s*\{([^}]+)\}\s*from 'lucide-react'/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    for (const raw of m[1].split(',')) {
      const part = raw.replace(/\/\/.*$/, '').trim();
      if (!part) continue;
      const ident = part
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (ident) names.push(ident);
    }
  }
  return names;
}

/** Opening tags of each `<EmptyState ...>` / `<EmptyState ... />`. Tracks braces and quotes. */
function emptyStateTags(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const tags: string[] = [];
  const re = /<EmptyState(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < code.length; i++) {
      const c = code[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(code.slice(m.index, i + 1));
  }
  return tags;
}

function iconProp(tag: string): string | undefined {
  const start = tag.search(/\bicon=/);
  if (start === -1) return undefined;
  const after = tag.slice(start + 'icon='.length);
  if (!after.startsWith('{')) return after.trim();
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < after.length; i++) {
    const c = after[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return after.slice(0, i + 1);
    }
  }
  return after;
}

const files = walk(SRC_DIR).map((f) => ({
  rel: relative(SRC_DIR, f).split('\\').join('/'),
  source: readFileSync(f, 'utf8'),
}));

describe('Dashboard EmptyState icons — aria-hidden', () => {
  it('finds EmptyState icons to check, including the #87 threats panel', () => {
    const withIcon = files.flatMap((f) =>
      emptyStateTags(f.source).filter((tag) => iconProp(tag) !== undefined),
    );
    expect(withIcon.length).toBeGreaterThan(0);
    const threats = files.find((f) => f.rel === 'components/dashboard/threats/live-incidents-panel.tsx');
    expect(threats).toBeDefined();
    const threatTags = emptyStateTags(threats!.source);
    expect(threatTags.some((tag) => iconProp(tag)?.includes('ShieldAlert'))).toBe(true);
    expect(threatTags.some((tag) => iconProp(tag)?.includes('aria-hidden="true"'))).toBe(true);
  });

  it('every EmptyState lucide icon is aria-hidden, except the excluded files', () => {
    const missing: string[] = [];
    for (const file of files) {
      if (EXCLUDED.includes(file.rel)) continue;
      const names = lucideNames(file.source);
      if (names.length === 0) continue;
      for (const tag of emptyStateTags(file.source)) {
        const icon = iconProp(tag);
        if (!icon) continue;
        const usesLucide = names.some((name) => new RegExp(`\\b${name}\\b`).test(icon));
        if (!usesLucide) continue;
        if (!icon.includes('aria-hidden')) {
          missing.push(`${file.rel} :: ${icon.replace(/\s+/g, ' ').trim()}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('excluded files exist, and the analytics page still has an unhidden Lock icon', () => {
    for (const rel of EXCLUDED) {
      expect(
        files.some((f) => f.rel === rel),
        `${rel} should exist`,
      ).toBe(true);
    }
    const analytics = files.find((f) => f.rel === 'app/dashboard/[guildId]/analytics/page.tsx');
    expect(analytics).toBeDefined();
    const names = lucideNames(analytics!.source);
    const unhidden = emptyStateTags(analytics!.source).some((tag) => {
      const icon = iconProp(tag);
      if (!icon) return false;
      const usesLucide = names.some((name) => new RegExp(`\\b${name}\\b`).test(icon));
      return usesLucide && !icon.includes('aria-hidden');
    });
    expect(unhidden, 'analytics empty-state Lock is now hidden; drop the page from EXCLUDED').toBe(true);
  });
});
