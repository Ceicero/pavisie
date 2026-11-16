import type { z } from 'zod';
import type { wordFilterConfigSchema } from '../../schemas';
import { escapeRegExp } from '../text-utils';
import { NO_MATCH, type MessageEvaluator } from '../types';

type Config = z.infer<typeof wordFilterConfigSchema>;

interface CompiledWord {
  /** The word exactly as configured — what a match reports as evidence. */
  word: string;
  /** The word as it is compared: lowercased unless the rule is case-sensitive. */
  needle: string;
  /** Whole-word matcher, or `null` for a plain substring rule. Never global/sticky, so `test` keeps no state. */
  pattern: RegExp | null;
}

// Compiled once per config object instead of once per message. A whole-word rule used to build one RegExp per
// listed word for every message it saw — 200 compiles per message for a 200-word list — which was the largest
// single CPU cost of evaluating a message. The service keeps each rule's parsed config alive between messages,
// so the same object comes back here; a config that is edited arrives as a new object and is compiled afresh.
const compiledByConfig = new WeakMap<Config, CompiledWord[]>();

function compile(config: Config): CompiledWord[] {
  const cached = compiledByConfig.get(config);
  if (cached) return cached;

  const compiled = config.words.map((word) => {
    const needle = config.caseSensitive ? word : word.toLowerCase();
    return {
      word,
      needle,
      pattern: config.wholeWord
        ? new RegExp(`\\b${escapeRegExp(needle)}\\b`, config.caseSensitive ? '' : 'i')
        : null,
    };
  });
  compiledByConfig.set(config, compiled);
  return compiled;
}

/** Flags messages containing any of a configured word/phrase list. Requires the Message Content intent. */
export const evaluateWordFilter: MessageEvaluator<Config> = async ({ message }, config) => {
  const content = config.caseSensitive ? message.content : message.content.toLowerCase();

  for (const { word, needle, pattern } of compile(config)) {
    const found = pattern ? pattern.test(content) : content.includes(needle);

    if (found) {
      return {
        matched: true,
        reason: `Message contains a filtered word/phrase.`,
        evidence: { matchedWord: word },
      };
    }
  }

  return NO_MATCH;
};
