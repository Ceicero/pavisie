import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  type EmbedBuilder,
} from 'discord.js';
import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';
import type { PluginId } from '@pavisie/types';
import {
  brandEmbed,
  buildCustomId,
  type GuildConfigData,
  type HostService,
  type PluginManifest,
} from '../sdk';

export const WIZARD_STEP_IDS = ['roles', 'channels', 'locale-timezone', 'plugins'] as const;
export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export interface WizardData {
  adminRoleIds: string[];
  modRoleIds: string[];
  helperRoleIds: string[];
  modLogChannelId: string | null;
  staffChannelId: string | null;
  locale: string;
  timezone: string;
  enabledPluginIds: PluginId[];
}

export interface WizardSession {
  guildId: string;
  userId: string;
  stepIndex: number;
  data: WizardData;
}

const WIZARD_TTL_SECONDS = 15 * 60;

/** Redis-backed store for in-progress `/setup wizard` sessions, keyed per (guild, user), TTL-refreshed on every save. */
export class WizardSessionStore {
  constructor(private readonly redis: Redis) {}

  private key(guildId: string, userId: string): string {
    return redisKey('admin', 'wizard', guildId, userId);
  }

  async get(guildId: string, userId: string): Promise<WizardSession | null> {
    const raw = await this.redis.get(this.key(guildId, userId));
    return raw ? (JSON.parse(raw) as WizardSession) : null;
  }

  async save(session: WizardSession): Promise<void> {
    await this.redis.set(
      this.key(session.guildId, session.userId),
      JSON.stringify(session),
      'EX',
      WIZARD_TTL_SECONDS,
    );
  }

  async clear(guildId: string, userId: string): Promise<void> {
    await this.redis.del(this.key(guildId, userId));
  }
}

/** Builds a fresh wizard session pre-filled from the guild's current config and currently-enabled plugins. */
export function createWizardSession(
  guildId: string,
  userId: string,
  currentConfig: GuildConfigData,
  currentlyEnabled: PluginId[],
): WizardSession {
  return {
    guildId,
    userId,
    stepIndex: 0,
    data: {
      adminRoleIds: currentConfig.adminRoleIds,
      modRoleIds: currentConfig.modRoleIds,
      helperRoleIds: currentConfig.helperRoleIds,
      modLogChannelId: currentConfig.modLogChannelId,
      staffChannelId: currentConfig.staffChannelId,
      locale: currentConfig.locale,
      timezone: currentConfig.timezone,
      enabledPluginIds: currentlyEnabled,
    },
  };
}

const TIMEZONE_OPTIONS = [
  { label: 'UTC', value: 'UTC' },
  { label: 'US Eastern (New York)', value: 'America/New_York' },
  { label: 'US Central (Chicago)', value: 'America/Chicago' },
  { label: 'US Mountain (Denver)', value: 'America/Denver' },
  { label: 'US Pacific (Los Angeles)', value: 'America/Los_Angeles' },
  { label: 'UK (London)', value: 'Europe/London' },
  { label: 'Central Europe (Berlin)', value: 'Europe/Berlin' },
  { label: 'Eastern Europe (Moscow)', value: 'Europe/Moscow' },
  { label: 'India (Kolkata)', value: 'Asia/Kolkata' },
  { label: 'China (Shanghai)', value: 'Asia/Shanghai' },
  { label: 'Japan (Tokyo)', value: 'Asia/Tokyo' },
  { label: 'Australia (Sydney)', value: 'Australia/Sydney' },
  { label: 'New Zealand (Auckland)', value: 'Pacific/Auckland' },
] as const;

/** Any timezone value the wizard's select doesn't list can still be set precisely with `/config set guild.timezone`. */
export const WIZARD_TIMEZONE_VALUES: readonly string[] = TIMEZONE_OPTIONS.map((option) => option.value);

type WizardComponentRow =
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<RoleSelectMenuBuilder>
  | ActionRowBuilder<ChannelSelectMenuBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>;

export interface RenderedStep {
  embeds: EmbedBuilder[];
  components: WizardComponentRow[];
}

function navRow(
  userId: string,
  options: { back: boolean; next: boolean; finish: boolean },
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('admin', 'wizard-back', userId))
      .setLabel('◀ Back')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!options.back),
  );

  if (options.finish) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('admin', 'wizard-finish', userId))
        .setLabel('Finish ✅')
        .setStyle(ButtonStyle.Success),
    );
  } else {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('admin', 'wizard-next', userId))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!options.next),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('admin', 'wizard-cancel', userId))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
  return row;
}

