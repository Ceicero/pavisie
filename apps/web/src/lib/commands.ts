// Typed access to `src/data/commands.json`, generated from the real plugin registry by
// `pnpm --filter @pavisie/plugins export:commands` (ARCHITECTURE.md §17) — never hand-maintained, so the
// website's command documentation cannot drift from what the bot actually registers.
import type { PluginId, StaffLevel } from '@pavisie/types';
import commandsData from '../data/commands.json';

export interface CommandOption {
  name: string;
  description: string;
  required: boolean;
  type: string;
}

export interface CommandSubcommand {
  name: string;
  fullName: string;
  description: string;
  options: CommandOption[];
}

export interface ExportedCommand {
  name: string;
  fullName: string;
  type: 'slash' | 'user' | 'message';
  description: string;
  staffLevel?: StaffLevel;
  discordPermissions?: string[];
  options: CommandOption[];
  subcommands: CommandSubcommand[];
}

export interface ExportedPlugin {
  id: PluginId;
  name: string;
  description: string;
  category: string;
  defaultEnabled: boolean;
  privilegedIntents: string[];
  commands: ExportedCommand[];
}

export interface CommandsExport {
  plugins: ExportedPlugin[];
}

const data = commandsData as CommandsExport;

export function allPluginExports(): ExportedPlugin[] {
  return data.plugins;
}

export function getPluginExport(id: string): ExportedPlugin | undefined {
  return data.plugins.find((p) => p.id === id);
}

export function totalCommandCount(): number {
  return data.plugins.reduce((sum, p) => sum + countLeafCommands(p), 0);
}

/** Counts "usable things a user can type" — top-level commands with no subcommands count once, a command with
 * subcommands counts its subcommands (the top-level name alone is not invocable for a subcommand-only group). */
export function countLeafCommands(plugin: ExportedPlugin): number {
  return plugin.commands.reduce((sum, c) => sum + (c.subcommands.length > 0 ? c.subcommands.length : 1), 0);
}

const STAFF_LABELS: Record<StaffLevel, string> = {
  member: 'Everyone',
  helper: 'Helper+',
  moderator: 'Moderator+',
  admin: 'Admin+',
  owner: 'Server owner',
};

export function staffLabel(level: StaffLevel | undefined): string {
  if (!level) return 'Everyone';
  return STAFF_LABELS[level] ?? level;
}

/** Turns a raw Discord permission constant (`ManageMessages`) into readable words ("Manage Messages"). */
export function formatPermission(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export function whoCanUse(command: Pick<ExportedCommand, 'staffLevel' | 'discordPermissions'>): string {
  const parts: string[] = [staffLabel(command.staffLevel)];
  if (command.discordPermissions && command.discordPermissions.length > 0) {
    parts.push(`with ${command.discordPermissions.map(formatPermission).join(', ')}`);
  }
  return parts.join(' ');
}

/** Composes a plausible example invocation from a command/subcommand's declared options, so every row in the
 * command table shows real usage without hand-written examples that could drift from the schema. */
export function exampleUsage(
  entry: Pick<ExportedCommand | CommandSubcommand, 'fullName' | 'options'>,
): string {
  const args = entry.options.map((o) => exampleForOption(o)).join(' ');
  return args ? `${entry.fullName} ${args}` : entry.fullName;
}

function exampleForOption(option: CommandOption): string {
  const value = exampleValueForType(option.name, option.type);
  const rendered = `${option.name}:${value}`;
  return option.required ? rendered : `[${rendered}]`;
}

function exampleValueForType(name: string, type: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('user') || lowerName.includes('member') || lowerName.includes('target'))
    return '@user';
  if (lowerName.includes('channel')) return '#general';
  if (lowerName.includes('role')) return '@Moderators';
  if (lowerName.includes('reason')) return '"spamming links"';
  if (lowerName.includes('duration')) return '1h';
  if (lowerName === 'key') return 'guild.locale';
  switch (type) {
    case 'User':
      return '@user';
    case 'Channel':
      return '#general';
    case 'Role':
      return '@role';
    case 'Boolean':
      return 'true';
    case 'Integer':
    case 'Number':
      return '10';
    default:
      return `"${name}"`;
  }
}
