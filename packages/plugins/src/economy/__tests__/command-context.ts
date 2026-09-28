import { vi } from 'vitest';
import type { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import type { StaffLevel } from '@pavisie/types';
import { createTestContext } from '../../sdk/testing';
import type { CommandContext } from '../../sdk';
import en from '../locales/en.json';

export const GUILD_ID = 'guild-1';

/** Looks a dotted key up in the plugin's real `en.json` with `{var}` interpolation (same stand-in used by
 * community/__tests__/birthday-command.test.ts and other command-level tests). */
export function realT(key: string, vars?: Record<string, string | number>): string {
  const parts = key.split('.');
  let node: unknown = en;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  if (typeof node !== 'string') return key;
  let out = node;
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

export interface ReplyPayload {
  embeds?: EmbedBuilder[];
  ephemeral?: boolean;
}

/** `errorEmbed` renders its text as `❌ <text>`, so expected error copy has to carry the same prefix. */
export function errorText(key: string, vars?: Record<string, string | number>): string {
  return `❌ ${realT(key, vars)}`;
}

export function descriptionOf(payload: ReplyPayload | undefined): string {
  return payload?.embeds?.[0]?.data.description ?? '';
}

export function titleOf(payload: ReplyPayload | undefined): string {
  return payload?.embeds?.[0]?.data.title ?? '';
}

export interface FakeOptions {
  group?: string;
  sub: string;
  integers?: Record<string, number | null>;
  strings?: Record<string, string | null>;
  users?: Record<string, { id: string; bot?: boolean; username?: string } | null>;
}

export function buildCommandContext(
  opts: FakeOptions,
  callerId: string,
  prisma: CommandContext['ctx']['prisma'],
  config: Record<string, unknown>,
  options: { staffLevel?: StaffLevel; audit?: ReturnType<typeof vi.fn> } = {},
): { c: CommandContext; reply: () => ReplyPayload | undefined } {
  let reply: ReplyPayload | undefined;
  const interaction = {
    user: { id: callerId, username: `user-${callerId}` },
    guild: { id: GUILD_ID },
    options: {
      getSubcommandGroup: () => opts.group ?? null,
      getSubcommand: () => opts.sub,
      getInteger: (name: string, required?: boolean) => {
        const value = (opts.integers ?? {})[name] ?? null;
        if (required && value === null) throw new Error(`missing required integer option: ${name}`);
        return value;
      },
      getString: (name: string, required?: boolean) => {
        const value = (opts.strings ?? {})[name] ?? null;
        if (required && value === null) throw new Error(`missing required string option: ${name}`);
        return value;
      },
      getUser: (name: string, required?: boolean) => {
        const value = (opts.users ?? {})[name] ?? null;
        if (required && value === null) throw new Error(`missing required user option: ${name}`);
        return value;
      },
    },
    reply: vi.fn(async (payload: ReplyPayload) => {
      reply = payload;
    }),
  };

  const { ctx } = createTestContext({
    overrides: { prisma, audit: options.audit ?? (async () => undefined) },
  });

  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: GUILD_ID,
    staffLevel: options.staffLevel ?? 'member',
    locale: 'en-US' as never,
    t: realT,
    config: async <T>() => config as T,
  };

  return { c, reply: () => reply };
}
