import type { z } from 'zod';
import { safeTest } from '@pavisie/core';
import type { regexFilterConfigSchema } from '../../schemas';
import { NO_MATCH, type MessageEvaluator } from '../types';

type Config = z.infer<typeof regexFilterConfigSchema>;

/**
 * Flags messages matching an admin-supplied regex. `pattern`/`flags` are validated for catastrophic-backtracking
 * safety at save time (`validateUserRegex`, enforced by `automodRuleConfigSchema`'s `.superRefine`) — this
 * evaluator re-validates defensively (a corrupted/hand-edited config row should degrade to "no match", not throw)
 * and always matches via `safeTest` (bounded input length, `lastIndex` reset). Requires the Message Content intent.
 */
export const evaluateRegexFilter: MessageEvaluator<Config> = async ({ message }, config) => {
  let regex: RegExp;
  try {
    regex = new RegExp(config.pattern, config.flags);
  } catch {
    return NO_MATCH;
  }

  if (!safeTest(regex, message.content)) return NO_MATCH;

  return {
    matched: true,
    reason: 'Message matches the configured regex pattern.',
    evidence: { pattern: config.pattern, flags: config.flags },
  };
};
