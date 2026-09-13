import { defineConfig } from 'vitest/config';

/** Vitest config for `@pavisie/ui`. Needs jsdom (not the workspace-default `node` env) because
 * these are React component render tests. */
export default defineConfig({
  test: {
    environment: 'jsdom',
  },
});
