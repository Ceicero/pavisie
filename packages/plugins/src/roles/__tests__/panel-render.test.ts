import { describe, expect, it } from 'vitest';
import { CUSTOM_ID_MAX } from '@pavisie/core';
import {
  buildPanelButtonRows,
  buildPanelEmbed,
  buildPanelMessagePayload,
  buildPanelSelectRow,
  reactionRoleMap,
  type PanelWithOptions,
} from '../panel-render';

function makeOption(
  overrides: Partial<PanelWithOptions['options'][number]> = {},
): PanelWithOptions['options'][number] {
  return {
    id: overrides.id ?? 'opt1',
    panelId: 'panel1',
    roleId: overrides.roleId ?? '111111111111111111',
    label: overrides.label ?? 'Gamer',
    emoji: overrides.emoji ?? null,
    description: overrides.description ?? null,
    position: overrides.position ?? 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as PanelWithOptions['options'][number];
}

function makePanel(overrides: Partial<PanelWithOptions> = {}): PanelWithOptions {
  return {
    id: overrides.id ?? 'panel1',
    guildId: '000000000000000000',
    channelId: '222222222222222222',
    messageId: null,
    title: overrides.title ?? 'Pick your roles',
    description: overrides.description ?? null,
    style: overrides.style ?? 'BUTTONS',
    groupId: overrides.groupId ?? null,
    maxSelections: overrides.maxSelections ?? null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    options: overrides.options ?? [makeOption()],
  } as PanelWithOptions;
}

describe('buildPanelEmbed', () => {
  it('lists each option with its role mention and description', () => {
    const panel = makePanel({
      options: [
        makeOption({ label: 'PC', description: 'PC players', roleId: '1' }),
        makeOption({ id: 'opt2', label: 'Console', roleId: '2' }),
      ],
    });
    const embed = buildPanelEmbed(panel).toJSON();
    expect(embed.title).toBe('Pick your roles');
    expect(embed.description).toContain('**PC** → <@&1> — PC players');
    expect(embed.description).toContain('**Console** → <@&2>');
  });
});

describe('buildPanelButtonRows', () => {
  it('produces one customId per option, matching roles:toggle:<panelId>:<optionId>', () => {
    const panel = makePanel({
      options: [makeOption({ id: 'a', roleId: '1' }), makeOption({ id: 'b', roleId: '2' })],
    });
    const rows = buildPanelButtonRows(panel);
    const customIds = rows.flatMap((row) =>
      row.components.map((c) => (c.toJSON() as { custom_id: string }).custom_id),
    );
    expect(customIds).toEqual(['roles:toggle:panel1:a', 'roles:toggle:panel1:b']);
  });

  it('chunks into rows of at most 5 buttons, capped at 5 rows (25 options max)', () => {
    const options = Array.from({ length: 27 }, (_, i) => makeOption({ id: `opt${i}`, roleId: String(i) }));
    const panel = makePanel({ options });
    const rows = buildPanelButtonRows(panel);
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const row of rows) {
      expect(row.components.length).toBeLessThanOrEqual(5);
    }
  });

  it("every generated customId stays within Discord's 100-char limit", () => {
    const longId = 'a'.repeat(24); // cuid()-length ids
    const panel = makePanel({ id: longId, options: [makeOption({ id: longId, roleId: '1' })] });
    const rows = buildPanelButtonRows(panel);
    const customId = (rows[0].components[0].toJSON() as { custom_id: string }).custom_id;
    expect(customId.length).toBeLessThanOrEqual(CUSTOM_ID_MAX);
  });
});

describe('buildPanelSelectRow', () => {
  it('customId matches roles:select:<panelId>, one option per role, maxValues defaults to option count', () => {
    const panel = makePanel({
      style: 'SELECT',
      options: [makeOption({ id: 'a', roleId: '1' }), makeOption({ id: 'b', roleId: '2' })],
    });
    const row = buildPanelSelectRow(panel).toJSON();
    const select = row.components[0] as {
      custom_id: string;
      options: { value: string }[];
      min_values: number;
      max_values: number;
    };
    expect(select.custom_id).toBe('roles:select:panel1');
    expect(select.options.map((o) => o.value)).toEqual(['1', '2']);
    expect(select.min_values).toBe(0);
    expect(select.max_values).toBe(2);
  });

  it('respects maxSelections when set', () => {
    const panel = makePanel({
      style: 'SELECT',
      maxSelections: 1,
      options: [makeOption({ id: 'a', roleId: '1' }), makeOption({ id: 'b', roleId: '2' })],
    });
    const row = buildPanelSelectRow(panel).toJSON();
    const select = row.components[0] as { max_values: number };
    expect(select.max_values).toBe(1);
  });
});

describe('buildPanelMessagePayload', () => {
  it('BUTTONS style returns button rows', () => {
    const payload = buildPanelMessagePayload(makePanel({ style: 'BUTTONS' }));
    expect(payload.components.length).toBeGreaterThan(0);
  });

  it('SELECT style returns exactly one select row', () => {
    const payload = buildPanelMessagePayload(makePanel({ style: 'SELECT' }));
    expect(payload.components.length).toBe(1);
  });

  it('REACTIONS style returns no components', () => {
    const payload = buildPanelMessagePayload(makePanel({ style: 'REACTIONS' }));
    expect(payload.components).toEqual([]);
  });
});

describe('reactionRoleMap', () => {
  it('only includes options that have an emoji set', () => {
    const panel = makePanel({
      style: 'REACTIONS',
      options: [
        makeOption({ id: 'a', roleId: '1', emoji: '🎮' }),
        makeOption({ id: 'b', roleId: '2', emoji: null }),
      ],
    });
    expect(reactionRoleMap(panel)).toEqual([{ emoji: '🎮', roleId: '1' }]);
  });
});
