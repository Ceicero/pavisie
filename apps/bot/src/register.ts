// CLI: `pnpm --filter @pavisie/bot register [--global | --guild <id> | --clear]`
// Registers (or clears) this platform's slash/context-menu commands with Discord via the bulk-overwrite REST
// endpoint (ARCHITECTURE.md §9). Run this whenever commands are added, renamed, or removed — Discord does not
// pick up command changes automatically.
import { loadEnv, requireEnv, env, createLogger } from '@pavisie/core';
import { allPlugins, PluginRegistry } from '@pavisie/plugins';
import { describeTarget, registerCommands } from './host/register-commands';

interface ParsedArgs {
  global: boolean;
  guildId: string | null;
  clear: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let global = false;
  let guildId: string | null = null;
  let clear = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--global') {
      global = true;
    } else if (arg === '--guild') {
      guildId = argv[i + 1] ?? null;
      i += 1;
      if (!guildId) {
        throw new Error('--guild requires a guild id argument, e.g. --guild 123456789012345678');
      }
    } else if (arg === '--clear') {
      clear = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag "${arg}". Supported flags: --global, --guild <id>, --clear.`);
    }
  }

  if (global && guildId) {
    throw new Error('Pass either --global or --guild <id>, not both.');
  }

  return { global, guildId, clear };
}

/** Resolves the effective registration target: an explicit flag wins, else `DEV_GUILD_ID` if set, else global. */
function resolveTarget(args: ParsedArgs): { scope: 'global' } | { scope: 'guild'; guildId: string } {
  if (args.global) return { scope: 'global' };
  if (args.guildId) return { scope: 'guild', guildId: args.guildId };
  if (env.DEV_GUILD_ID) return { scope: 'guild', guildId: env.DEV_GUILD_ID };
  return { scope: 'global' };
}

function printSummaryTable(commands: { name: string; type: number }[]): void {
  const typeLabel = (type: number): string =>
    type === 1 ? 'slash' : type === 2 ? 'user-menu' : type === 3 ? 'message-menu' : `type-${type}`;
  const nameWidth = Math.max(4, ...commands.map((c) => c.name.length));
  // eslint-disable-next-line no-console -- this is a CLI tool; its whole job is to print a summary to stdout.
  console.log(`${'NAME'.padEnd(nameWidth)}  TYPE`);
  for (const command of commands) {
    // eslint-disable-next-line no-console
    console.log(`${command.name.padEnd(nameWidth)}  ${typeLabel(command.type)}`);
  }
}

async function main(): Promise<void> {
  loadEnv();
  requireEnv('DISCORD_TOKEN', 'DISCORD_CLIENT_ID');

  const logger = createLogger('register');
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args);

  const registry = new PluginRegistry(allPlugins);
  const targetDescription = describeTarget(target);
  logger.info(
    { target, commandCount: args.clear ? 0 : registry.commandsJson().length, clear: args.clear },
    `${args.clear ? 'Clearing' : 'Registering'} commands ${targetDescription}`,
  );

  const result = await registerCommands({
    token: env.DISCORD_TOKEN as string,
    clientId: env.DISCORD_CLIENT_ID as string,
    registry,
    target,
    clear: args.clear,
  });

  if (result.cleared) {
    // eslint-disable-next-line no-console
    console.log(`Cleared all commands ${targetDescription}.`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`Registered ${result.commands.length} command(s) ${targetDescription}:\n`);
    printSummaryTable(result.commands);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // no-console: `error`/`warn` are allowed by the root eslint config. Fatal CLI failure; must be visible even
    // if the logger transport fails.
    console.error('Command registration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
