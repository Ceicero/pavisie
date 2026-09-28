// Builds `dist/` — exactly the files to zip and upload to the Twitch dev console. Two steps: compile
// `src/*.ts` to browser-native ES module JS (via a dedicated `tsconfig.build.json`, kept separate from the
// `tsconfig.json` used by `typecheck` so `--noEmit` stays the default for editors/CI type-checking), then copy
// the static `public/*` files (html/css) alongside the compiled JS. Plain Node, no bundler — matches the
// "no framework, no bundler dependency" requirement (Twitch's extension review disallows bundler-introduced
// script patterns it can't statically verify).

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const distDir = path.join(root, 'dist');
const publicDir = path.join(root, 'public');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// 1. Compile TypeScript -> dist/*.js (ES2022 modules, matching panel.html's <script type="module">). Spawn
// Node directly on `typescript`'s own JS entry point (via `require.resolve`) rather than the `tsc`/`tsc.cmd`
// shim in `node_modules/.bin` — the `.cmd` batch-file wrapper Windows uses there needs a shell to execute,
// and running through a shell means quoting/escaping the args ourselves. Resolving the real script and
// running it with `process.execPath` works identically on every OS, no shell involved.
const require = createRequire(import.meta.url);
const tscScript = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tscScript, '-p', path.join(root, 'tsconfig.build.json')], {
  stdio: 'inherit',
  cwd: root,
});

// 2. Copy static assets (html/css) from public/ into dist/, flat — panel.html references `panel.css` and
// `panel.js` as plain relative filenames, so everything the extension needs lives at the top of dist/.
for (const entry of readdirSync(publicDir)) {
  cpSync(path.join(publicDir, entry), path.join(distDir, entry));
}

console.log(`Built ${path.relative(process.cwd(), distDir)}/:`);
for (const entry of readdirSync(distDir).sort()) {
  console.log(`  ${entry}`);
}
