import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every <Switch> (Radix button[role=switch], no built-in label) must have an accessible name,
 * otherwise screen readers just announce "switch, off".
 */

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Files that still contain unnamed switches. They are owned by other workstreams and are left
 * for their owners to fix; remove an entry once its file is fixed (the staleness check below
 * fails if an entry no longer has an unnamed switch).
 */
const KNOWN_UNLABELED = [
  'components/dashboard/automod/rule-config-fields.tsx',
  'components/dashboard/automod/rule-form-dialog.tsx',
  'components/dashboard/automod/settings-tab.tsx',
  'components/dashboard/enforcer/policies-tab.tsx',
  'components/dashboard/enforcer/settings-tab.tsx',
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

/** Returns the source text of each `<Switch ... />` element, tracking braces so `=>` / `/>` inside props are safe. */
function switchTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<Switch\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let i = m.index + m[0].length;
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '/' && source[i + 1] === '>' && depth === 0) break;
      i++;
    }
    tags.push(source.slice(m.index, i + 2));
  }
  return tags;
}

const ARIA_NAMED = /\b(aria-label|aria-labelledby)=/;
const STATIC_ID = /\bid="([^"]+)"/;

/** Named by aria-label/aria-labelledby, or by a static `id` that a `htmlFor` in the same file points at. */
function isNamed(tag: string, source: string): boolean {
  if (ARIA_NAMED.test(tag)) return true;
  const id = STATIC_ID.exec(tag)?.[1];
  return id !== undefined && source.includes(`htmlFor="${id}"`);
}

const files = walk(SRC_DIR).map((f) => ({
  rel: relative(SRC_DIR, f).split('\\').join('/'),
  source: readFileSync(f, 'utf8'),
}));

function unnamedCount(source: string): number {
  return switchTags(source).filter((t) => !isNamed(t, source)).length;
}

describe('Dashboard switches — accessible names', () => {
  it('finds switches to check', () => {
    expect(files.reduce((n, f) => n + switchTags(f.source).length, 0)).toBeGreaterThan(20);
  });

  it('every <Switch> has aria-label, aria-labelledby or a label pointing at its id', () => {
    const offenders = files
      .filter((f) => !KNOWN_UNLABELED.includes(f.rel))
      .filter((f) => unnamedCount(f.source) > 0)
      .map((f) => `${f.rel} (${unnamedCount(f.source)} unnamed)`);
    expect(offenders).toEqual([]);
  });

  it('KNOWN_UNLABELED entries still contain an unnamed switch (allowlist is not stale)', () => {
    for (const rel of KNOWN_UNLABELED) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} should exist`).toBeTruthy();
      expect(unnamedCount(file!.source), `${rel} no longer has unnamed switches; remove it`).toBeGreaterThan(
        0,
      );
    }
  });
});
