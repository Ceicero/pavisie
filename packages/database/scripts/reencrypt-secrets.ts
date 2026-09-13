// CLI: `pnpm --filter @pavisie/database reencrypt:secrets [--dry-run]`
//
// Re-encrypts every encrypted-at-rest secret in the database under the current `ENCRYPTION_KEY`.
// This is the second half of a key rotation (see docs/SECURITY.md "Incident response — leaked
// ENCRYPTION_KEY"): move the old key into `ENCRYPTION_KEY_PREVIOUS`, set a new `ENCRYPTION_KEY`,
// restart the bot/api (so new writes use the new key immediately), then run this script once to
// migrate everything written under the old key. `decryptSecret()` already falls back from
// `ENCRYPTION_KEY` to `ENCRYPTION_KEY_PREVIOUS` on decrypt, so a row that hasn't been touched by
// this script yet still decrypts fine in the meantime — this script is a cleanup pass, not a
// blocker for the rotation to take effect. Idempotent: rows already under the current key just get
// re-written with a fresh IV (harmless).
//
// Fields covered (every `*Enc` secret column/JSON-field in the schema today):
//   - OAuthToken.accessTokenEnc / OAuthToken.refreshTokenEnc
//   - WebhookEndpoint.secretEnc
//   - PluginConfig.config.apiKeyEnc  (JSON field, only present on the `ai` plugin's config)
//
// If a new encrypted field is added to the schema or to a plugin's configSchema later, add it here.
import { loadEnv, requireEnv, env, createLogger, decryptSecret, encryptSecret } from '@pavisie/core';
import { prisma } from '../src/client';

const logger = createLogger('reencrypt-secrets');

const BATCH_SIZE = 200;

interface Summary {
  scanned: number;
  reencrypted: number;
  skippedEmpty: number;
  failed: number;
}

function emptySummary(): Summary {
  return { scanned: 0, reencrypted: 0, skippedEmpty: 0, failed: 0 };
}

function mergeInto(total: Summary, part: Summary): void {
  total.scanned += part.scanned;
  total.reencrypted += part.reencrypted;
  total.skippedEmpty += part.skippedEmpty;
  total.failed += part.failed;
}

/** Re-encrypts one nullable `*Enc` string value. Returns the new ciphertext, or `undefined` if there was
 * nothing to do (null/empty) or decryption failed (logged; original value is left untouched). */
function reencryptValue(
  label: string,
  id: string,
  value: string | null | undefined,
  summary: Summary,
): string | undefined {
  if (!value) {
    summary.skippedEmpty += 1;
    return undefined;
  }
  try {
    const plain = decryptSecret(value);
    summary.reencrypted += 1;
    return encryptSecret(plain);
  } catch (err) {
    summary.failed += 1;
    logger.error(
      { table: label, id, err: err instanceof Error ? err.message : String(err) },
      'failed to decrypt value — left unchanged (neither ENCRYPTION_KEY nor ENCRYPTION_KEY_PREVIOUS could open it)',
    );
    return undefined;
  }
}

async function reencryptOAuthTokens(dryRun: boolean): Promise<Summary> {
  const summary = emptySummary();
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.oAuthToken.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, accessTokenEnc: true, refreshTokenEnc: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      summary.scanned += 1;
      const newAccess = reencryptValue('OAuthToken.accessTokenEnc', row.id, row.accessTokenEnc, summary);
      const newRefresh = reencryptValue('OAuthToken.refreshTokenEnc', row.id, row.refreshTokenEnc, summary);
      if (!dryRun && (newAccess !== undefined || newRefresh !== undefined)) {
        await prisma.oAuthToken.update({
          where: { id: row.id },
          data: {
            ...(newAccess !== undefined ? { accessTokenEnc: newAccess } : {}),
            ...(newRefresh !== undefined ? { refreshTokenEnc: newRefresh } : {}),
          },
        });
      }
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < BATCH_SIZE) break;
  }

  return summary;
}

async function reencryptWebhookEndpoints(dryRun: boolean): Promise<Summary> {
  const summary = emptySummary();
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.webhookEndpoint.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, secretEnc: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      summary.scanned += 1;
      const newSecret = reencryptValue('WebhookEndpoint.secretEnc', row.id, row.secretEnc, summary);
      if (!dryRun && newSecret !== undefined) {
        await prisma.webhookEndpoint.update({ where: { id: row.id }, data: { secretEnc: newSecret } });
      }
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < BATCH_SIZE) break;
  }

  return summary;
}

/** `PluginConfig.config` is an untyped JSON blob; only the `ai` plugin's schema currently defines an
 * encrypted field (`apiKeyEnc`). Scoped to `pluginId: 'ai'` so we never touch other plugins' JSON shapes. */
async function reencryptAiPluginConfigs(dryRun: boolean): Promise<Summary> {
  const summary = emptySummary();
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.pluginConfig.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      where: { pluginId: 'ai' },
      orderBy: { id: 'asc' },
      select: { id: true, config: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      summary.scanned += 1;
      const config = row.config as Record<string, unknown> | null;
      const apiKeyEnc = typeof config?.apiKeyEnc === 'string' ? config.apiKeyEnc : null;
      const newValue = reencryptValue('PluginConfig(ai).config.apiKeyEnc', row.id, apiKeyEnc, summary);
      if (!dryRun && newValue !== undefined && config) {
        await prisma.pluginConfig.update({
          where: { id: row.id },
          data: { config: { ...config, apiKeyEnc: newValue } },
        });
      }
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < BATCH_SIZE) break;
  }

  return summary;
}

async function main(): Promise<void> {
  loadEnv();
  requireEnv('DATABASE_URL', 'ENCRYPTION_KEY');

  const dryRun = process.argv.includes('--dry-run');
  if (!env.ENCRYPTION_KEY_PREVIOUS) {
    logger.warn(
      'ENCRYPTION_KEY_PREVIOUS is not set. Rows still encrypted under an old key will fail to decrypt below. ' +
        'If you are mid-rotation, set ENCRYPTION_KEY_PREVIOUS to the old key first.',
    );
  }
  logger.info({ dryRun }, 'starting secret re-encryption pass');

  const total = emptySummary();
  mergeInto(total, await reencryptOAuthTokens(dryRun));
  mergeInto(total, await reencryptWebhookEndpoints(dryRun));
  mergeInto(total, await reencryptAiPluginConfigs(dryRun));

  logger.info(
    { ...total, dryRun },
    dryRun
      ? 'dry run complete — no rows were written'
      : total.failed > 0
        ? 're-encryption complete with failures — see errors above; those rows were left unchanged'
        : 're-encryption complete',
  );

  await prisma.$disconnect();
  if (total.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'reencrypt-secrets failed');
  process.exitCode = 1;
});
