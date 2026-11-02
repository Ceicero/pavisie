import { PermissionFlagsBits } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import {
  buildOnboardingChecklist,
  canActorManageRole,
  canDecideVerification,
  checkRoleAssignable,
  filterPersistableRoles,
  isElevatedPermissionBitfield,
  isSnapshotFresh,
  nextVerificationStatus,
  parseOnboardingProgress,
  passesAccountAgeGate,
  renderTemplate,
  renderTemplateDeep,
  resolveGroupSelection,
  selectAutoRoles,
} from '../engine';

describe('isElevatedPermissionBitfield / checkRoleAssignable', () => {
  it('flags Administrator, ManageRoles, BanMembers etc as elevated', () => {
    expect(isElevatedPermissionBitfield(PermissionFlagsBits.Administrator)).toBe(true);
    expect(isElevatedPermissionBitfield(PermissionFlagsBits.ManageRoles)).toBe(true);
    expect(isElevatedPermissionBitfield(PermissionFlagsBits.BanMembers)).toBe(true);
    expect(isElevatedPermissionBitfield(PermissionFlagsBits.MentionEveryone)).toBe(true);
  });

  it('does not flag a plain role with no elevated permissions', () => {
    expect(
      isElevatedPermissionBitfield(PermissionFlagsBits.SendMessages | PermissionFlagsBits.ViewChannel),
    ).toBe(false);
  });

  it('rejects an elevated role by default', () => {
    const result = checkRoleAssignable({
      permissionsBitfield: PermissionFlagsBits.KickMembers,
      position: 5,
      managed: false,
      botTopRolePosition: 10,
      allowElevatedRoles: false,
    });
    expect(result).toEqual({ ok: false, reason: 'elevated' });
  });

  it('allows an elevated role when allowElevatedRoles is true', () => {
    const result = checkRoleAssignable({
      permissionsBitfield: PermissionFlagsBits.KickMembers,
      position: 5,
      managed: false,
      botTopRolePosition: 10,
      allowElevatedRoles: true,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects a managed (integration) role even when allowElevatedRoles is true', () => {
    const result = checkRoleAssignable({
      permissionsBitfield: 0n,
      position: 5,
      managed: true,
      botTopRolePosition: 10,
      allowElevatedRoles: true,
    });
    expect(result).toEqual({ ok: false, reason: 'managed' });
  });

  it("rejects a role at or above the bot's own top role", () => {
    const atBotPosition = checkRoleAssignable({
      permissionsBitfield: 0n,
      position: 10,
      managed: false,
      botTopRolePosition: 10,
      allowElevatedRoles: false,
    });
    const aboveBotPosition = checkRoleAssignable({
      permissionsBitfield: 0n,
      position: 12,
      managed: false,
      botTopRolePosition: 10,
      allowElevatedRoles: false,
    });
    expect(atBotPosition).toEqual({ ok: false, reason: 'hierarchy' });
    expect(aboveBotPosition).toEqual({ ok: false, reason: 'hierarchy' });
  });

  it('allows a safe, low-position, unmanaged, non-elevated role', () => {
    const result = checkRoleAssignable({
      permissionsBitfield: PermissionFlagsBits.SendMessages,
      position: 2,
      managed: false,
      botTopRolePosition: 10,
      allowElevatedRoles: false,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('renderTemplate / renderTemplateDeep', () => {
  const vars = {
    user: 'Alex',
    'user.tag': 'Alex#0001',
    'user.id': '123',
    server: 'Test Server',
    memberCount: 42,
    mention: '<@123>',
  };

  it('substitutes every known template token', () => {
    const out = renderTemplate(
      'Welcome {user} ({user.tag} / {user.id}) to {server}! We now have {memberCount} members. Say hi {mention}.',
      vars,
    );
    expect(out).toBe('Welcome Alex (Alex#0001 / 123) to Test Server! We now have 42 members. Say hi <@123>.');
  });

  it('leaves unknown tokens literal instead of throwing or evaluating them', () => {
    const out = renderTemplate('Hello {user}, your {unknownVar} stays as-is.', vars);
    expect(out).toBe('Hello Alex, your {unknownVar} stays as-is.');
  });

  it("does not recursively re-substitute a variable's own value (no injection via a var containing another token)", () => {
    const injected = renderTemplate('{user}', { ...vars, user: '{server}' });
    expect(injected).toBe('{server}');
  });

  it('is not fooled by malicious-looking content inside a variable value', () => {
    const out = renderTemplate('msg: {user}', { ...vars, user: '"; DROP TABLE users; --' });
    expect(out).toBe('msg: "; DROP TABLE users; --');
  });

  it('renderTemplateDeep renders every string field of a nested embed object', () => {
    const out = renderTemplateDeep(
      {
        title: 'Hi {user}',
        fields: [{ name: 'Server', value: '{server}' }],
        footer: { text: '{memberCount} members' },
        color: 0xffffff,
      },
      vars,
    );
    expect(out).toEqual({
      title: 'Hi Alex',
      fields: [{ name: 'Server', value: 'Test Server' }],
      footer: { text: '42 members' },
      color: 0xffffff,
    });
  });
});

describe('resolveGroupSelection', () => {
  const exclusiveGroup = { roleIds: ['a', 'b', 'c'], exclusive: true, maxSelections: null };

  it('exclusive group: selecting a new role removes the previously-held one', () => {
    const result = resolveGroupSelection(exclusiveGroup, ['b'], ['a']);
    expect(result).toEqual({ toAdd: ['b'], toRemove: ['a'], truncated: false });
  });

  it('exclusive group: requesting multiple roles truncates to the first and flags truncated', () => {
    const result = resolveGroupSelection(exclusiveGroup, ['a', 'b', 'c'], []);
    expect(result.toAdd).toEqual(['a']);
    expect(result.truncated).toBe(true);
  });

  it('max-selection group: keeps up to the cap, drops the excess', () => {
    const group = { roleIds: ['a', 'b', 'c', 'd'], exclusive: false, maxSelections: 2 };
    const result = resolveGroupSelection(group, ['a', 'b', 'c'], []);
    expect(result.toAdd).toEqual(['a', 'b']);
    expect(result.truncated).toBe(true);
  });

  it('no limit (maxSelections null, not exclusive): everything requested is kept', () => {
    const group = { roleIds: ['a', 'b', 'c'], exclusive: false, maxSelections: null };
    const result = resolveGroupSelection(group, ['a', 'b', 'c'], []);
    expect(result).toEqual({ toAdd: ['a', 'b', 'c'], toRemove: [], truncated: false });
  });

  it('ignores role ids outside the group entirely', () => {
    const group = { roleIds: ['a', 'b'], exclusive: false, maxSelections: null };
    const result = resolveGroupSelection(group, ['a', 'zzz'], []);
    expect(result.toAdd).toEqual(['a']);
  });

  it('deselecting removes it from currentGroupRoleIds without touching roles outside the group', () => {
    const group = { roleIds: ['a', 'b'], exclusive: false, maxSelections: null };
    const result = resolveGroupSelection(group, [], ['a']);
    expect(result).toEqual({ toAdd: [], toRemove: ['a'], truncated: false });
  });
});

describe('passesAccountAgeGate', () => {
  const now = new Date('2026-08-16T00:00:00Z');

  it('always passes when the gate is off (0 days)', () => {
    expect(passesAccountAgeGate(now, 0, now)).toBe(true);
  });

  it('fails an account created today when 7 days are required', () => {
    expect(passesAccountAgeGate(now, 7, now)).toBe(false);
  });

  it('passes an account exactly at the boundary', () => {
    const created = new Date(now.getTime() - 7 * 86_400_000);
    expect(passesAccountAgeGate(created, 7, now)).toBe(true);
  });

  it('passes an account well older than required', () => {
    const created = new Date(now.getTime() - 365 * 86_400_000);
    expect(passesAccountAgeGate(created, 7, now)).toBe(true);
  });
});

describe('filterPersistableRoles', () => {
  it('excludes @everyone, elevated, and managed roles; keeps everything else', () => {
    const result = filterPersistableRoles({
      roleIds: ['everyone', 'elevated1', 'managed1', 'safe1', 'safe2'],
      elevatedRoleIds: new Set(['elevated1']),
      managedRoleIds: new Set(['managed1']),
      everyoneRoleId: 'everyone',
    });
    expect(result).toEqual(['safe1', 'safe2']);
  });

  it('returns an empty array when nothing is safe to persist', () => {
    const result = filterPersistableRoles({
      roleIds: ['everyone', 'elevated1'],
      elevatedRoleIds: new Set(['elevated1']),
      managedRoleIds: new Set(),
      everyoneRoleId: 'everyone',
    });
    expect(result).toEqual([]);
  });
});

describe('isSnapshotFresh', () => {
  const now = new Date('2026-08-16T00:00:00Z');

  it('a snapshot from today is fresh under any positive maxDays', () => {
    expect(isSnapshotFresh(now, 1, now)).toBe(true);
  });

  it('a snapshot older than maxDays is not fresh', () => {
    const leftAt = new Date(now.getTime() - 31 * 86_400_000);
    expect(isSnapshotFresh(leftAt, 30, now)).toBe(false);
  });

  it('a snapshot exactly at maxDays is still fresh (inclusive boundary)', () => {
    const leftAt = new Date(now.getTime() - 30 * 86_400_000);
    expect(isSnapshotFresh(leftAt, 30, now)).toBe(true);
  });
});

describe('verification state machine', () => {
  it('only PENDING requests can be decided', () => {
    expect(canDecideVerification('PENDING')).toBe(true);
    expect(canDecideVerification('APPROVED')).toBe(false);
    expect(canDecideVerification('DENIED')).toBe(false);
    expect(canDecideVerification('EXPIRED')).toBe(false);
  });

  it('maps approve/deny to the resulting status', () => {
    expect(nextVerificationStatus(true)).toBe('APPROVED');
    expect(nextVerificationStatus(false)).toBe('DENIED');
  });
});

describe('onboarding progress', () => {
  it('parseOnboardingProgress tolerates null/malformed input', () => {
    expect(parseOnboardingProgress(null)).toEqual({ customSteps: {} });
    expect(parseOnboardingProgress('not an object')).toEqual({ customSteps: {} });
    expect(parseOnboardingProgress({})).toEqual({ customSteps: {} });
  });

  it('parseOnboardingProgress round-trips a well-formed value', () => {
    const value = { customSteps: { step1: true }, verifiedAt: '2026-01-01T00:00:00Z' };
    expect(parseOnboardingProgress(value)).toEqual({
      customSteps: { step1: true },
      verifiedAt: '2026-01-01T00:00:00Z',
      rolesPickedAt: undefined,
    });
  });

  it('buildOnboardingChecklist reports done/not-done for built-in and custom steps', () => {
    const items = buildOnboardingChecklist({
      rulesConfigured: true,
      rulesAcceptedAt: new Date(),
      verificationEnabled: true,
      progress: {
        customSteps: { intro: true },
        verifiedAt: undefined,
        rolesPickedAt: '2026-01-01T00:00:00Z',
      },
      customStepDefs: [
        { id: 'intro', label: 'Say hi' },
        { id: 'other', label: 'Other step' },
      ],
    });

    expect(items.find((i) => i.id === '__rules__')).toMatchObject({ done: true });
    expect(items.find((i) => i.id === '__verified__')).toMatchObject({ done: false });
    expect(items.find((i) => i.id === '__roles__')).toMatchObject({ done: true });
    expect(items.find((i) => i.id === 'intro')).toMatchObject({ done: true });
    expect(items.find((i) => i.id === 'other')).toMatchObject({ done: false });
  });
});

describe('selectAutoRoles', () => {
  const config = {
    enabled: true,
    roleIds: ['human1', 'human2'],
    botRoleIds: ['bot1'],
    delaySeconds: 0,
  };

  it('picks the human list for human members', () => {
    expect(selectAutoRoles({ isBot: false, config })).toEqual(['human1', 'human2']);
  });

  it('picks the bot list for bot accounts', () => {
    expect(selectAutoRoles({ isBot: true, config })).toEqual(['bot1']);
  });

  it('returns nothing when auto-roles are disabled', () => {
    expect(selectAutoRoles({ isBot: false, config: { ...config, enabled: false } })).toEqual([]);
  });

  it('collapses duplicate ids', () => {
    expect(selectAutoRoles({ isBot: false, config: { ...config, roleIds: ['a', 'a', 'b'] } })).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('canActorManageRole', () => {
  it('allows roles strictly below the actor', () => {
    expect(canActorManageRole({ rolePosition: 3, actorTopRolePosition: 5, actorIsOwner: false })).toBe(true);
  });
  it('refuses roles at or above the actor', () => {
    expect(canActorManageRole({ rolePosition: 5, actorTopRolePosition: 5, actorIsOwner: false })).toBe(false);
    expect(canActorManageRole({ rolePosition: 9, actorTopRolePosition: 5, actorIsOwner: false })).toBe(false);
  });
  it('fails closed when the actor position is unknown', () => {
    expect(canActorManageRole({ rolePosition: 1, actorTopRolePosition: undefined, actorIsOwner: false })).toBe(false);
  });
  it('lets the guild owner bypass hierarchy', () => {
    expect(canActorManageRole({ rolePosition: 99, actorTopRolePosition: undefined, actorIsOwner: true })).toBe(true);
  });
});
