// Component handlers for the `/setup wizard` step flow (see ../wizard.ts for session/render logic).
import type {
  ChannelSelectMenuInteraction,
  RoleSelectMenuInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { AuditAction, PermissionError } from '@pavisie/core';
import { redactForAudit } from '@pavisie/database';
import type { PluginId } from '@pavisie/types';
import { errorEmbed, successEmbed, type ComponentContext, type ComponentHandler } from '../../sdk';
import {
  WIZARD_STEP_IDS,
  WizardSessionStore,
  finishWizard,
  renderWizardStep,
  type WizardSession,
} from '../wizard';
import { describeRoleHierarchyWarnings, describeIntentWarnings } from '../format';

async function loadOwnedSession(
  c: ComponentContext,
  ownerId: string | undefined,
): Promise<WizardSession | null> {
  if (!ownerId || c.interaction.user.id !== ownerId) {
    throw new PermissionError(c.t('setup.notWizardOwner'));
  }
  const store = new WizardSessionStore(c.ctx.redis);
  return store.get(c.guildId, ownerId);
}

async function renderAndUpdate(c: ComponentContext, session: WizardSession): Promise<void> {
  const manifests = c.ctx.services.require('host').listManifests();
  const rendered = renderWizardStep(session, manifests);
  // `.update` exists on every select/button component interaction; component handlers are typed generically
  // across button/select/modal in the SDK, so this narrows structurally rather than by discord.js subtype.
  await (
    c.interaction as unknown as {
      update: (opts: { embeds: unknown[]; components: unknown[] }) => Promise<unknown>;
    }
  ).update({
    embeds: rendered.embeds,
    components: rendered.components,
  });
}

async function expiredUpdate(c: ComponentContext): Promise<void> {
  await (
    c.interaction as unknown as {
      update: (opts: { content: string; embeds: unknown[]; components: unknown[] }) => Promise<unknown>;
    }
  ).update({
    content: c.t('setup.sessionExpired'),
    embeds: [],
    components: [],
  });
}

function roleSelectHandler(
  field: 'adminRoleIds' | 'modRoleIds' | 'helperRoleIds',
  action: string,
): ComponentHandler {
  return {
    action,
    kind: 'select',
    ownerOnly: true,
    async handler(c) {
      const [ownerId] = c.args;
      const session = await loadOwnedSession(c, ownerId);
      if (!session) {
        await expiredUpdate(c);
        return;
      }
      const interaction = c.interaction as unknown as RoleSelectMenuInteraction<'cached'>;
      session.data[field] = interaction.values;
      const store = new WizardSessionStore(c.ctx.redis);
      await store.save(session);
      await renderAndUpdate(c, session);
    },
  };
}

function channelSelectHandler(field: 'modLogChannelId' | 'staffChannelId', action: string): ComponentHandler {
  return {
    action,
    kind: 'select',
    ownerOnly: true,
    async handler(c) {
      const [ownerId] = c.args;
      const session = await loadOwnedSession(c, ownerId);
      if (!session) {
        await expiredUpdate(c);
        return;
      }
      const interaction = c.interaction as unknown as ChannelSelectMenuInteraction<'cached'>;
      session.data[field] = interaction.values[0] ?? null;
      const store = new WizardSessionStore(c.ctx.redis);
      await store.save(session);
      await renderAndUpdate(c, session);
    },
  };
}

const localeHandler: ComponentHandler = {
  action: 'wizard-locale',
  kind: 'select',
  ownerOnly: true,
  async handler(c) {
    const [ownerId] = c.args;
    const session = await loadOwnedSession(c, ownerId);
    if (!session) {
      await expiredUpdate(c);
      return;
    }
    const interaction = c.interaction as unknown as StringSelectMenuInteraction<'cached'>;
    if (interaction.values[0]) session.data.locale = interaction.values[0];
    const store = new WizardSessionStore(c.ctx.redis);
    await store.save(session);
    await renderAndUpdate(c, session);
  },
};

const timezoneHandler: ComponentHandler = {
  action: 'wizard-timezone',
  kind: 'select',
  ownerOnly: true,
  async handler(c) {
    const [ownerId] = c.args;
    const session = await loadOwnedSession(c, ownerId);
    if (!session) {
      await expiredUpdate(c);
      return;
    }
    const interaction = c.interaction as unknown as StringSelectMenuInteraction<'cached'>;
    if (interaction.values[0]) session.data.timezone = interaction.values[0];
    const store = new WizardSessionStore(c.ctx.redis);
    await store.save(session);
    await renderAndUpdate(c, session);
  },
};

const pluginsHandler: ComponentHandler = {
  action: 'wizard-plugins',
  kind: 'select',
  ownerOnly: true,
  async handler(c) {
    const [ownerId] = c.args;
    const session = await loadOwnedSession(c, ownerId);
    if (!session) {
      await expiredUpdate(c);
      return;
    }
    const interaction = c.interaction as unknown as StringSelectMenuInteraction<'cached'>;
    session.data.enabledPluginIds = interaction.values as PluginId[];
    const store = new WizardSessionStore(c.ctx.redis);
    await store.save(session);
    await renderAndUpdate(c, session);
  },
};

const backHandler: ComponentHandler = {
  action: 'wizard-back',
  kind: 'button',
  ownerOnly: true,
  async handler(c) {
    const [ownerId] = c.args;
    const session = await loadOwnedSession(c, ownerId);
    if (!session) {
      await expiredUpdate(c);
      return;
    }
    session.stepIndex = Math.max(0, session.stepIndex - 1);
    const store = new WizardSessionStore(c.ctx.redis);
    await store.save(session);
    await renderAndUpdate(c, session);
  },
};

const nextHandler: ComponentHandler = {
  action: 'wizard-next',
  kind: 'button',
  ownerOnly: true,
  async handler(c) {
    const [ownerId] = c.args;
    const session = await loadOwnedSession(c, ownerId);
    if (!session) {
      await expiredUpdate(c);
      return;
    }
    session.stepIndex = Math.min(WIZARD_STEP_IDS.length - 1, session.stepIndex + 1);
    const store = new WizardSessionStore(c.ctx.redis);
    await store.save(session);
    await renderAndUpdate(c, session);
  },
};

const cancelHandler: ComponentHandler = {
  action: 'wizard-cancel',
  kind: 'button',
  ownerOnly: true,
  async handler(c) {
    const [ownerId] = c.args;
    if (!ownerId || c.interaction.user.id !== ownerId) {
      throw new PermissionError(c.t('setup.notWizardOwner'));
    }
    const store = new WizardSessionStore(c.ctx.redis);
    await store.clear(c.guildId, ownerId);
    await (
      c.interaction as unknown as {
        update: (opts: { embeds: unknown[]; components: unknown[] }) => Promise<unknown>;
      }
    ).update({
      embeds: [errorEmbed(c.t('setup.cancelled'))],
      components: [],
    });
  },
};

const finishHandler: ComponentHandler = {
  action: 'wizard-finish',
  kind: 'button',
  ownerOnly: true,
  async handler(c) {
    const [ownerId] = c.args;
    const session = await loadOwnedSession(c, ownerId);
    if (!session) {
      await expiredUpdate(c);
      return;
    }

    const host = c.ctx.services.require('host');
    const updated = await finishWizard(session, host, { id: ownerId as string, source: 'bot' });

    const store = new WizardSessionStore(c.ctx.redis);
    await store.clear(c.guildId, ownerId as string);

    await c.ctx.audit({
      guildId: c.guildId,
      actorId: ownerId as string,
      actorType: 'user',
      action: AuditAction.SetupWizardComplete,
      targetType: 'guild_config',
      targetId: c.guildId,
      after: redactForAudit({
        locale: updated.locale,
        timezone: updated.timezone,
        adminRoleIds: updated.adminRoleIds,
        modRoleIds: updated.modRoleIds,
        helperRoleIds: updated.helperRoleIds,
        modLogChannelId: updated.modLogChannelId,
        staffChannelId: updated.staffChannelId,
        enabledPluginIds: session.data.enabledPluginIds,
      }),
      source: 'bot',
    });

    // Check for permission/hierarchy/intent warnings
    const guild = c.interaction.guild;
    const manifests = host.listManifests();
    const staffRoleIds = [
      ...new Set([...updated.adminRoleIds, ...updated.modRoleIds, ...updated.helperRoleIds]),
    ];
    const hierarchyWarnings = describeRoleHierarchyWarnings(guild, staffRoleIds, c.t);
    const intentWarnings = describeIntentWarnings(manifests, session.data.enabledPluginIds, c.ctx.intentsEnabled, c.t);

    const summaryLines: string[] = [
      `**${c.t('setup.complete')}**`,
      `Locale: **${updated.locale}** · Timezone: **${updated.timezone}**`,
      `Admin roles: ${session.data.adminRoleIds.length > 0 ? session.data.adminRoleIds.map((id) => `<@&${id}>`).join(', ') : '_None_'}`,
      `Moderator roles: ${session.data.modRoleIds.length > 0 ? session.data.modRoleIds.map((id) => `<@&${id}>`).join(', ') : '_None_'}`,
      `Helper roles: ${session.data.helperRoleIds.length > 0 ? session.data.helperRoleIds.map((id) => `<@&${id}>`).join(', ') : '_None_'}`,
      `Mod-log channel: ${updated.modLogChannelId ? `<#${updated.modLogChannelId}>` : '_Not set_'}`,
      `Staff channel: ${updated.staffChannelId ? `<#${updated.staffChannelId}>` : '_Not set_'}`,
      `Enabled plugins: ${session.data.enabledPluginIds.length > 0 ? session.data.enabledPluginIds.join(', ') : '_None_'}`,
      '',
    ];

    // Add permission/hierarchy/intent audit results
    if (hierarchyWarnings.length > 0 || intentWarnings.length > 0) {
      summaryLines.push('⚠️ **Permission warnings**');
      hierarchyWarnings.forEach((warning) => summaryLines.push(`• ${warning}`));
      intentWarnings.forEach((warning) => summaryLines.push(`• ${warning}`));
      summaryLines.push('', 'You can fix these anytime — see `/permissions audit` for details.');
    } else {
      summaryLines.push('✅ **All permission checks passed**');
      summaryLines.push('Your bot is ready to moderate. You can review this anytime with `/setup status`.');
    }

    summaryLines.push('', 'Use `/setup status`, `/config view`, or `/plugin list` anytime to review your configuration.');

    const summary = successEmbed(summaryLines.join('\n'));

    await (
      c.interaction as unknown as {
        update: (opts: { embeds: unknown[]; components: unknown[] }) => Promise<unknown>;
      }
    ).update({
      embeds: [summary],
      components: [],
    });
  },
};

export const wizardComponents: ComponentHandler[] = [
  roleSelectHandler('adminRoleIds', 'wizard-role-admin'),
  roleSelectHandler('modRoleIds', 'wizard-role-mod'),
  roleSelectHandler('helperRoleIds', 'wizard-role-helper'),
  channelSelectHandler('modLogChannelId', 'wizard-channel-modlog'),
  channelSelectHandler('staffChannelId', 'wizard-channel-staff'),
  localeHandler,
  timezoneHandler,
  pluginsHandler,
  backHandler,
  nextHandler,
  cancelHandler,
  finishHandler,
];