function stepDescription(stepId: WizardStepId): string {
  switch (stepId) {
    case 'roles':
      return 'Pick the roles that should count as staff. Anyone with a matching Discord permission (Manage Server, Ban Members, etc.) is recognized automatically too, even without a role picked here.';
    case 'channels':
      return 'Pick where moderation case logs and staff-only discussion should go. Both are optional and can be changed later.';
    case 'locale-timezone':
      return 'Pick the server locale and timezone used for timestamps and scheduled features.';
    case 'plugins':
      return 'Pick which plugins should be enabled. You can change this anytime with /plugin enable and /plugin disable.';
    default:
      return '';
  }
}

function formatRoleList(roleIds: string[]): string {
  return roleIds.length > 0 ? roleIds.map((id) => `<@&${id}>`).join(', ') : '_None_';
}

function formatPluginList(pluginIds: PluginId[], manifests: PluginManifest[]): string {
  if (pluginIds.length === 0) return '_None_';
  const nameById = new Map(manifests.map((manifest) => [manifest.id, manifest.name] as const));
  return pluginIds.map((id) => nameById.get(id) ?? id).join(', ');
}

/** Renders the current step's embed + components for a wizard session. `manifests` is only used by the 'plugins' step. */
export function renderWizardStep(session: WizardSession, manifests: PluginManifest[]): RenderedStep {
  const stepId = WIZARD_STEP_IDS[session.stepIndex];
  const { userId, data } = session;
  const isFirst = session.stepIndex === 0;
  const isLast = session.stepIndex === WIZARD_STEP_IDS.length - 1;

  const embed = brandEmbed()
    .setTitle(`Server setup — step ${session.stepIndex + 1} of ${WIZARD_STEP_IDS.length}`)
    .setDescription(stepDescription(stepId));

  switch (stepId) {
    case 'roles': {
      const adminSelect = new RoleSelectMenuBuilder()
        .setCustomId(buildCustomId('admin', 'wizard-role-admin', userId))
        .setPlaceholder('Admin staff roles (optional)')
        .setMinValues(0)
        .setMaxValues(5);
      if (data.adminRoleIds.length > 0) adminSelect.setDefaultRoles(...data.adminRoleIds.slice(0, 5));

      const modSelect = new RoleSelectMenuBuilder()
        .setCustomId(buildCustomId('admin', 'wizard-role-mod', userId))
        .setPlaceholder('Moderator staff roles (optional)')
        .setMinValues(0)
        .setMaxValues(5);
      if (data.modRoleIds.length > 0) modSelect.setDefaultRoles(...data.modRoleIds.slice(0, 5));

      const helperSelect = new RoleSelectMenuBuilder()
        .setCustomId(buildCustomId('admin', 'wizard-role-helper', userId))
        .setPlaceholder('Helper staff roles (optional)')
        .setMinValues(0)
        .setMaxValues(5);
      if (data.helperRoleIds.length > 0) helperSelect.setDefaultRoles(...data.helperRoleIds.slice(0, 5));

      embed.addFields(
        { name: 'Admin roles', value: formatRoleList(data.adminRoleIds) },
        { name: 'Moderator roles', value: formatRoleList(data.modRoleIds) },
        { name: 'Helper roles', value: formatRoleList(data.helperRoleIds) },
      );

      return {
        embeds: [embed],
        components: [
          new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(adminSelect),
          new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(modSelect),
          new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(helperSelect),
          navRow(userId, { back: !isFirst, next: true, finish: false }),
        ],
      };
    }

    case 'channels': {
      const modLogSelect = new ChannelSelectMenuBuilder()
        .setCustomId(buildCustomId('admin', 'wizard-channel-modlog', userId))
        .setPlaceholder('Moderation log channel (optional)')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(0)
        .setMaxValues(1);
      if (data.modLogChannelId) modLogSelect.setDefaultChannels(data.modLogChannelId);

      const staffSelect = new ChannelSelectMenuBuilder()
        .setCustomId(buildCustomId('admin', 'wizard-channel-staff', userId))
        .setPlaceholder('Staff channel (optional)')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(0)
        .setMaxValues(1);
      if (data.staffChannelId) staffSelect.setDefaultChannels(data.staffChannelId);

      embed.addFields(
        { name: 'Mod-log channel', value: data.modLogChannelId ? `<#${data.modLogChannelId}>` : '_Not set_' },
        { name: 'Staff channel', value: data.staffChannelId ? `<#${data.staffChannelId}>` : '_Not set_' },
      );

      return {
        embeds: [embed],
        components: [
          new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(modLogSelect),
          new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(staffSelect),
          navRow(userId, { back: !isFirst, next: true, finish: false }),
        ],
      };
    }

    case 'locale-timezone': {
      const localeSelect = new StringSelectMenuBuilder()
        .setCustomId(buildCustomId('admin', 'wizard-locale', userId))
        .setPlaceholder('More languages coming soon')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions([{ label: 'English', value: 'en', default: data.locale === 'en' }]);

      const timezoneSelect = new StringSelectMenuBuilder()
        .setCustomId(buildCustomId('admin', 'wizard-timezone', userId))
        .setPlaceholder('Timezone (set a precise one anytime with /config set guild.timezone)')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          TIMEZONE_OPTIONS.map((option) => ({ ...option, default: option.value === data.timezone })),
        );

      embed.addFields({ name: 'Locale', value: data.locale }, { name: 'Timezone', value: data.timezone });

      return {
        embeds: [embed],
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(localeSelect),
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(timezoneSelect),
          navRow(userId, { back: !isFirst, next: true, finish: false }),
        ],
      };
    }

    case 'plugins': {
      const togglable = manifests.filter((manifest) => !manifest.alwaysEnabled);
      embed.addFields({
        name: 'Plugins to enable',
        value: formatPluginList(data.enabledPluginIds, manifests),
      });

      const components: WizardComponentRow[] = [];
      if (togglable.length > 0) {
        const pluginSelect = new StringSelectMenuBuilder()
          .setCustomId(buildCustomId('admin', 'wizard-plugins', userId))
          .setPlaceholder('Plugins to enable')
          .setMinValues(0)
          .setMaxValues(togglable.length)
          .addOptions(
            togglable.map((manifest) => ({
              label: manifest.name,
              value: manifest.id,
              description: manifest.description.slice(0, 100),
              default: data.enabledPluginIds.includes(manifest.id),
            })),
          );
        components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pluginSelect));
      }
      components.push(navRow(userId, { back: !isFirst, next: false, finish: isLast }));

      return { embeds: [embed], components };
    }

    default: {
      const exhaustive: never = stepId;
      throw new Error(`Unknown wizard step: ${String(exhaustive)}`);
    }
  }
}

