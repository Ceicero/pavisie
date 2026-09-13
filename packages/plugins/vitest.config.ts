import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/__tests__/*.test.ts'],
    // A handful of files can't statically import `@pavisie/core` (its `env` is computed once at first import,
    // so `process.env` must be populated before it loads) and pull it in via `await import(...)` inside
    // `beforeAll`, which makes those hooks transform the module graph at hook time. `pnpm test` runs every
    // workspace in parallel, and under that contention this suite's cumulative collect time roughly doubles
    // (265s standalone -> 497s), pushing such hooks past the vitest defaults (5s/10s):
    // twitch-chat-tts.test.ts failed with "Hook timed out in 10000ms" yet passes in 1.3s in isolation. These
    // are spurious timeouts, not real failures.
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
