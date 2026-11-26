import type { RolePanelDto } from '@pavisie/types';
import type { RolePanelInput, RolePanelOptionInput } from './roles-queries';

const MODE_TO_STYLE: Record<RolePanelDto['mode'], RolePanelInput['style']> = {
  button: 'BUTTONS',
  select: 'SELECT',
  reaction: 'REACTIONS',
};

export function emptyPanelOption(): RolePanelOptionInput {
  return { roleId: '', label: '', emoji: '', description: '' };
}

/**
 * Builds the edit-dialog form from a saved panel. The dialog PUTs the whole form back, so every field the
 * dialog shows must come from the panel; a field defaulted here (as `groupId: null` once was) is silently
 * overwritten on save.
 */
export function panelToForm(panel: RolePanelDto): RolePanelInput {
  return {
    channelId: panel.channelId ?? '',
    title: panel.title,
    description: panel.description ?? '',
    style: MODE_TO_STYLE[panel.mode],
    groupId: panel.groupId ?? null,
    maxSelections: panel.maxSelections,
    options:
      panel.options.length > 0
        ? panel.options.map((o) => ({
            roleId: o.roleId,
            label: o.label,
            emoji: o.emoji ?? '',
            description: o.description ?? '',
          }))
        : [emptyPanelOption()],
  };
}
