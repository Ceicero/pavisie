/** Creates a fake ChatInputCommandInteraction from a prefix message. */
import { Attachment, GuildMember, Role } from 'discord.js';
import type { Message, ChatInputCommandInteraction } from 'discord.js';
import type { ResolvedOptions } from './options';

/**
 * Creates a fake ChatInputCommandInteraction<'cached'> that can be passed to routeInteraction.
 *
 * This object mimics the discord.js ChatInputCommandInteraction API just enough to satisfy
 * the router's pipeline and command handlers. It is NOT a complete implementation — modals,
 * autocomplete, and ephemeral replies are deliberately unsupported (modals throw, ephemeral
 * flags are stripped, autocomplete doesn't apply to message commands).
 *
 * The cast to ChatInputCommandInteraction<'cached'> is justified here because:
 * - We are building the object to structurally satisfy all the members used by routeInteraction
 *   and CommandContext handlers (checked against router.ts line-by-line).
 * - The fake object has the same essential semantics: it carries the same guild/member/permissions
 *   context, options, and reply flow.
 * - discord.js itself doesn't export the full interface definition, so the cast to the public type
 *   is the only way to provide the object to the router without re-implementing the entire type.
 * - This is a one-time cast at the point of creation; all downstream code uses the normal type.
 */
export function createMessageCommandInteraction(params: {
  message: Message<true>;
  commandName: string;
  resolved: ResolvedOptions;
}): ChatInputCommandInteraction<'cached'> {
  const { message, commandName, resolved } = params;

  // Per the Message<true> type contract, member is always present (not null)
  const member = message.member;
  if (!member) {
    throw new Error('message.member is required for prefix commands and must not be null');
  }

  let repliedMessage: Message | null = null;

  // Options getter methods that read from resolved.values
  const optionsImpl = {
    getSubcommand: (required?: boolean) => {
      if (required && !resolved.subcommand) {
        throw new Error('subcommand is required');
      }
      return resolved.subcommand ?? null;
    },
    getSubcommandGroup: (required?: boolean) => {
      if (required && !resolved.subcommandGroup) {
        throw new Error('subcommandGroup is required');
      }
      return resolved.subcommandGroup ?? null;
    },
    getString: (name: string, required?: boolean) => {
      const value = resolved.values.get(name);
      if (value === undefined) {
        if (required) throw new Error(`${name} is required`);
        return null;
      }
      if (typeof value !== 'string') throw new Error(`${name} is not a string`);
      return value;
    },
    getInteger: (name: string, required?: boolean) => {
      const value = resolved.values.get(name);
      if (value === undefined) {
        if (required) throw new Error(`${name} is required`);
        return null;
      }
      if (typeof value !== 'number') throw new Error(`${name} is not an integer`);
      return value;
    },
    getNumber: (name: string, required?: boolean) => {
      const value = resolved.values.get(name);
      if (value === undefined) {
        if (required) throw new Error(`${name} is required`);
        return null;
      }
      if (typeof value !== 'number') throw new Error(`${name} is not a number`);
      return value;
    },
    getBoolean: (name: string, required?: boolean) => {
      const value = resolved.values.get(name);
      if (value === undefined) {
        if (required) throw new Error(`${name} is required`);
        return null;
      }
      if (typeof value !== 'boolean') throw new Error(`${name} is not a boolean`);
      return value;
    },
    getUser: (name: string, required?: boolean) => {
      const value = resolved.values.get(name);
      if (value === undefined) {
        if (required) throw new Error(`${name} is required`);
        return null;
      }
      if (!(value instanceof GuildMember)) {
        throw new Error(`${name} is not a user`);
      }
      return value.user;
    },
    getMember: (name: string, required?: boolean) => {
      const value = resolved.values.get(name);
      if (value === undefined) {
        if (required) throw new Error(`${name} is required`);
        return null;
      }
      if (!(value instanceof GuildMember)) {
        throw new Error(`${name} is not a user`);
      }
      return value;
    },
    getChannel: (name: string, required?: boolean) => {
      const value = resolved.values.get(name);
      if (value === undefined) {
        if (required) throw new Error(`${name} is required`);
        return null;
      }
      if (typeof value !== 'object' || value instanceof GuildMember || value instanceof Role) {
        throw new Error(`${name} is not a channel`);
      }
      return value;
    },
    getRole: (name: string, required?: boolean) => {
      const value = resolved.values.get(name);
      if (value === undefined) {
        if (required) throw new Error(`${name} is required`);
        return null;
      }
      if (!(value instanceof Role)) {
        throw new Error(`${name} is not a role`);
      }
      return value;
    },
    getMentionable: (name: string, required?: boolean) => {
      const value = resolved.values.get(name);
      if (value === undefined) {
        if (required) throw new Error(`${name} is required`);
        return null;
      }
      if (value instanceof GuildMember || value instanceof Role) {
        return value;
      }
      throw new Error(`${name} is not a mentionable`);
    },
    getAttachment: (name: string, required?: boolean) => {
      const value = resolved.values.get(name);
      if (value === undefined) {
        if (required) throw new Error(`${name} is required`);
        return null;
      }
      if (!(value instanceof Attachment)) {
        throw new Error(`${name} is not an attachment`);
      }
      return value;
    },
    get: (name: string) => {
      return resolved.values.get(name) ?? null;
    },
    data: () => {
      // Minimal data object for command metadata
      return {
        options: Array.from(resolved.values.entries()).map(([k, v]) => ({
          name: k,
          type: typeof v === 'string' ? 3 : typeof v === 'number' ? 4 : 5,
          value: v,
        })),
      };
    },
  };

  // Build the fake interaction object
  const fakeInteraction = {
    // Type checks (only isChatInputCommand returns true)
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    inGuild: () => true,
    inCachedGuild: () => true,

    // Command metadata
    commandName,
    commandId: 'fake-command-id',
    commandGuildId: null,
    commandType: 1 as const, // CHAT_INPUT

    // Guild/channel/user context
    guild: message.guild,
    guildId: message.guildId,
    channel: message.channel,
    channelId: message.channelId,
    user: message.author,
    member,
    memberPermissions: member.permissions,
    locale: message.guild.preferredLocale,
    guildLocale: message.guild.preferredLocale,

    // Application/client
    client: message.client,
    applicationId: message.client.user?.id ?? 'fake-app-id',

    // Timing
    id: message.id,
    createdTimestamp: message.createdTimestamp,
    createdAt: message.createdAt,

    // Reply state
    replied: false as boolean,
    deferred: false as boolean,
    ephemeral: false as boolean,

    // Options (with getter methods)
    options: optionsImpl as unknown as ChatInputCommandInteraction['options'],

    // Reply/followUp methods
    //
    // These SHALLOW-copy the payload on purpose. A deep clone (structuredClone) strips the prototypes off
    // discord.js builders, so an EmbedBuilder/ActionRowBuilder arrives as a plain `{ data: ... }` object,
    // `.toJSON()` is never called on it, and Discord rejects the request:
    //   components[0][TAG_FIELD_MISSING]: Field "type" is required
    //   embeds[0].description[BASE_TYPE_REQUIRED]: This field is required
    // A shallow copy is all that is needed here — we only add/remove top-level keys — and it keeps every
    // builder instance intact by reference.
    reply: async (payload: unknown) => {
      // Strip ephemeral flag and MessageFlags.Ephemeral (both 1 << 6 = 64)
      // because message commands always reply publicly
      const opts = typeof payload === 'object' && payload !== null
        ? { ...(payload as Record<string, unknown>) }
        : {};
      if (typeof opts === 'object' && opts !== null) {
        if ('ephemeral' in opts) delete opts.ephemeral;
        if ('flags' in opts && typeof opts.flags === 'number') {
          opts.flags = (opts.flags as number) & ~64; // Clear Ephemeral bit
        }
      }

      if ((fakeInteraction as any).replied || (fakeInteraction as any).deferred) {
        throw new Error('Reply to this interaction has already been sent.');
      }

      repliedMessage = await message.reply({
        ...opts,
        allowedMentions: { repliedUser: false, parse: [] },
      } as any);

      (fakeInteraction as any).replied = true;
      return repliedMessage;
    },

    deferReply: async () => {
      if ((fakeInteraction as any).deferred || (fakeInteraction as any).replied) {
        throw new Error('This interaction has already been deferred or replied to.');
      }
      try {
        await message.channel.sendTyping();
      } catch {
        // Best effort; sendTyping can fail in some channel types
      }
      (fakeInteraction as any).deferred = true;
    },

    editReply: async (payload: unknown) => {
      if (repliedMessage) {
        return repliedMessage.edit(payload as any);
      }
      // Deferred case: send as the reply now
      if ((fakeInteraction as any).deferred) {
        const opts = typeof payload === 'object' && payload !== null
          ? { ...(payload as Record<string, unknown>) }
          : {};
        repliedMessage = await message.reply({
          ...opts,
          allowedMentions: { repliedUser: false, parse: [] },
        } as any);
        (fakeInteraction as any).replied = true;
        return repliedMessage;
      }
      throw new Error('This interaction has not been replied to or deferred.');
    },

    followUp: async (payload: unknown) => {
      // Strip ephemeral
      const opts = typeof payload === 'object' && payload !== null
        ? { ...(payload as Record<string, unknown>) }
        : {};
      if (typeof opts === 'object' && opts !== null) {
        if ('ephemeral' in opts) delete opts.ephemeral;
        if ('flags' in opts && typeof opts.flags === 'number') {
          opts.flags = (opts.flags as number) & ~64; // Clear Ephemeral bit
        }
      }
      return message.channel.send({
        ...opts,
        allowedMentions: { repliedUser: false, parse: [] },
      } as any);
    },

    deleteReply: async () => {
      if (repliedMessage) {
        await repliedMessage.delete();
      }
    },

    fetchReply: async () => {
      if (repliedMessage) {
        return repliedMessage;
      }
      throw new Error('This interaction has not been replied to.');
    },

    showModal: async () => {
      // Modals are not supported in message commands; throw an exposed error
      const { AppError } = await import('@entrophy/core');
      throw new AppError(
        'modal_not_supported',
        `This command needs a pop-up form, so it only works as a slash command. Use \`/${commandName}\` instead.`,
        { expose: true },
      );
    },
  };

  // Return with a single cast to ChatInputCommandInteraction<'cached'>.
  // The cast is justified because:
  // 1. All members used by routeInteraction (router.ts) are present and type-correct.
  // 2. The semantics match: guild/member/permissions/options/reply flow are all implemented.
  // 3. discord.js doesn't export the full interaction interface, so this is the only practical way.
  // 4. This is a one-time cast at creation; downstream code uses the normal type.
  return fakeInteraction as unknown as ChatInputCommandInteraction<'cached'>;
}
