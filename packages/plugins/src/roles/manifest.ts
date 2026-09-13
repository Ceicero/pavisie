import { PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { defineManifest } from '../sdk';

const welcomeGoodbyeSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: z.string().nullable().default(null),
  message: z.string().max(2000).nullable().default(null),
  /** Raw embed JSON (title/description/color/fields/footer/etc) built via the `/welcome embed` modal or the dashboard. */
  embed: z.record(z.string(), z.unknown()).nullable().default(null),
  dm: z.boolean().default(false),
});

const onboardingStepSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
});

const verificationSchema = z.object({
  mode: z.enum(['button', 'modal', 'captcha']).default('button'),
  questions: z.array(z.string().min(1).max(300)).max(5).default([]),
  verifiedRoleId: z.string().nullable().default(null),
  staffChannelId: z.string().nullable().default(null),
  minAccountAgeDays: z.number().int().min(0).max(3650).default(0),
  underageAction: z.enum(['none', 'quarantine', 'kick']).default('none'),
  quarantineRoleId: z.string().nullable().default(null),
});

const rolePersistenceSchema = z.object({
  enabled: z.boolean().default(false),
  maxDays: z.number().int().min(1).max(365).default(30),
});

/** A Discord snowflake id (17-20 decimal digits). Mirrors `apps/api/src/lib/schemas.ts`'s `snowflakeSchema` —
 * kept as a local literal rather than a cross-package import so this plugin package stays free of an `@pavisie/api`
 * dependency edge. */
const roleSnowflakeSchema = z.string().regex(/^\d{17,20}$/, 'Must be a valid Discord snowflake id.');

/** Auto-roles: roles handed to every member (humans / bots separately) once they've fully joined (after Discord's membership screening, if on). */
const autoRolesSchema = z.object({
  enabled: z.boolean().default(false),
  /** Roles given to human members. */
  roleIds: z.array(roleSnowflakeSchema).max(5).default([]),
  /** Roles given to bot accounts (many servers tag bots). */
  botRoleIds: z.array(roleSnowflakeSchema).max(3).default([]),
  /** 0 = immediately; otherwise queue a delayed job. Max 7 days. */
  delaySeconds: z.number().int().min(0).max(604_800).default(0),
});

export const AUTO_ROLES_MAX_HUMAN = 5;
export const AUTO_ROLES_MAX_BOT = 3;
export const AUTO_ROLES_MAX_DELAY_SECONDS = 604_800;

export const configSchema = z.object({
  /** When false (default), role panels / groups refuse to attach a role that grants an elevated permission. */
  allowElevatedRoles: z.boolean().default(false),
  welcome: welcomeGoodbyeSchema.default({}),
  goodbye: welcomeGoodbyeSchema.default({}),
  rulesText: z.string().max(4000).nullable().default(null),
  rulesRoleId: z.string().nullable().default(null),
  steps: z.array(onboardingStepSchema).max(20).default([]),
  verification: verificationSchema.default({}),
  rolePersistence: rolePersistenceSchema.default({}),
  autoRoles: autoRolesSchema.default({}),
});

export type RolesConfig = z.infer<typeof configSchema>;
export type WelcomeGoodbyeConfig = z.infer<typeof welcomeGoodbyeSchema>;
export type OnboardingStepConfig = z.infer<typeof onboardingStepSchema>;
export type VerificationConfig = z.infer<typeof verificationSchema>;
export type RolePersistenceConfig = z.infer<typeof rolePersistenceSchema>;
export type AutoRolesConfig = z.infer<typeof autoRolesSchema>;

export const manifest = defineManifest({
  id: 'roles',
  name: 'Roles & Onboarding',
  description:
    'Self-assignable role panels, welcome/goodbye messages, onboarding checklists, rules acknowledgement, and member verification (button, staff-approved modal, or CAPTCHA).',
  category: 'community',
  version: '0.1.0',
  defaultEnabled: false,
  permissions: [
    {
      permission: PermissionFlagsBits.ManageRoles,
      feature: 'role panels / verification / role persistence / auto-roles',
      optional: false,
      fallback: 'Role assignment fails with a clear error until Manage Roles is granted.',
    },
    {
      permission: PermissionFlagsBits.SendMessages,
      feature: 'posting panels, welcome/goodbye, onboarding rules',
      optional: false,
      fallback: 'Messages cannot be posted to the configured channel.',
    },
    {
      permission: PermissionFlagsBits.EmbedLinks,
      feature: 'panel / welcome / goodbye / onboarding embeds',
      optional: false,
      fallback: 'Falls back to plain text where possible.',
    },
    {
      permission: PermissionFlagsBits.AddReactions,
      feature: 'reaction-style role panels',
      optional: true,
      fallback: 'Reaction panels cannot add the initial reactions; button/select panels are unaffected.',
    },
    {
      permission: PermissionFlagsBits.ManageChannels,
      feature: 'account-age quarantine channel visibility (optional)',
      optional: true,
      fallback: 'Quarantine still applies the role; channel overwrites are left as configured manually.',
    },
    {
      permission: PermissionFlagsBits.KickMembers,
      feature: 'account-age gate: kick action',
      optional: true,
      fallback: 'The kick action is skipped with a warning logged if this permission is missing.',
    },
  ],
  intents: [],
  privilegedIntents: ['GuildMembers'],
  requiredEnv: [],
  optionalEnv: [
    'CAPTCHA_PROVIDER',
    'HCAPTCHA_SITE_KEY',
    'HCAPTCHA_SECRET',
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET',
    'API_BASE_URL',
  ],
  configSchema,
  dashboard: { path: '/dashboard/[guildId]/roles', label: 'Roles & Onboarding', icon: 'users' },
  privacyNotes: [
    "Verification (modal mode) stores the member's submitted answers on the pending request until a staff decision is made.",
    "Role persistence, when enabled by an admin, stores a snapshot of a leaving member's roles (excluding elevated/managed roles) for up to the configured number of days so they can be restored on rejoin. Disabled by default and clearly disclosed in `/roles persist`.",
    "The account-age gate and membership screening only ever read a member's Discord account-creation date and `pending` flag — no additional data is collected.",
    'Auto-roles store nothing about members; a delayed auto-role keeps only the member id in a scheduled job until it fires.',
  ],
});
