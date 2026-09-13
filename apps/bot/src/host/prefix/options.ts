/** Resolves parsed prefix-command tokens against a command's option schema. */
import type { Message } from 'discord.js';
import { splitNamedArg } from './parse';

export interface ResolvedOptions {
  subcommandGroup: string | null;
  subcommand: string | null;
  values: Map<string, ResolvedValue>;
}

import type { GuildMember, GuildBasedChannel, Role, Attachment } from 'discord.js';

export type ResolvedValue =
  | string
  | number
  | boolean
  | GuildMember
  | GuildBasedChannel
  | Role
  | Attachment;

interface DiscordOption {
  type: number;
  name: string;
  required?: boolean;
  description?: string;
  choices?: Array<{ name: string; value: string | number }>;
  min_length?: number;
  max_length?: number;
  min_value?: number;
  max_value?: number;
  channel_types?: number[]; // Discord channel type numbers for channel options
  options?: DiscordOption[];
}

/**
 * Resolves parsed tokens against a command's option schema (from `command.data.toJSON()`).
 * Returns either a resolved set of options with any subcommand/subcommand-group details,
 * or an error with a usage string.
 */
export async function resolvePrefixOptions(
  commandJson: { options?: DiscordOption[] },
  tokens: string[],
  message: Message<true>,
  commandName: string = '',
): Promise<{ ok: true; resolved: ResolvedOptions } | { ok: false; usage: string; error: string }> {
  const options = commandJson.options ?? [];
  let remainingTokens = [...tokens];
  let subcommandGroup: string | null = null;
  let subcommand: string | null = null;
  let leafOptions: DiscordOption[] = options;

  // Walk off subcommand group and subcommand from the front of tokens
  // Check if any option is a subcommand group
  const hasSubcommandGroup = leafOptions.some((o) => o.type === 2);
  if (hasSubcommandGroup && remainingTokens.length > 0) {
    const groupName = remainingTokens[0].toLowerCase();
    const groupDef = leafOptions.find((o) => o.type === 2 && o.name.toLowerCase() === groupName);
    if (groupDef) {
      subcommandGroup = groupDef.name;
      remainingTokens = remainingTokens.slice(1);
      leafOptions = groupDef.options ?? [];
    }
  }

  // Check if any option is a subcommand
  const hasSubcommand = leafOptions.some((o) => o.type === 1);
  if (hasSubcommand && remainingTokens.length > 0) {
    const subcmdName = remainingTokens[0].toLowerCase();
    const subcmdDef = leafOptions.find((o) => o.type === 1 && o.name.toLowerCase() === subcmdName);
    if (subcmdDef) {
      subcommand = subcmdDef.name;
      remainingTokens = remainingTokens.slice(1);
      leafOptions = subcmdDef.options ?? [];
    }
  }

  // If this level still offers subcommands, one of them must be chosen. Reaching the option binder without a
  // subcommand means `getSubcommand(true)` will throw inside the handler and the router will render a generic
  // "something went wrong" — useless to someone who simply typed `+level` and needs to be told what comes next.
  // Covers both the missing case (`+level`) and an unrecognised one (`+level bogus`).
  const pendingSubcommands = leafOptions.filter((opt) => opt.type === 1 || opt.type === 2);

  // When a command offers exactly one subcommand there is nothing to choose, so pick it rather than demanding
  // it. `/permissions` is really `/permissions audit`; over the prefix, `+permissions` should just run. Discord
  // forces the choice in the slash picker, but a message command has no picker to force it.
  if (pendingSubcommands.length === 1 && pendingSubcommands[0].type === 1) {
    const only = pendingSubcommands[0];
    // Only auto-select if no remaining tokens, or the first token matches the subcommand name
    if (remainingTokens.length === 0 || remainingTokens[0].toLowerCase() === only.name.toLowerCase()) {
      subcommand = only.name;
      leafOptions = only.options ?? [];
      // Consume the token if it matched
      if (remainingTokens.length > 0 && remainingTokens[0].toLowerCase() === only.name.toLowerCase()) {
        remainingTokens = remainingTokens.slice(1);
      }
    } else {
      // Token doesn't match the single subcommand, treat as unknown subcommand
      const path = [commandName, subcommandGroup].filter(Boolean).join(' ');
      const attempted = remainingTokens[0];
      return {
        ok: false,
        usage: `${path} ${only.name}`,
        error: `\`${attempted}\` is not a valid option for \`${path}\`. Did you mean \`${only.name}\`?`,
      };
    }
  } else if (pendingSubcommands.length > 0) {
    const path = [commandName, subcommandGroup, subcommand].filter(Boolean).join(' ');
    const names = pendingSubcommands.map((opt) => opt.name);
    const attempted = remainingTokens[0];
    return {
      ok: false,
      usage: `${path} <${names.join(' | ')}>`,
      error: attempted
        ? `\`${attempted}\` is not a valid option for \`${path}\`. Try one of: ${names.join(', ')}.`
        : `\`${path}\` needs one of: ${names.join(', ')}.`,
    };
  }

  // Now resolve remaining tokens against leaf options (the actual command options)
  const values = new Map<string, ResolvedValue>();
  const namedArgs = new Map<string, string>();
  const positionalArgs: string[] = [];

  // Build a set of valid lowercase option names (for DEFECT 3 fix)
  const validOptionNames = new Set(leafOptions.map((o) => o.name.toLowerCase()));

  // Split tokens into named and positional
  for (const token of remainingTokens) {
    const named = splitNamedArg(token);
    // DEFECT 3 FIX: Only treat as named arg if key matches an actual option name
    if (named && validOptionNames.has(named.key)) {
      namedArgs.set(named.key, named.value);
    } else {
      positionalArgs.push(token);
    }
  }

  // Collect attachments for auto-binding (DEFECT 2 fix)
  const availableAttachments = Array.from(message.attachments.values());
  let attachmentIndex = 0;

  // Bind arguments to options
  let positionalIndex = 0;
  for (let i = 0; i < leafOptions.length; i++) {
    const opt = leafOptions[i];
    if (!opt) continue;

    const name = opt.name;
    const required = opt.required ?? false;

    // Handle attachment auto-binding (DEFECT 2 fix)
    if (opt.type === 11) {
      // Attachment type
      if (attachmentIndex < availableAttachments.length) {
        values.set(name, availableAttachments[attachmentIndex]);
        attachmentIndex += 1;
      } else if (required) {
        const usage = buildUsageString(commandName, leafOptions, subcommandGroup, subcommand);
        return {
          ok: false,
          usage,
          error: `\`${name}\` is required — attach a file to your message.`,
        };
      }
      continue;
    }

    // Try named arg first
    let rawValue = namedArgs.get(name.toLowerCase());

    // If not found and this is positional, consume from positional args
    if (rawValue === undefined && positionalIndex < positionalArgs.length) {
      // The LAST String option consumes all remaining positional args
      const isLastStringOption =
        opt.type === 3 && !leafOptions.slice(i + 1).some((o) => o.type === 3);
      if (isLastStringOption) {
        rawValue = positionalArgs.slice(positionalIndex).join(' ');
        positionalIndex = positionalArgs.length;
      } else {
        rawValue = positionalArgs[positionalIndex];
        positionalIndex += 1;
      }
    }

    // Validate and resolve
    if (rawValue === undefined) {
      if (required) {
        const usage = buildUsageString(commandName, leafOptions, subcommandGroup, subcommand);
        return {
          ok: false,
          usage,
          error: `Missing required option: \`${name}\`.`,
        };
      }
      continue;
    }

    try {
      const resolved = await resolveOptionValue(rawValue, opt, message);
      values.set(name, resolved);
    } catch (err) {
      const usage = buildUsageString(commandName, leafOptions, subcommandGroup, subcommand);
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        usage,
        error: errorMsg,
      };
    }
  }

  return {
    ok: true,
    resolved: { subcommandGroup, subcommand, values },
  };
}

