import { hasStaffLevel } from '@pavisie/core';
import type { StaffLevel } from '@pavisie/types';

export interface DjGateInput {
  /** The guild's configured DJ role, or `null` if none is set. */
  djRoleId: string | null;
  staffLevel: StaffLevel;
  memberRoleIds: string[];
  /** True if the invoking user is the only non-bot member in their current voice channel (or not in one at all counts as false — see callers). */
  isAloneInVoiceChannel: boolean;
}

/**
 * DJ role gate for mutating `/music` subcommands (skip/pause/resume/volume/loop/stop/shuffle/playlist
 * save|load|delete): when a DJ role is configured, only members with that role may use them; when unset, staff
 * (helper+) or a member who is alone in their voice channel may.
 */
export function hasDjPermission(input: DjGateInput): boolean {
  if (input.djRoleId) {
    return input.memberRoleIds.includes(input.djRoleId);
  }
  return hasStaffLevel(input.staffLevel, 'helper') || input.isAloneInVoiceChannel;
}
