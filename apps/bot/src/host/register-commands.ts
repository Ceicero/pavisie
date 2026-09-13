// Shared command-registration helper used by the `register` CLI (src/register.ts) and by the bot at boot when
// REGISTER_COMMANDS_ON_BOOT is enabled (ARCHITECTURE.md §9). Bulk-overwrites the application's commands via REST.
import { REST, Routes } from 'discord.js';
import type { PluginRegistry } from '@pavisie/plugins';

export type RegisterTarget = { scope: 'global' } | { scope: 'guild'; guildId: string };

export interface RegisterCommandsOptions {
  token: string;
  clientId: string;
  registry: PluginRegistry;
  target: RegisterTarget;
  /** When true, removes every command for the target instead of registering. */
  clear?: boolean;
}

export interface RegisterCommandsResult {
  target: RegisterTarget;
  cleared: boolean;
  commands: { name: string; type: number }[];
}

/** Human-readable description of a registration target, for logs. */
export function describeTarget(target: RegisterTarget): string {
  return target.scope === 'guild'
    ? `guild ${target.guildId} (instant)`
    : 'globally (may take up to an hour to propagate)';
}

/** Registers (or clears) all plugin commands with Discord for the given target. Throws on API failure. */
export async function registerCommands(opts: RegisterCommandsOptions): Promise<RegisterCommandsResult> {
  const commands = opts.clear ? [] : opts.registry.commandsJson();
  const rest = new REST({ version: '10' }).setToken(opts.token);
  const route =
    opts.target.scope === 'guild'
      ? Routes.applicationGuildCommands(opts.clientId, opts.target.guildId)
      : Routes.applicationCommands(opts.clientId);
  const result = (await rest.put(route, { body: commands })) as { name: string; type: number }[];
  return {
    target: opts.target,
    cleared: Boolean(opts.clear),
    commands: result.map((c) => ({ name: c.name, type: c.type })),
  };
}
