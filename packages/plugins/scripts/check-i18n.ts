#!/usr/bin/env tsx
// `pnpm --filter @pavisie/plugins check:i18n` (root alias could call this per-package) — walks every plugin's
// `src/**/*.ts` for `t('key')` / `c.t('key')` call sites and verifies each key literal actually resolves to a
// registered translation, simulating the exact runtime lookup in `packages/core/src/i18n/index.ts`'s `t()` +
// `packages/plugins/src/sdk/locales.ts`'s `registerPluginLocales` (plugin-prefixed lookup first, then a
// core-namespace fallback) rather than just checking the literal string exists somewhere. A key that "looks"
// registered but is looked up under the wrong path (e.g. a stray command-group prefix that doesn't match the
// bundle's actual shape) resolves to nothing at runtime — Discord would just show the user the raw key string —
// and this script is the only thing that would ever catch that.
//
// Also verifies every plugin listed in `allManifests` (the canonical id list, ARCHITECTURE.md §7.1) has
// registered a `locales/en.json` bundle at all, per CLAUDE.md's i18n audit requirement.
//
// Run with: pnpm --filter @pavisie/plugins check:i18n
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allManifests } from '../src/manifests';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(SCRIPT_DIR, '..', 'src');
const CORE_LOCALE_PATH = join(SCRIPT_DIR, '..', '..', 'core', 'src', 'i18n', 'locales', 'en.json');

const IGNORED_DIR_NAMES = new Set(['__tests__', 'node_modules', 'dist']);

type FlatBundle = Set<string>;

/** Mirrors `packages/core/src/i18n/index.ts`'s `flatten()` — nested objects become dot-joined leaf keys. */
function flattenKeys(obj: Record<string, unknown>, prefix = '', out: FlatBundle = new Set()): FlatBundle {
  for (const [key, value] of Object.entries(obj)) {
    const flatKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenKeys(value as Record<string, unknown>, flatKey, out);
    } else {
      out.add(flatKey);
    }
  }
  return out;
}

function loadBundle(path: string): FlatBundle {
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return flattenKeys(json);
}

/** Recursively lists `.ts` files under `dir`, skipping test/build-artifact directories. */
function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface CallSite {
  key: string;
  line: number;
}

/**
 * Replaces `//` and `/* *\/` comment bodies with spaces (preserving length/line numbers, so this script never
 * mistakes a `t('example.key', ...)` written in a doc comment for a real call site). String/template literals
 * are tracked so a `//` or `/*` inside a string doesn't get misread as a comment start.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      out += '  ';
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
        } else {
          out += source[i];
          i += 1;
        }
      }
      out += source[i] ?? '';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Extracts every string-literal argument that occupies the "key" position of a `t(...)` / `c.t(...)` call —
 * the literal directly after the opening `(`, or directly after a top-level `?`/`:` (so ternaries like
 * `t(cond ? 'a' : 'b')` yield both branches). A literal encountered anywhere else at depth 1 — e.g. the
 * `'MUTE'` in `t(decision === 'MUTE' ? 'mute.muted' : 'mute.unmuted')` — is a comparison operand, not a key,
 * and is correctly skipped because it doesn't immediately follow one of those anchors. Once a top-level `,`
 * is reached the key slot is over (whatever follows is the `vars`/`locale` argument). Dynamic keys (template
 * literals with interpolation, bare identifiers, member expressions) are silently skipped — this script can
 * only check what's statically knowable, same as any other string-literal lint.
 */
function extractCallSites(commentFreeSource: string): CallSite[] {
  const source = commentFreeSource;
  const sites: CallSite[] = [];
  const callStart = /\bt\(/g;
  let match: RegExpExecArray | null;

  while ((match = callStart.exec(source))) {
    const argsStart = match.index + match[0].length;
    let i = argsStart;
    let depth = 1; // depth of the already-consumed opening '(' of this t( call
    let awaitingKey = true; // true right after '(', '?', or ':' at depth 1
    let keySlotOpen = true; // false once a top-level ',' is seen (past the key into vars/locale args)
    const literals: string[] = [];

    while (i < source.length && depth > 0) {
      const ch = source[i];

      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        i += 1;
        continue;
      }
      if (depth === 1 && ch === ',') {
        keySlotOpen = false;
        i += 1;
        continue;
      }
      if (depth === 1 && (ch === '?' || ch === ':')) {
        awaitingKey = keySlotOpen;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        let j = i + 1;
        let content = '';
        let hasInterpolation = false;
        while (j < source.length && source[j] !== quote) {
          if (source[j] === '\\') {
            content += source[j] + (source[j + 1] ?? '');
            j += 2;
          } else {
            if (quote === '`' && source[j] === '$' && source[j + 1] === '{') hasInterpolation = true;
            content += source[j];
            j += 1;
          }
        }
        if (depth === 1 && keySlotOpen && awaitingKey && !hasInterpolation) literals.push(content);
        if (depth === 1) awaitingKey = false;
        i = j + 1;
        continue;
      }
      if (depth === 1 && !/\s/.test(ch)) {
        // Any other non-whitespace token at the key's depth (an identifier, operator, etc.) means whatever
        // comes right after isn't sitting in key position anymore, until the next '?'/':' resets it.
        awaitingKey = false;
      }
      i += 1;
    }

    const line = source.slice(0, match.index).split('\n').length;
    for (const key of literals) {
      if (key.length > 0) sites.push({ key, line });
    }
  }

  return sites;
}

