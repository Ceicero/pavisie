import { z } from 'zod';
import { matcherSchema, policyMatchersSchema } from '@pavisie/plugins/enforcer/schemas';
import { guildIdParamSchema, paginationQuerySchema, snowflakeSchema } from '../schemas';

export { matcherSchema };

const decisionSchema = z.enum(['WARN', 'TIMEOUT', 'MUTE', 'UNMUTE', 'KICK', 'BAN', 'DISMISS']);
const severitySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/** `PUT /:guildId/enforcer/settings` — mirrors `EnforcerConfig` (packages/plugins/src/enforcer/manifest.ts) field-for-field. */
export const enforcerSettingsPatchSchema = z
  .object({
    ledgerChannelId: snowflakeSchema.nullable(),
    ledgerVisibility: z.enum(['staff', 'everyone']),
    flagChannelId: snowflakeSchema.nullable(),
    muteRoleId: snowflakeSchema.nullable(),
    captureContext: z.boolean(),
    contextBefore: z.number().int().min(1).max(15),
    contextAfter: z.number().int().min(0).max(10),
    excerptMaxChars: z.number().int().min(50).max(1000),
    autoFlagEnabled: z.boolean(),
    exemptStaff: z.boolean(),
    aiAssist: z.boolean(),
    dmOnAction: z.boolean(),
    defaultTimeoutMinutes: z.number().int().min(1).max(40320),
    defaultMuteMinutes: z.number().int().min(1).max(40320).nullable(),
    requireReasonOn: z.array(z.enum(['warn', 'timeout', 'mute', 'kick', 'ban'])),
    allowedDecisions: z.array(z.enum(['warn', 'timeout', 'mute', 'kick', 'ban', 'dismiss'])),
    banDeleteMessageSeconds: z.number().int().min(0).max(604800),
  })
  .partial();

export const policyBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  enabled: z.boolean().default(true),
  severity: severitySchema.default('MEDIUM'),
  matchers: policyMatchersSchema,
  channelIds: z.array(snowflakeSchema).max(50).default([]),
  exemptRoleIds: z.array(snowflakeSchema).max(50).default([]),
  exemptChannelIds: z.array(snowflakeSchema).max(50).default([]),
  suggestedAction: decisionSchema.nullable().default(null),
});

export const policyUpdateBodySchema = policyBodySchema.partial();

export const policyTestBodySchema = z.object({
  text: z.string().min(1).max(4000),
});

export const policyParamSchema = guildIdParamSchema.extend({ policyId: z.string().min(1) });

export const recordsQuerySchema = paginationQuerySchema.extend({
  userId: snowflakeSchema.optional(),
  kind: z.enum(['FLAG', 'DECISION', 'APPEAL_OPENED', 'APPEAL_DECIDED', 'NOTE']).optional(),
  decision: decisionSchema.optional(),
  status: z.enum(['PENDING', 'ACTIONED', 'DISMISSED', 'EXPIRED']).optional(),
  policyId: z.string().optional(),
  since: z.string().optional(),
});

export const recordParamSchema = guildIdParamSchema.extend({ recordNumber: z.coerce.number().int().min(1) });

export const decideBodySchema = z.object({
  decision: decisionSchema,
  reason: z.string().trim().max(1000).optional(),
  durationMs: z.number().int().positive().optional(),
  banDeleteMessageSeconds: z.number().int().min(0).max(604800).optional(),
});
