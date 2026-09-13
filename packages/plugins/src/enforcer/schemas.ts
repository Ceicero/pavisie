// Framework-free (no discord.js) so this file is safe to import from `apps/api` via the
// `@pavisie/plugins/enforcer/schemas` subpath without pulling in any gateway/command code
// (ARCHITECTURE.md §7.1's "manifest files must not import discord.js runtime code" rule extended
// here to every non-command file this plugin exposes for cross-process reuse).
import { z } from 'zod';
import { validateUserRegex } from '@pavisie/core';

export const MATCHER_TYPES = [
  'keyword',
  'phrase',
  'regex',
  'link_domain',
  'invite',
  'mention_count',
  'attachment_ext',
  'ai_category',
] as const;
export type MatcherType = (typeof MATCHER_TYPES)[number];

export const ENFORCER_DECISIONS = ['warn', 'timeout', 'mute', 'kick', 'ban', 'dismiss'] as const;
export type EnforcerDecisionLower = (typeof ENFORCER_DECISIONS)[number];

export const POLICY_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type PolicySeverityValue = (typeof POLICY_SEVERITIES)[number];

/** [{type, value, caseSensitive?, wholeWord?}] — ARCHITECTURE.md §19's `EnforcerPolicy.matchers` Json shape. */
export const matcherSchema = z
  .object({
    type: z.enum(MATCHER_TYPES),
    value: z.union([z.string().max(256), z.array(z.string().max(256)).max(50), z.number()]),
    caseSensitive: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
  })
  .superRefine((matcher, ctx) => {
    switch (matcher.type) {
      case 'mention_count': {
        if (typeof matcher.value !== 'number' || !Number.isInteger(matcher.value) || matcher.value < 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'mention_count matchers need an integer value >= 1.',
            path: ['value'],
          });
        }
        break;
      }
      case 'regex': {
        if (typeof matcher.value !== 'string' || matcher.value.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'regex matchers need a single pattern string.',
            path: ['value'],
          });
          break;
        }
        const flags = matcher.caseSensitive ? '' : 'i';
        const result = validateUserRegex(matcher.value, flags);
        if (!result.ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: result.error ?? 'Invalid regex pattern.',
            path: ['value'],
          });
        }
        break;
      }
      case 'invite': {
        // Presence-only matcher; any value is accepted (dashboard/commands send `true` or an empty string).
        break;
      }
      case 'keyword':
      case 'phrase':
      case 'attachment_ext': {
        const values = Array.isArray(matcher.value) ? matcher.value : [matcher.value];
        if (values.length === 0 || values.every((v) => typeof v !== 'string' || v.trim().length === 0)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${matcher.type} matchers need at least one non-empty value.`,
            path: ['value'],
          });
        }
        break;
      }
      case 'link_domain': {
        // Empty string/array is valid here — it means "match any link" (used by the external-links pack).
        if (typeof matcher.value === 'number') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'link_domain matchers need a string or list of domains.',
            path: ['value'],
          });
        }
        break;
      }
      case 'ai_category': {
        if (typeof matcher.value !== 'string' || matcher.value.trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'ai_category matchers need a category name.',
            path: ['value'],
          });
        }
        break;
      }
      default:
        break;
    }
  });

export type MatcherInput = z.infer<typeof matcherSchema>;

export const policyMatchersSchema = z.array(matcherSchema).min(1).max(25);

/** Returns `matcher.value` normalized to a string array, regardless of whether it was stored as a string, array, or number. */
export function matcherValues(matcher: Pick<MatcherInput, 'value'>): string[] {
  if (Array.isArray(matcher.value)) return matcher.value;
  return [String(matcher.value)];
}

export const enforcerDecisionSchema = z.enum(ENFORCER_DECISIONS);
export const policySeveritySchema = z.enum(POLICY_SEVERITIES);
