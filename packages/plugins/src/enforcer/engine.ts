// Pure, discord.js-free policy engine (ARCHITECTURE.md §19). Everything here operates on plain data so it is
// fully unit-testable without a gateway connection — `normalize.ts` builds `NormalizedMessage` from a real
// discord.js `Message`, and `service.ts` is the only caller that touches Discord/Prisma.
import { safeTest, sanitizeEmbedText, truncate } from '@pavisie/core';
import { matcherValues, type MatcherInput, type PolicySeverityValue } from './schemas';

/** A minimal, discord.js-free view of a message, so the engine is pure and unit-testable (ARCHITECTURE.md §19). */
export interface NormalizedMessage {
  content: string;
  authorId: string;
  authorRoleIds: string[];
  channelId: string;
  mentionsCount: number;
  attachments: { name: string; contentType?: string }[];
  links: string[];
  invites: string[];
  isStaff: boolean;
}

/** A policy in the shape the engine needs — a trimmed projection of `EnforcerPolicy` (ARCHITECTURE.md §19). */
export interface Policy {
  id: string;
  name: string;
  enabled: boolean;
  severity: PolicySeverityValue;
  matchers: MatcherInput[];
  channelIds: string[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
}

export interface Match {
  policyId: string;
  policyName: string;
  severity: PolicySeverityValue;
  /** Human-readable summary of which matcher(s) fired, e.g. "keyword: foo, bar · invite link". */
  matcherSummary: string;
}

export interface EvaluateOptions {
  /** Skips policies whose scope requires it, when the message author is staff (ARCHITECTURE.md §19 `exemptStaff`). Callers that already filtered staff out of `message.isStaff` don't need this. */
  exemptStaffGlobally?: boolean;
}

const SEVERITY_RANK: Record<PolicySeverityValue, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

const CONTROL_CHARS_ESCAPE = /[.*+?^${}()|[\]\\]/g;
function escapeRegExp(input: string): string {
  return input.replace(CONTROL_CHARS_ESCAPE, '\\$&');
}

function matchesKeyword(message: NormalizedMessage, matcher: MatcherInput): boolean {
  const values = matcherValues(matcher);
  const caseSensitive = matcher.caseSensitive ?? false;
  const wholeWord = matcher.wholeWord ?? true;
  const content = message.content;

  return values.some((value) => {
    if (value.trim().length === 0) return false;
    if (wholeWord) {
      const pattern = new RegExp(`\\b${escapeRegExp(value)}\\b`, caseSensitive ? '' : 'i');
      return safeTest(pattern, content);
    }
    return caseSensitive ? content.includes(value) : content.toLowerCase().includes(value.toLowerCase());
  });
}

function matchesPhrase(message: NormalizedMessage, matcher: MatcherInput): boolean {
  const values = matcherValues(matcher);
  const caseSensitive = matcher.caseSensitive ?? false;
  const content = caseSensitive ? message.content : message.content.toLowerCase();

  return values.some((value) => {
    if (value.trim().length === 0) return false;
    const needle = caseSensitive ? value : value.toLowerCase();
    return content.includes(needle);
  });
}

function matchesRegex(message: NormalizedMessage, matcher: MatcherInput): boolean {
  if (typeof matcher.value !== 'string' || matcher.value.length === 0) return false;
  const flags = matcher.caseSensitive ? '' : 'i';
  try {
    const re = new RegExp(matcher.value, flags);
    return safeTest(re, message.content);
  } catch {
    // Should never happen for a matcher that passed `validateUserRegex` at save time; fail closed (no match)
    // rather than throw mid-evaluation of a batch of policies.
    return false;
  }
}

function hostnameOf(link: string): string | null {
  try {
    return new URL(link).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchesLinkDomain(message: NormalizedMessage, matcher: MatcherInput): boolean {
  const values = matcherValues(matcher).filter((v) => v.trim().length > 0);
  // Empty value list means "match any link at all" — used by the shipped `external-links` policy pack, since
  // the matcher vocabulary has no dedicated "any link" type (ARCHITECTURE.md §19 lists exactly these 8 types).
  if (values.length === 0) {
    return message.links.length > 0;
  }
  return message.links.some((link) => {
    const hostname = hostnameOf(link);
    if (!hostname) return false;
    return values.some((domain) => {
      const needle = domain.toLowerCase().replace(/^\*\./, '');
      return hostname === needle || hostname.endsWith(`.${needle}`);
    });
  });
}

function matchesInvite(message: NormalizedMessage): boolean {
  return message.invites.length > 0;
}

function matchesMentionCount(message: NormalizedMessage, matcher: MatcherInput): boolean {
  const threshold = typeof matcher.value === 'number' ? matcher.value : Number(matcher.value);
  if (!Number.isFinite(threshold)) return false;
  return message.mentionsCount >= threshold;
}

function matchesAttachmentExt(message: NormalizedMessage, matcher: MatcherInput): boolean {
  const values = matcherValues(matcher).map((v) => v.toLowerCase().replace(/^\./, ''));
  if (values.length === 0) return false;
  return message.attachments.some((att) => {
    const dot = att.name.lastIndexOf('.');
    if (dot === -1) return false;
    const ext = att.name.slice(dot + 1).toLowerCase();
    return values.includes(ext);
  });
}

/**
 * Tests a single matcher against a message. `ai_category` never matches here — it is a purely assistive
 * signal produced asynchronously by the optional `ai` service (ARCHITECTURE.md §19 "Optional AI assistance
 * only annotates a flag ... it never decides or acts"), so the deterministic engine always skips it.
 */
function matchOne(message: NormalizedMessage, matcher: MatcherInput): boolean {
  switch (matcher.type) {
    case 'keyword':
      return matchesKeyword(message, matcher);
    case 'phrase':
      return matchesPhrase(message, matcher);
    case 'regex':
      return matchesRegex(message, matcher);
    case 'link_domain':
      return matchesLinkDomain(message, matcher);
    case 'invite':
      return matchesInvite(message);
    case 'mention_count':
      return matchesMentionCount(message, matcher);
    case 'attachment_ext':
      return matchesAttachmentExt(message, matcher);
    case 'ai_category':
      return false;
    default:
      return false;
  }
}

function describeMatcher(matcher: MatcherInput): string {
  switch (matcher.type) {
    case 'keyword':
      return `keyword: ${matcherValues(matcher).join(', ')}`;
    case 'phrase':
      return `phrase: ${matcherValues(matcher).join(', ')}`;
    case 'regex':
      return `regex: ${String(matcher.value)}`;
    case 'link_domain':
      return matcherValues(matcher).filter((v) => v.trim().length > 0).length > 0
        ? `link domain: ${matcherValues(matcher).join(', ')}`
        : 'link domain: any link';
    case 'invite':
      return 'Discord invite link';
    case 'mention_count':
      return `mention count >= ${String(matcher.value)}`;
    case 'attachment_ext':
      return `attachment type: ${matcherValues(matcher).join(', ')}`;
    case 'ai_category':
      return `AI category: ${String(matcher.value)} (assistive only)`;
    default:
      return matcher.type;
  }
}

/**
 * Evaluates `message` against every enabled `policies` entry, respecting channel scope and role/channel
 * exemptions, and returns every policy that matched — highest severity first (ARCHITECTURE.md §19). Pure and
 * synchronous by design so it can be unit-tested without any I/O.
 */
export function evaluate(
  message: NormalizedMessage,
  policies: Policy[],
  options: EvaluateOptions = {},
): Match[] {
  if (options.exemptStaffGlobally && message.isStaff) return [];

  const matches: Match[] = [];

  for (const policy of policies) {
    if (!policy.enabled) continue;
    if (policy.channelIds.length > 0 && !policy.channelIds.includes(message.channelId)) continue;
    if (policy.exemptChannelIds.includes(message.channelId)) continue;
    if (
      policy.exemptRoleIds.length > 0 &&
      message.authorRoleIds.some((roleId) => policy.exemptRoleIds.includes(roleId))
    )
      continue;

    const fired = policy.matchers.filter((matcher) => matchOne(message, matcher));
    if (fired.length === 0) continue;

    matches.push({
      policyId: policy.id,
      policyName: policy.name,
      severity: policy.severity,
      matcherSummary: fired.map(describeMatcher).join(' · '),
    });
  }

  matches.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return matches;
}

/** Builds a sanitized, length-capped excerpt for ledger/flag-queue embeds (ARCHITECTURE.md §19): mentions stripped, then truncated. */
export function buildExcerpt(content: string, excerptMaxChars: number): string {
  return sanitizeEmbedText(truncate(content, excerptMaxChars), excerptMaxChars);
}
