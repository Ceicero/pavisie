#!/usr/bin/env node
// Syncs brand logos from assets/brand/ into each app's public/brand/ (ARCHITECTURE.md §22). Run automatically
// as predev/prebuild for apps/web and apps/dashboard, and manually via `pnpm brand:sync`. Never throws — a
// missing source asset is a no-op (features that reference the logo degrade gracefully, per §22) so this script
// can never fail a build.
//
// Two logos are synced:
//  - The SHARED logo — EVERY existing shared candidate (`pavisie-skull.png` AND `pavisie-skull.jpg`, not just
//    the preferred one) is copied into BOTH apps/web/public/brand/ and apps/dashboard/public/brand/. Both files
//    must be served even though the manifests' `logo` points at the preferred one (PNG): the bot's embed icon
//    URL (`${WEB_URL}/brand/pavisie-skull.jpg`, served from the web app's public/brand/) and any previously
//    cached links may still name the `.jpg` file specifically, and the dashboard sidebar and bot avatar depend on
//    this copy too — it must never be repointed at the web-only variant below.
//  - The WEB-only logo (`pavisie-skull-web.png`/`.jpg`, an optional brighter/cleaner variant) is what the public
//    website displays (header/hero/apple-icon) *only*, when present. It's resolved from web-specific candidates
//    first, falling back to the shared candidates when no web-specific file is present. On fallback nothing extra
//    is copied — the website just displays the shared file(s) already synced above. As of the skull.png/.jpg
//    unification this file is not present in the repo (the shared logo IS the clean/bright art now), so this
//    branch is currently unused in practice but stays supported for a future website-specific override.
import { copyFile, mkdir, writeFile, access, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(REPO_ROOT, 'assets', 'brand');
// PNG (lossless) takes precedence over JPG if both exist, per ARCHITECTURE.md §22.
const SHARED_CANDIDATES = ['pavisie-skull.png', 'pavisie-skull.jpg'];
// Website-only variant, checked before falling back to SHARED_CANDIDATES.
const WEB_CANDIDATES = ['pavisie-skull-web.png', 'pavisie-skull-web.jpg'];
const WEB_TARGET_DIR = join(REPO_ROOT, 'apps', 'web', 'public', 'brand');
const DASHBOARD_TARGET_DIR = join(REPO_ROOT, 'apps', 'dashboard', 'public', 'brand');
const TARGET_DIRS = [WEB_TARGET_DIR, DASHBOARD_TARGET_DIR];
// The web app's `Logo` component statically imports this copy of the manifest (same pattern as the generated
// `src/data/commands.json` / `src/data/invite.json`) so the logo path is known at build time in every
// environment, including the Docker standalone runner where `public/` isn't readable via relative fs paths from
// compiled server code. Kept byte-identical to `apps/web/public/brand/manifest.json`. `logo` is what the website
// displays (the web variant, or the shared logo on fallback); `sharedLogo` always points at the shared logo so
// the web app can reference it explicitly if it ever needs to (e.g. linking to the canonical/bot-avatar image).
const WEB_DATA_MANIFEST = join(REPO_ROOT, 'apps', 'web', 'src', 'data', 'brand.json');
// Same pattern as WEB_DATA_MANIFEST, for the dashboard's `BrandWordmark` component: a build-time copy of the
// dashboard's shared-logo manifest (`{ "logo": "/brand/pavisie-skull.png" }`), kept byte-identical to
// `apps/dashboard/public/brand/manifest.json`.
const DASHBOARD_DATA_MANIFEST = join(REPO_ROOT, 'apps', 'dashboard', 'src', 'data', 'brand.json');
// Next's `apple-icon` static-file convention (ARCHITECTURE.md §22) — written with whatever extension the source
// actually has (`.png`/`.jpg`) rather than always `.png`, so the served content-type always matches the bytes.
// Sourced from the WEB logo (the variant the website displays), not necessarily the shared logo.
const WEB_APPLE_ICON_DIR = join(REPO_ROOT, 'apps', 'web', 'src', 'app');
const APPLE_ICON_EXTENSIONS = ['png', 'jpg', 'jpeg'];

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findSourceFile(candidates) {
  for (const name of candidates) {
    const path = join(SOURCE_DIR, name);
    if (await fileExists(path)) {
      return { path, name };
    }
  }
  return null;
}

/** Like findSourceFile, but returns every matching candidate (not just the first), in candidate-preference order. */
async function findAllSourceFiles(candidates) {
  const found = [];
  for (const name of candidates) {
    const path = join(SOURCE_DIR, name);
    if (await fileExists(path)) {
      found.push({ path, name });
    }
  }
  return found;
}

/**
 * Copies every shared source file into `targetDir` (so both `.png` and `.jpg` are served, even though the
 * manifest's `logo` names only the preferred one) and writes a manifest pointing at `preferredSource`.
 */
async function syncSharedToTarget(targetDir, sources, preferredSource) {
  await mkdir(targetDir, { recursive: true });
  if (sources.length === 0) {
    // No-op: leave any previously-synced files in place, but still write a manifest that reflects reality so
    // pages can check it rather than guessing from stale files.
    await writeFile(join(targetDir, 'manifest.json'), JSON.stringify({ logo: null }, null, 2) + '\n', 'utf8');
    return;
  }
  for (const source of sources) {
    await copyFile(source.path, join(targetDir, source.name));
  }
  await writeFile(
    join(targetDir, 'manifest.json'),
    JSON.stringify({ logo: `/brand/${preferredSource.name}` }, null, 2) + '\n',
    'utf8',
  );
}

async function syncAppleIcon(webLogoSource) {
  const ext = webLogoSource ? webLogoSource.name.split('.').pop() : null;
  for (const candidateExt of APPLE_ICON_EXTENSIONS) {
    const path = join(WEB_APPLE_ICON_DIR, `apple-icon.${candidateExt}`);
    if (webLogoSource && candidateExt === ext) {
      await copyFile(webLogoSource.path, path);
    } else if (await fileExists(path)) {
      // Remove a stale apple-icon from a previous source extension so Next doesn't serve outdated art.
      await unlink(path).catch(() => {});
    }
  }
}

async function main() {
  try {
    const sharedSources = await findAllSourceFiles(SHARED_CANDIDATES);
    // SHARED_CANDIDATES is in preference order (PNG before JPG), so the first match found is the preferred one.
    const preferredSharedSource = sharedSources[0] ?? null;
    if (sharedSources.length === 0) {
      console.warn(
        `[sync-brand] No shared brand logo found in ${SOURCE_DIR} (looked for ${SHARED_CANDIDATES.join(', ')}). Skipping — this is not an error.`,
      );
    }
    // Shared logo(s) → both apps: every existing candidate is copied so both `.png` and `.jpg` URLs resolve, but
    // the manifest `logo` names only the preferred (PNG) one. This also writes apps/web/public/brand/manifest.json
    // with just the shared logo; it's overwritten below with the web-specific manifest (logo + sharedLogo).
    for (const targetDir of TARGET_DIRS) {
      await syncSharedToTarget(targetDir, sharedSources, preferredSharedSource);
    }

    // Website-only variant: prefer a dedicated web source, falling back to the shared one when absent.
    const webSpecificSource = await findSourceFile(WEB_CANDIDATES);
    const webLogoSource = webSpecificSource ?? preferredSharedSource;
    let webLogoPath = null;
    if (webSpecificSource) {
      await mkdir(WEB_TARGET_DIR, { recursive: true });
      await copyFile(webSpecificSource.path, join(WEB_TARGET_DIR, webSpecificSource.name));
      webLogoPath = `/brand/${webSpecificSource.name}`;
    } else if (preferredSharedSource) {
      // Fallback: the website just displays the shared file already synced into WEB_TARGET_DIR above.
      webLogoPath = `/brand/${preferredSharedSource.name}`;
    }
    const sharedLogoPath = preferredSharedSource ? `/brand/${preferredSharedSource.name}` : null;
    const webManifest = { logo: webLogoPath, sharedLogo: sharedLogoPath };
    const dashboardManifest = { logo: sharedLogoPath };

    await mkdir(WEB_TARGET_DIR, { recursive: true });
    await writeFile(join(WEB_TARGET_DIR, 'manifest.json'), JSON.stringify(webManifest, null, 2) + '\n', 'utf8');

    await syncAppleIcon(webLogoSource);

    await mkdir(dirname(WEB_DATA_MANIFEST), { recursive: true });
    await writeFile(WEB_DATA_MANIFEST, JSON.stringify(webManifest, null, 2) + '\n', 'utf8');

    await mkdir(dirname(DASHBOARD_DATA_MANIFEST), { recursive: true });
    await writeFile(DASHBOARD_DATA_MANIFEST, JSON.stringify(dashboardManifest, null, 2) + '\n', 'utf8');

    if (preferredSharedSource) {
      console.log(
        `[sync-brand] Synced shared logo(s) ${sharedSources.map((s) => s.name).join(', ')} to ${TARGET_DIRS.length} target(s).`,
      );
    }
    if (webSpecificSource) {
      console.log(`[sync-brand] Synced web-only logo ${webSpecificSource.name} to ${WEB_TARGET_DIR}.`);
    }
  } catch (err) {
    // Never fail a build over this — log and exit 0.
    console.warn(
      '[sync-brand] Non-fatal error while syncing brand assets:',
      err instanceof Error ? err.message : err,
    );
  }
}

await main();
