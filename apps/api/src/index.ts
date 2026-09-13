import { createLogger, env, loadEnv, requireEnv } from '@pavisie/core';
import { buildApp } from './app';

loadEnv();
requireEnv(
  'DATABASE_URL',
  'REDIS_URL',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'DISCORD_OAUTH_REDIRECT_URI',
  'DASHBOARD_URL',
);

const log = createLogger('api-bootstrap');

async function main(): Promise<void> {
  const app = await buildApp();
  const port = env.API_PORT ?? 3001;

  try {
    await app.listen({ port, host: '0.0.0.0' });
    log.info({ port }, 'Pavisie API listening');
  } catch (err) {
    app.log.error({ err }, 'Failed to start API');
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down API');
    try {
      await app.close();
      log.info('API shut down cleanly');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ err }, 'Fatal error during API startup');
  process.exit(1);
});