/**
 * Resolves a single option value according to its Discord type.
 * Discord type numbers: 1 Subcommand, 2 SubcommandGroup, 3 String, 4 Integer,
 * 5 Boolean, 6 User, 7 Channel, 8 Role, 9 Mentionable, 10 Number, 11 Attachment.
 */
async function resolveOptionValue(
  rawValue: string,
  option: DiscordOption,
  message: Message<true>,
): Promise<ResolvedValue> {
  const type = option.type;
  const name = option.name;

  switch (type) {
    case 3: {
      // String
      if (option.min_length && rawValue.length < option.min_length) {
        throw new Error(`\`${name}\` must be at least ${option.min_length} character(s).`);
      }
      if (option.max_length && rawValue.length > option.max_length) {
        throw new Error(`\`${name}\` must be at most ${option.max_length} character(s).`);
      }
      if (option.choices && option.choices.length > 0) {
        // DEFECT 4 FIX: Match against both name and value, case-insensitively
        const choice = option.choices.find(
          (c) =>
            String(c.value).toLowerCase() === rawValue.toLowerCase() ||
            c.name.toLowerCase() === rawValue.toLowerCase(),
        );
        if (!choice) {
          const validChoices = option.choices.map((c) => `\`${c.name}\``).join(', ');
          throw new Error(`\`${name}\` must be one of: ${validChoices}.`);
        }
        return String(choice.value);
      }
      return rawValue;
    }

    case 4: {
      // Integer
      const intVal = Number.parseInt(rawValue, 10);
      if (Number.isNaN(intVal)) {
        throw new Error(`\`${name}\` must be an integer.`);
      }
      if (option.min_value !== undefined && intVal < option.min_value) {
        throw new Error(`\`${name}\` must be at least ${option.min_value}.`);
      }
      if (option.max_value !== undefined && intVal > option.max_value) {
        throw new Error(`\`${name}\` must be at most ${option.max_value}.`);
      }
      return intVal;
    }

    case 10: {
      // Number
      const numVal = Number.parseFloat(rawValue);
      if (Number.isNaN(numVal)) {
        throw new Error(`\`${name}\` must be a number.`);
      }
      if (option.min_value !== undefined && numVal < option.min_value) {
        throw new Error(`\`${name}\` must be at least ${option.min_value}.`);
      }
      if (option.max_value !== undefined && numVal > option.max_value) {
        throw new Error(`\`${name}\` must be at most ${option.max_value}.`);
      }
      return numVal;
    }

    case 5: {
      // Boolean
      const boolVal = resolveBooleanValue(rawValue);
      if (boolVal === null) {
        throw new Error(`\`${name}\` must be true/false, yes/no, on/off, or 1/0.`);
      }
      return boolVal;
    }

    case 6:
      // User
      return await resolveUser(rawValue, message);

    case 7:
      // Channel
      return await resolveChannel(rawValue, message, option);

    case 8:
      // Role
      return await resolveRole(rawValue, message);

    case 9: {
      // Mentionable
      try {
        return await resolveUser(rawValue, message);
      } catch {
        return await resolveRole(rawValue, message);
      }
    }

    case 11:
      // Attachment
      return resolveAttachment(rawValue, message);

    default:
      throw new Error(`Unknown option type: ${type}`);
  }
}

