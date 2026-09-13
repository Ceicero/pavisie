import type { AutomodRule } from '@pavisie/database';

export interface ExemptionCheckInput {
  userId: string;
  channelId?: string | null;
  /** The acting member's role ids in the guild. */
  roleIds: string[];
  /** True if the acting member is at or above `helper` staff level (config.exemptStaff). */
  isStaff: boolean;
}

/** True if `input` is exempt from `rule` per its per-rule exemptions (roles/channels/users) plus the guild-wide `exemptStaff` toggle. */
export function isExempt(
  rule: Pick<AutomodRule, 'exemptRoleIds' | 'exemptChannelIds' | 'exemptUserIds'>,
  input: ExemptionCheckInput,
  exemptStaff: boolean,
): boolean {
  if (exemptStaff && input.isStaff) return true;
  if (rule.exemptUserIds.includes(input.userId)) return true;
  if (input.channelId && rule.exemptChannelIds.includes(input.channelId)) return true;
  if (rule.exemptRoleIds.some((roleId) => input.roleIds.includes(roleId))) return true;
  return false;
}

/** True if `hostname` (or any of its parent domains) is in `trustedDomains` (SPEC.md §C: "trusted domains" exemption for link-based rules). */
export function isTrustedDomain(hostname: string, trustedDomains: string[]): boolean {
  const h = hostname.toLowerCase();
  return trustedDomains.some((domain) => {
    const d = domain.toLowerCase();
    return h === d || h.endsWith(`.${d}`);
  });
}
