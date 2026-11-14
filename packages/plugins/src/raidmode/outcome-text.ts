import type { LockdownOutcome, RestoreOutcome } from './incident';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** What staff are told after pressing "Lock down now" or running `/raidmode lockdown`. */
export function lockdownMessage(outcome: LockdownOutcome, t: Translate): { ok: boolean; text: string } {
  switch (outcome.status) {
    case 'locked': {
      const vars = {
        actions: outcome.incident.lockdownActions.join(', '),
        channels: outcome.channelsLocked,
        failures: outcome.failures,
      };
      const head = t(outcome.failures > 0 ? 'lockdown.lockedWithFailures' : 'lockdown.locked', vars);
      return { ok: true, text: `${head} ${t('lockdown.restoreHint')}` };
    }
    case 'already_locked':
      return { ok: false, text: t('lockdown.alreadyLocked') };
    case 'nothing_to_lock':
      return { ok: false, text: t('lockdown.nothingToLock') };
    case 'busy':
      return { ok: false, text: t('busy') };
    case 'not_found':
      return { ok: false, text: t('notFound') };
  }
}

const SKIP_KEY: Record<string, string> = {
  changed_by_admin: 'restore.skipChangedByAdmin',
  channel_deleted: 'restore.skipChannelDeleted',
};

/** What staff are told after pressing "Restore permissions" or running `/raidmode restore`. */
export function restoreMessage(outcome: RestoreOutcome, t: Translate): { ok: boolean; text: string } {
  switch (outcome.status) {
    case 'restored':
    case 'partially_restored': {
      const lines = [t('restore.restored', { count: outcome.restored })];
      for (const s of outcome.skipped) {
        const where = s.channelId ? `<#${s.channelId}>` : s.kind.toLowerCase().replace('_', ' ');
        const key = SKIP_KEY[s.reason];
        lines.push(t('restore.skippedChannel', { where, why: key ? t(key) : s.reason }));
      }
      if (outcome.failed > 0) lines.push(t('restore.retry', { count: outcome.failed }));
      return { ok: outcome.status === 'restored', text: lines.join('\n') };
    }
    case 'not_locked':
      return { ok: false, text: t('restore.notLocked') };
    case 'busy':
      return { ok: false, text: t('busy') };
    case 'not_found':
      return { ok: false, text: t('notFound') };
  }
}
