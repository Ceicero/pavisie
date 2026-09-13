#!/usr/bin/env tsx
// `pnpm --filter @pavisie/plugins export:commands` (root alias: `pnpm commands:export`) — walks `allPlugins`
// and emits a plain-JSON description of every command, generated from the real plugin registry so the website's
// command docs (ARCHITECTURE.md §17) can never drift from what the bot actually registers.
//
// Deterministic output (no timestamps, stable key order via JSON.stringify on plain objects built in a fixed
// field order) — CI runs this and fails on `git diff --exit-code` against the committed `docs/commands.json`.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionsBitField,
  type PermissionResolvable,
} from 'discord.js';
import type {
  RESTPostAPIApplicationCommandsJSONBody,
  APIApplicationCommandOption,
} from 'discord-api-types/v10';
import { INVITE_PERMISSIONS_BITFIELD } from '@pavisie/core';
import { allPlugins, withHelpHint } from '../src/index';
import type { PluginCommand } from '../src/sdk';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WEB_OUTPUT = join(REPO_ROOT, 'apps', 'web', 'src', 'data', 'commands.json');
const DOCS_COMMANDS_OUTPUT = join(REPO_ROOT, 'docs', 'commands.json');
const DOCS_INVITE_OUTPUT = join(REPO_ROOT, 'docs', 'invite.json');
// The website reads its default invite permission bitfield from this local copy (falls back to it when
// NEXT_PUBLIC_INVITE_PERMISSIONS is unset) so it never drifts from `INVITE_PERMISSIONS` in `@pavisie/core`.
const WEB_INVITE_OUTPUT = join(REPO_ROOT, 'apps', 'web', 'src', 'data', 'invite.json');

const SUBCOMMAND_TYPES = new Set<number>([
  ApplicationCommandOptionType.Subcommand,
  ApplicationCommandOptionType.SubcommandGroup,
]);

interface ExportedOption {
  name: string;
  description: string;
  required: boolean;
  type: string;
}

interface ExportedSubcommand {
  name: string;
  fullName: string;
  description: string;
  options: ExportedOption[];
}

interface ExportedCommand {
  name: string;
  fullName: string;
  type: 'slash' | 'user' | 'message';
  description: string;
  staffLevel?: string;
  discordPermissions?: string[];
  options: ExportedOption[];
  subcommands: ExportedSubcommand[];
}

interface ExportedPlugin {
  id: string;
  name: string;
  description: string;
  category: string;
  defaultEnabled: boolean;
  privilegedIntents: string[];
  commands: ExportedCommand[];
}

function commandType(json: RESTPostAPIApplicationCommandsJSONBody): ExportedCommand['type'] {
  switch (json.type) {
    case ApplicationCommandType.User:
      return 'user';
    case ApplicationCommandType.Message:
      return 'message';
    default:
      return 'slash';
  }
}

function toExportedOption(option: APIApplicationCommandOption): ExportedOption {
  return {
    name: option.name,
    description: 'description' in option ? (option.description ?? '') : '',
    required: 'required' in option ? Boolean(option.required) : false,
    type: ApplicationCommandOptionType[option.type] ?? String(option.type),
  };
}

/** Flattens subcommands and subcommand-groups (one level of group nesting max, per Discord's own limit) into a flat list. */
function extractSubcommands(
  rootName: string,
  options: APIApplicationCommandOption[] | undefined,
): ExportedSubcommand[] {
  if (!options) return [];
  const out: ExportedSubcommand[] = [];

  for (const option of options) {
    if (option.type === ApplicationCommandOptionType.Subcommand) {
      out.push({
        name: option.name,
        fullName: `/${rootName} ${option.name}`,
        description: option.description,
        options: (option.options ?? []).map(toExportedOption),
      });
    } else if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
      for (const sub of option.options ?? []) {
        if (sub.type !== ApplicationCommandOptionType.Subcommand) continue;
        out.push({
          name: sub.name,
          fullName: `/${rootName} ${option.name} ${sub.name}`,
          description: sub.description,
          options: (sub.options ?? []).map(toExportedOption),
        });
      }
    }
  }

  return out;
}

function permissionNames(permission: PermissionResolvable | undefined): string[] {
  if (permission === undefined) return [];
  try {
    return new PermissionsBitField(permission).toArray();
  } catch {
    return [];
  }
}

function exportCommand(command: PluginCommand): ExportedCommand {
  const json = command.data.toJSON() as RESTPostAPIApplicationCommandsJSONBody;
  const type = commandType(json);
  const rootName = json.name;
  const options = (json.options ?? []).filter(
    (o): o is APIApplicationCommandOption => !SUBCOMMAND_TYPES.has(o.type),
  );

  const discordPermissions = command.requirement?.discordPermissions
    ? command.requirement.discordPermissions.flatMap((p) => permissionNames(p))
    : undefined;

  // Apply help hint to top-level CHAT_INPUT commands only (type undefined or 1)
  let description = 'description' in json ? (json.description ?? '') : '';
  if ((json.type === undefined || json.type === 1) && description) {
    description = withHelpHint(description);
  }

  return {
    name: rootName,
    fullName: `/${rootName}`,
    type,
    description,
    staffLevel: command.requirement?.staffLevel,
    discordPermissions: discordPermissions && discordPermissions.length > 0 ? discordPermissions : undefined,
    options: options.map(toExportedOption),
    subcommands: extractSubcommands(rootName, json.options as APIApplicationCommandOption[] | undefined),
  };
}

function buildExport(): { plugins: ExportedPlugin[] } {
  const plugins = allPlugins.map((plugin): ExportedPlugin => ({
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    description: plugin.manifest.description,
    category: plugin.manifest.category,
    defaultEnabled: plugin.manifest.defaultEnabled,
    privilegedIntents: plugin.manifest.privilegedIntents ?? [],
    commands: plugin.commands.map(exportCommand),
  }));

  return { plugins };
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main(): Promise<void> {
  const exported = buildExport();
  await writeJson(WEB_OUTPUT, exported);
  await writeJson(DOCS_COMMANDS_OUTPUT, exported);
  const inviteDefaults = {
    clientIdEnv: 'DISCORD_CLIENT_ID',
    permissions: INVITE_PERMISSIONS_BITFIELD.toString(),
    scopes: ['bot', 'applications.commands'],
  };
  await writeJson(DOCS_INVITE_OUTPUT, inviteDefaults);
  await writeJson(WEB_INVITE_OUTPUT, inviteDefaults);

  const commandCount = exported.plugins.reduce((sum, p) => sum + p.commands.length, 0);
  // eslint-disable-next-line no-console -- CLI summary output
  console.log(`Exported ${exported.plugins.length} plugin(s), ${commandCount} top-level command(s).`);
}

main().catch((err: unknown) => {
  console.error('export-commands failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
