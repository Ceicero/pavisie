// CLI: `pnpm --filter @pavisie/bot set-avatar [--file <path>]`
// One-off tool to set the bot's Discord avatar to the brand logo (ARCHITECTURE.md §22). Logs in with no gateway
// intents (just enough to authenticate as the application's bot user), uploads the image, then logs out.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'discord.js';
import { loadEnv, requireEnv, env, createLogger } from '@pavisie/core';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const DEFAULT_CANDIDATES = ['assets/brand/pavisie-skull.png', 'assets/brand/pavisie-skull.jpg'];

interface ParsedArgs {
  file: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') {
      file = argv[i + 1] ?? null;
      i += 1;
      if (!file) {
        throw new Error('--file requires a path argument, e.g. --file assets/brand/pavisie-skull.png');
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag "${arg}". Supported flags: --file <path>.`);
    }
  }
  return { file };
}

/** Resolves the avatar file to upload: an explicit `--file` wins, else the first existing default candidate. */
async function resolveAvatarPath(args: ParsedArgs): Promise<string> {
  if (args.file) {
    return path.isAbsolute(args.file) ? args.file : path.join(REPO_ROOT, args.file);
  }
  for (const candidate of DEFAULT_CANDIDATES) {
    const candidatePath = path.join(REPO_ROOT, candidate);
    try {
      await readFile(candidatePath);
      return candidatePath;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `No brand logo file found (looked for ${DEFAULT_CANDIDATES.join(', ')}). Pass --file <path> explicitly, or add ` +
      `assets/brand/pavisie-skull.png (see assets/brand/README.md).`,
  );
}

async function main(): Promise<void> {
  loadEnv();
  requireEnv('DISCORD_TOKEN');

  const logger = createLogger('set-avatar');
  const args = parseArgs(process.argv.slice(2));
  const avatarPath = await resolveAvatarPath(args);

  logger.info({ avatarPath }, 'Reading avatar file');
  const buffer = await readFile(avatarPath);

  logger.warn(
    'Discord rate-limits avatar changes to a small number per hour per application. If this fails with a rate ' +
      'limit error, wait and retry later rather than running this repeatedly.',
  );

  // No intents needed — this only touches the application's own user profile via REST-backed client methods.
  const client = new Client({ intents: [] });

  try {
    await client.login(env.DISCORD_TOKEN as string);
    if (!client.user) {
      throw new Error('Logged in but client.user is unavailable.');
    }
    await client.user.setAvatar(buffer);
    logger.info({ tag: client.user.tag, avatarPath }, 'Bot avatar updated');
    // eslint-disable-next-line no-console -- CLI summary output, not app logging
    console.log(`Set avatar for ${client.user.tag} from ${avatarPath}.`);
  } finally {
    await client.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // no-console: fatal CLI failure must be visible even if the logger transport fails.
    console.error('set-avatar failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
