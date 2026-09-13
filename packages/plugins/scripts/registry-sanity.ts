// One-off sanity check (wiring stage, ARCHITECTURE.md §17): constructs the real `PluginRegistry` from
// `allPlugins` and reports (1) total top-level application commands (Discord's hard cap is 100 per app),
// (2) the largest number of leaf subcommands under any single top-level command (Discord's hard cap is 25
// per command/group), and (3) any duplicate `<pluginId>:<action>` customId prefix (the string the router's
// `parseCustomId` splits on to dispatch a component/modal interaction to the right plugin+handler).
// `PluginRegistry`'s own constructor already throws on a duplicate plugin id or a duplicate `action` name
// *within* one plugin's `components` array (packages/plugins/src/sdk/registry.ts), which structurally rules
// out a real collision (pluginId is unique, so `pluginId:action` can never repeat) — this script recomputes
// it independently anyway, as a standalone check that doesn't rely on trusting that validation logic.
// Run with: pnpm --filter @pavisie/plugins exec tsx scripts/registry-sanity.ts
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord-api-types/v10';
import { allPlugins } from '../src/index';
import { PluginRegistry } from '../src/sdk/registry';

const TOP_LEVEL_COMMAND_LIMIT = 100;
const SUBCOMMAND_LIMIT = 25;

// Discord ApplicationCommandOptionType: 1 = SUB_COMMAND, 2 = SUB_COMMAND_GROUP.
function countLeafSubcommands(command: RESTPostAPIApplicationCommandsJSONBody): number {
  let count = 0;
  for (const option of (command as { options?: { type: number; options?: { type: number }[] }[] }).options ??
    []) {
    if (option.type === 1) {
      count += 1;
    } else if (option.type === 2) {
      count += option.options?.filter((o) => o.type === 1).length ?? 0;
    }
  }
  return count;
}

function main(): void {
  const registry = new PluginRegistry(allPlugins);
  const commands = registry.commandsJson();

  const topLevelCount = commands.length;
  let maxSubcommands = 0;
  let maxSubcommandsOwner = '(none — no command has subcommands)';
  for (const command of commands) {
    const leafCount = countLeafSubcommands(command);
    if (leafCount > maxSubcommands) {
      maxSubcommands = leafCount;
      maxSubcommandsOwner = `/${command.name}`;
    }
  }

  const customIdPrefixOwners = new Map<string, string[]>();
  for (const plugin of registry.list()) {
    for (const component of plugin.components ?? []) {
      const prefix = `${plugin.manifest.id}:${component.action}`;
      const owners = customIdPrefixOwners.get(prefix) ?? [];
      owners.push(plugin.manifest.id);
      customIdPrefixOwners.set(prefix, owners);
    }
  }
  const collisions = [...customIdPrefixOwners.entries()].filter(([, owners]) => owners.length > 1);

  const commandLimitOk = topLevelCount <= TOP_LEVEL_COMMAND_LIMIT;
  const subcommandLimitOk = maxSubcommands <= SUBCOMMAND_LIMIT;
  const noCollisions = collisions.length === 0;

  console.log(`Plugins loaded: ${registry.list().length}`);
  console.log(
    `Top-level commands: ${topLevelCount} (limit ${TOP_LEVEL_COMMAND_LIMIT}) — ${commandLimitOk ? 'OK' : 'VIOLATION'}`,
  );
  console.log(
    `Max subcommands under one top-level command: ${maxSubcommands} on "${maxSubcommandsOwner}" (limit ${SUBCOMMAND_LIMIT}) — ${
      subcommandLimitOk ? 'OK' : 'VIOLATION'
    }`,
  );
  console.log(
    `customId prefix ("pluginId:action") collisions: ${noCollisions ? 'none' : JSON.stringify(collisions)}`,
  );

  if (!commandLimitOk || !subcommandLimitOk || !noCollisions) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error('registry-sanity failed:', err);
  process.exitCode = 1;
}