/**
 * Persists the completed wizard: writes `GuildConfig` (roles, channels, locale, timezone, `setupCompletedAt`),
 * diffs `enabledPluginIds` against current plugin enablement and enables/disables accordingly, and mirrors the
 * relevant fields into admin's own `PluginConfig`. Returns the resulting `GuildConfig`.
 */
export async function finishWizard(
  session: WizardSession,
  host: HostService,
  actor: { id: string; source: 'bot' },
): Promise<GuildConfigData> {
  const updated = await host.updateGuildConfig(
    session.guildId,
    {
      adminRoleIds: session.data.adminRoleIds,
      modRoleIds: session.data.modRoleIds,
      helperRoleIds: session.data.helperRoleIds,
      modLogChannelId: session.data.modLogChannelId,
      staffChannelId: session.data.staffChannelId,
      locale: session.data.locale,
      timezone: session.data.timezone,
      setupCompletedAt: new Date().toISOString(),
    },
    actor,
  );

  const manifests = host.listManifests();
  for (const manifest of manifests) {
    if (manifest.alwaysEnabled) continue;
    const shouldEnable = session.data.enabledPluginIds.includes(manifest.id);
    const isEnabled = await host.isPluginEnabled(session.guildId, manifest.id);
    if (shouldEnable && !isEnabled) {
      await host.enable(session.guildId, manifest.id, actor);
    } else if (!shouldEnable && isEnabled) {
      await host.disable(session.guildId, manifest.id, actor);
    }
  }

  await host.setPluginConfig(
    session.guildId,
    'admin',
    { setupCompleted: true, staffChannelId: session.data.staffChannelId, fastActions: updated.fastActions },
    actor,
  );

  return updated;
}
