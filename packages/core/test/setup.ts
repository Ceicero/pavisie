import { randomBytes } from 'node:crypto';

// Runs before any test file's own imports are evaluated, so `@pavisie/core`'s `env` singleton
// (computed at module-import time) picks these up. Values are disposable test-only secrets.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
process.env.ENCRYPTION_KEY_PREVIOUS =
  process.env.ENCRYPTION_KEY_PREVIOUS ?? randomBytes(32).toString('base64');