function main(): void {
  const coreKeys = loadBundle(CORE_LOCALE_PATH);
  const bundlesByNs = new Map<string, FlatBundle>([['core', coreKeys]]);

  const pluginDirs = readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !IGNORED_DIR_NAMES.has(e.name) && e.name !== 'sdk')
    .map((e) => e.name);

  const manifestIds = new Set(allManifests.map((m) => m.id));
  const missingBundle: string[] = [];

  for (const id of manifestIds) {
    const localePath = join(SRC_DIR, id, 'locales', 'en.json');
    if (!existsSync(localePath)) {
      missingBundle.push(id);
      continue;
    }
    bundlesByNs.set(id, loadBundle(localePath));
  }

  // A plugin directory without a matching PluginId (shouldn't happen, but don't silently ignore it either).
  for (const dir of pluginDirs) {
    if (
      !manifestIds.has(dir as (typeof allManifests)[number]['id']) &&
      existsSync(join(SRC_DIR, dir, 'locales', 'en.json'))
    ) {
      bundlesByNs.set(dir, loadBundle(join(SRC_DIR, dir, 'locales', 'en.json')));
    }
  }

  /** Simulates `registerPluginLocales`'s `boundT` + core `t()` resolution — true if `key` resolves to real copy. */
  function resolves(ns: string | null, key: string): boolean {
    if (ns && bundlesByNs.get(ns)?.has(key)) return true; // plugin-prefixed lookup: `${ns}.${key}` -> ns bundle, path=key
    // Fallback: core `t(key)` — key's own first segment used as namespace if it's a registered one, else 'core'.
    const firstDot = key.indexOf('.');
    if (firstDot !== -1) {
      const candidateNs = key.slice(0, firstDot);
      const rest = key.slice(firstDot + 1);
      if (bundlesByNs.has(candidateNs)) {
        return bundlesByNs.get(candidateNs)!.has(rest);
      }
    }
    return coreKeys.has(key);
  }

  const files = walkTsFiles(SRC_DIR);
  let totalCallSites = 0;
  let filesWithCalls = 0;
  const missing: { file: string; line: number; key: string }[] = [];

  for (const file of files) {
    const rel = relative(SRC_DIR, file).split('\\').join('/');
    const topSegment = rel.split('/')[0];
    const ns = bundlesByNs.has(topSegment) ? topSegment : null;

    const source = readFileSync(file, 'utf8');
    const sites = extractCallSites(stripComments(source));
    if (sites.length > 0) filesWithCalls += 1;
    totalCallSites += sites.length;

    for (const site of sites) {
      if (!resolves(ns, site.key)) {
        missing.push({ file: rel, line: site.line, key: site.key });
      }
    }
  }

  console.log(`Plugins in registry: ${manifestIds.size}`);
  console.log(`Plugins with locales/en.json: ${manifestIds.size - missingBundle.length}/${manifestIds.size}`);
  if (missingBundle.length > 0) {
    console.log(`  Missing locale bundle: ${missingBundle.join(', ')}`);
  }
  console.log(`Files scanned: ${files.length} (${filesWithCalls} with t()/c.t() calls)`);
  console.log(`t()/c.t() call sites with a static key: ${totalCallSites}`);
  console.log(`Unresolvable keys: ${missing.length}`);

  if (missing.length > 0) {
    console.log('');
    for (const m of missing) {
      console.log(`  ${m.file}:${m.line} — '${m.key}' does not resolve to any registered translation`);
    }
  }

  if (missingBundle.length > 0 || missing.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error('check-i18n failed:', err);
  process.exitCode = 1;
}
