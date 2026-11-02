// Next.js calls `register()` once when the server process starts (not per request, and not in the browser).
// It is the one place a Next app can fail fast on a bad environment, mirroring the bot and api startup check.
export async function register(): Promise<void> {
  // The check is Node-only (the edge runtime has no process.exit), so skip it there.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // `next build` can load this file while collecting page data. CI and the Docker build run without the
  // deployment's runtime variables, so only validate when the server is actually starting.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { assertServiceEnv } = await import('@pavisie/core/service-env');
  assertServiceEnv('web');
}
