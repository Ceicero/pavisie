import { partialWithoutDefaults } from '@pavisie/core';
import { z } from 'zod';
import { guildIdParamSchema, snowflakeSchema } from '../schemas';

export const groupBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  roleIds: z.array(z.string().min(1)).max(25).default([]),
  exclusive: z.boolean().default(false),
  maxSelections: z.number().int().positive().max(25).nullable().default(null),
});
export const groupUpdateSchema = partialWithoutDefaults(groupBodySchema);
export const groupParamSchema = guildIdParamSchema.extend({ groupId: z.string().min(1) });

const welcomeGoodbyeBodySchema = z.object({
  enabled: z.boolean().optional(),
  channelId: z.string().nullable().optional(),
  message: z.string().max(2000).nullable().optional(),
  embed: z.record(z.string(), z.unknown()).nullable().optional(),
  dm: z.boolean().optional(),
});
export { welcomeGoodbyeBodySchema };

export const testMessageBodySchema = z.object({ channelId: z.string().min(1).optional() });

export const verificationSettingsBodySchema = z.object({
  mode: z.enum(['button', 'modal', 'captcha']).optional(),
  questions: z.array(z.string().min(1).max(300)).max(5).optional(),
  verifiedRoleId: z.string().nullable().optional(),
  staffChannelId: z.string().nullable().optional(),
  minAccountAgeDays: z.number().int().min(0).max(3650).optional(),
  underageAction: z.enum(['none', 'quarantine', 'kick']).optional(),
  quarantineRoleId: z.string().nullable().optional(),
});

export const onboardingConfigBodySchema = z.object({
  rulesText: z.string().max(4000).nullable().optional(),
  rulesRoleId: z.string().nullable().optional(),
  steps: z
    .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(200) }))
    .max(20)
    .optional(),
});

/** Partial patch for `config.roles.autoRoles`; limits mirror the plugin's `autoRolesSchema` (5 human / 3 bot roles, delay ≤ 7 days). */
export const autoRolesBodySchema = z.object({
  enabled: z.boolean().optional(),
  roleIds: z.array(snowflakeSchema).max(5).optional(),
  botRoleIds: z.array(snowflakeSchema).max(3).optional(),
  delaySeconds: z.number().int().min(0).max(604_800).optional(),
});

export const persistenceBodySchema = z.object({
  enabled: z.boolean(),
  maxDays: z.number().int().min(1).max(365).optional(),
  /** Required (and must equal the disclosure phrase) when turning persistence ON — a lightweight disclosure acknowledgement, mirroring the bot's `/roles persist on` always showing the same text. */
  acknowledge: z.boolean().optional(),
});
