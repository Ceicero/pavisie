import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * `output: 'standalone'` is what the Docker image consumes (ARCHITECTURE.md §14) and is the default on every
 * Linux/macOS host (CI, Docker, Railway). Next's standalone file-tracing step recreates pnpm's symlinked
 * node_modules layout with real symlinks, which Windows only permits when Developer Mode /
 * SeCreateSymbolicLinkPrivilege is enabled — so on win32 dev machines we fall back to a regular build.
 * Set NEXT_OUTPUT_STANDALONE=true|false to force either behaviour explicitly.
 */
function useStandaloneOutput(): boolean {
  const forced = process.env.NEXT_OUTPUT_STANDALONE;
  if (forced === 'true') return true;
  if (forced === 'false') return false;
  return process.platform !== 'win32';
}

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig: NextConfig = {
  transpilePackages: ['@pavisie/ui', '@pavisie/types'],
  ...(useStandaloneOutput() ? { output: 'standalone' as const } : {}),
  // Trace files from the workspace root so the standalone bundle includes hoisted workspace deps and
  // lands at .next/standalone/apps/dashboard/server.js (what Dockerfile.dashboard's CMD expects).
  outputFileTracingRoot: monorepoRoot,
  reactStrictMode: true,
  // The per-guild config dashboard that used to live on this service moved to apps/web
  // (pavisie.com/dashboard/**). These two redirects are deliberately path-scoped, NOT a
  // blanket catch-all: bookmarks, the Top.gg listing, and a live Reddit post point at
  // app.pavisie.com/dashboard/... and must keep resolving, but this service is also going to
  // host an owner-only ops console on a separate domain (dev.pavisie.com) next. A wildcard
  // redirect here would swallow those future /ops/... routes too, so only the two path families
  // that actually used to be served here are redirected — everything else (e.g. `/`'s
  // placeholder today, `/ops/...` later) falls through to this app normally.
  async redirects() {
    // `redirects()` is evaluated at BUILD time and baked into the route manifest — it is never re-read at
    // runtime, so a missing WEB_URL cannot be corrected by setting the variable and restarting; it needs a
    // rebuild. That makes the fallback safety-critical: this shipped once with a localhost fallback and sent
    // real app.pavisie.com traffic to http://localhost:3003. So the fallback is environment-aware and
    // fails SAFE — production defaults to the real site, and only non-production falls back to the web app's
    // local dev URL so running this service locally never bounces `/` off to the live domain.
    const fallback = process.env.NODE_ENV === 'production' ? 'https://pavisie.com' : 'http://localhost:3003';
    const target = (process.env.WEB_URL ?? fallback).replace(/\/+$/, '');
    return [
      { source: '/', destination: target, permanent: true },
      { source: '/dashboard', destination: `${target}/dashboard`, permanent: true },
      { source: '/dashboard/:path*', destination: `${target}/dashboard/:path*`, permanent: true },
    ];
  },
};

export default nextConfig;
