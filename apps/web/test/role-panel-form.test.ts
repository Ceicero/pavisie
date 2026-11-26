import { describe, expect, it } from 'vitest';
import type { RolePanelDto } from '@pavisie/types';
import { panelToForm } from '../src/lib/dashboard/role-panel-form';

function panel(overrides: Partial<RolePanelDto> = {}): RolePanelDto {
  return {
    id: 'panel1',
    guildId: 'g1',
    channelId: 'c1',
    messageId: 'm1',
    title: 'Colours',
    description: 'Pick one',
    mode: 'select',
    groupId: 'group1',
    maxSelections: 1,
    options: [{ id: 'o1', roleId: 'r1', label: 'Red', emoji: null, description: null }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('role panel edit form', () => {
  it('keeps the linked role group, so saving an edit does not unlink it', () => {
    expect(panelToForm(panel()).groupId).toBe('group1');
  });

  it('leaves an unlinked panel unlinked', () => {
    expect(panelToForm(panel({ groupId: null })).groupId).toBeNull();
  });

  it('pre-fills every field the dialog saves back', () => {
    expect(panelToForm(panel())).toEqual({
      channelId: 'c1',
      title: 'Colours',
      description: 'Pick one',
      style: 'SELECT',
      groupId: 'group1',
      maxSelections: 1,
      options: [{ roleId: 'r1', label: 'Red', emoji: '', description: '' }],
    });
  });

  it.each([
    ['button', 'BUTTONS'],
    ['select', 'SELECT'],
    ['reaction', 'REACTIONS'],
  ] as const)('maps mode %s to style %s', (mode, style) => {
    expect(panelToForm(panel({ mode })).style).toBe(style);
  });

  it('gives a panel with no options one blank option row to fill in', () => {
    expect(panelToForm(panel({ options: [] })).options).toEqual([
      { roleId: '', label: '', emoji: '', description: '' },
    ]);
  });
});