function resolveBooleanValue(value: string): boolean | null {
  const lower = value.toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(lower)) return true;
  if (['false', 'no', 'off', '0'].includes(lower)) return false;
  return null;
}

async function resolveUser(value: string, message: Message<true>): Promise<GuildMember> {
  // Try mention: <@123> or <@!123>
  const mentionMatch = value.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    const userId = mentionMatch[1];
    const member = message.guild.members.cache.get(userId);
    if (member) {
      return member;
    }
    // Fall back to fetch for mention
    try {
      return await message.guild.members.fetch(userId);
    } catch {
      throw new Error(`User <@${userId}> not found in this server.`);
    }
  }

  // Try raw snowflake
  if (/^\d{17,19}$/.test(value)) {
    const member = message.guild.members.cache.get(value);
    if (member) {
      return member;
    }
    // Fall back to fetch for raw ID
    try {
      return await message.guild.members.fetch(value);
    } catch {
      throw new Error(`User with ID ${value} not found in this server.`);
    }
  }

  // Try exact username or nickname (cache-only; avoid unbounded member search)
  const member = message.guild.members.cache.find(
    (m) => m.user.username === value || m.displayName === value,
  );
  if (member) {
    return member;
  }

  throw new Error(`User \`${value}\` not found. Use a mention, ID, or exact username.`);
}

/** Discord's numeric channel types, named for error messages. */
const CHANNEL_TYPE_NAMES: Record<number, string> = {
  0: 'text',
  2: 'voice',
  4: 'category',
  5: 'announcement',
  10: 'announcement thread',
  11: 'public thread',
  12: 'private thread',
  13: 'stage',
  15: 'forum',
};

function channelTypeName(type: number): string {
  return CHANNEL_TYPE_NAMES[type] ?? `type ${type}`;
}

