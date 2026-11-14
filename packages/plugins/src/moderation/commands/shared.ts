import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import type { ComponentContext, PluginContext } from '../../sdk';
import { ModerationServiceImpl } from '../service';

/**
 * Returns this plugin's own concrete service implementation. `ctx.services.require('moderation')` is typed as
 * the cross-plugin `ModerationService` interface (sdk/services.ts) — command/component handlers inside this
 * same plugin know the concrete class was registered in `onLoad` and use the wider surface (kick/ban/purge/...)
 * that isn't part of the cross-plugin contract.
 */
export function moderationService(ctx: PluginContext): ModerationServiceImpl {
  // Cast kept: `require()` returns the cross-plugin interface, and `onLoad` registers exactly one
  // `ModerationServiceImpl` under this id. An `instanceof` check would reject the plain-object fakes the
  // command tests register, so the narrowing is documented rather than checked.
  return ctx.services.require('moderation') as ModerationServiceImpl;
}

/** Narrows a component context registered with `kind: 'button'` to its button interaction. */
export function expectButton(c: ComponentContext): ButtonInteraction<'cached'> {
  if (!c.interaction.isButton()) {
    throw new Error('moderation: expected a button interaction');
  }
  return c.interaction;
}

/** Narrows a component context registered with `kind: 'modal'` to its modal-submit interaction. */
export function expectModal(c: ComponentContext): ModalSubmitInteraction<'cached'> {
  if (!c.interaction.isModalSubmit()) {
    throw new Error('moderation: expected a modal-submit interaction');
  }
  return c.interaction;
}

/** Reads the core `GuildConfig.fastActions` toggle (owned by `admin`, read via the shared `host` service). */
export async function getFastActions(ctx: PluginContext, guildId: string): Promise<boolean> {
  const host = ctx.services.get('host');
  if (!host) return false;
  const guildConfig = await host.getGuildConfig(guildId);
  return guildConfig.fastActions;
}