/**
 * Enforces the option's `addChannelTypes` restriction. For a real slash command Discord's picker only offers
 * channels of the right type, so command code trusts it; the prefix bridge takes a hand-typed mention and has
 * to enforce it here instead.
 */
function assertChannelType(channel: GuildBasedChannel, allowed: number[] | undefined): GuildBasedChannel {
  if (!allowed?.length || allowed.includes(channel.type)) return channel;
  const wanted = allowed.map(channelTypeName).join(' or ');
  throw new Error(
    `\`#${channel.name}\` is a ${channelTypeName(channel.type)} channel; this option needs a ${wanted} channel.`,
  );
}

async function resolveChannel(
  value: string,
  message: Message<true>,
  option?: DiscordOption,
): Promise<GuildBasedChannel> {
  const allowed = option?.channel_types;

  // The cache is whatever the gateway happens to hold, so fall back to a fetch by id before giving up — a real
  // interaction would have carried Discord's own resolved channel and never missed.
  const byId = async (id: string, notFound: string): Promise<GuildBasedChannel> => {
    const cached = message.guild.channels.cache.get(id);
    if (cached) return assertChannelType(cached, allowed);
    const fetched = await message.guild.channels.fetch(id).catch(() => null);
    if (fetched) return assertChannelType(fetched, allowed);
    throw new Error(notFound);
  };

  // Try mention: <#123>
  const mentionMatch = value.match(/^<#(\d+)>$/);
  if (mentionMatch) {
    const channelId = mentionMatch[1];
    return byId(channelId, `Channel <#${channelId}> not found in this server.`);
  }

  // Try raw snowflake
  if (/^\d{17,19}$/.test(value)) {
    return byId(value, `Channel with ID ${value} not found in this server.`);
  }

  // Try exact name (cache-only; a name lookup can't be resolved by a fetch)
  const named = message.guild.channels.cache.find((c) => c.name === value);
  if (named) return assertChannelType(named, allowed);

  throw new Error(`Channel \`${value}\` not found. Use a mention, ID, or exact name.`);
}

async function resolveRole(value: string, message: Message<true>): Promise<Role> {
  // Try mention: <@&123>
  const mentionMatch = value.match(/^<@&(\d+)>$/);
  if (mentionMatch) {
    const roleId = mentionMatch[1];
    const role = message.guild.roles.cache.get(roleId);
    if (role) {
      return role;
    }
    // Fall back to fetch for mention
    try {
      const role = await message.guild.roles.fetch(roleId);
      if (role) return role;
    } catch {
      // Fall through to error below
    }
    throw new Error(`Role <@&${roleId}> not found in this server.`);
  }

  // Try raw snowflake
  if (/^\d{17,19}$/.test(value)) {
    const role = message.guild.roles.cache.get(value);
    if (role) {
      return role;
    }
    // Fall back to fetch for raw ID
    try {
      const role = await message.guild.roles.fetch(value);
      if (role) return role;
    } catch {
      // Fall through to error below
    }
    throw new Error(`Role with ID ${value} not found in this server.`);
  }

  // Try exact name (cache-only; avoid unbounded role search)
  const role = message.guild.roles.cache.find((r) => r.name === value);
  if (role) {
    return role;
  }

  throw new Error(`Role \`${value}\` not found. Use a mention, ID, or exact name.`);
}

function resolveAttachment(value: string, message: Message<true>): Attachment {
  // Note: This function should not be called directly with rawValue.
  // Attachments are auto-bound in resolvePrefixOptions and this should not be called.
  throw new Error('Attachment resolution should not be called with a token value. Use auto-binding instead.');
}

/**
 * Builds a human-readable usage string from the option schema.
 * E.g. `+mod ban <user> <reason> [days]` (required in `<>`, optional in `[]`).
 */
function buildUsageString(
  commandName: string,
  options: DiscordOption[],
  subcommandGroup: string | null,
  subcommand: string | null,
): string {
  let usage = commandName;

  if (subcommandGroup) {
    usage += ` ${subcommandGroup}`;
  }
  if (subcommand) {
    usage += ` ${subcommand}`;
  }

  for (const opt of options) {
    if (opt.type === 1 || opt.type === 2) continue; // Skip subcommands

    const bracket = opt.required ? '<' : '[';
    const closeBracket = opt.required ? '>' : ']';
    usage += ` ${bracket}${opt.name}${closeBracket}`;
  }

  return usage.trim();
}
