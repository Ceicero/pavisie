import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FormField } from '../form-field';
import { Input } from '../input';
import { Textarea } from '../textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';

afterEach(cleanup);

function labelFor(name: string): string | null {
  return screen.getByText(name).getAttribute('for');
}

function idsIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[id]')].map((el) => el.id);
}

describe('FormField auto-label', () => {
  it('auto-links a native input, textarea, and select', () => {
    const { container } = render(
      <>
        <FormField label="Name">
          <input />
        </FormField>
        <FormField label="Bio">
          <textarea />
        </FormField>
        <FormField label="Color">
          <select>
            <option value="red">Red</option>
          </select>
        </FormField>
      </>,
    );

    expect(screen.getByLabelText('Name')).toBe(container.querySelector('input'));
    expect(screen.getByLabelText('Bio')).toBe(container.querySelector('textarea'));
    expect(screen.getByLabelText('Color')).toBe(container.querySelector('select'));
    expect(new Set(idsIn(container)).size).toBe(3);
  });

  it('auto-links allow-listed UI Input and Textarea components', () => {
    const { container } = render(
      <>
        <FormField label="Title">
          <Input />
        </FormField>
        <FormField label="Notes">
          <Textarea />
        </FormField>
      </>,
    );

    expect(screen.getByLabelText('Title')).toBe(container.querySelector('input'));
    expect(screen.getByLabelText('Notes')).toBe(container.querySelector('textarea'));
  });

  it('keeps an existing htmlFor and does not inject an id on the child', () => {
    const { container } = render(
      <FormField label="Email" htmlFor="preset-email">
        <Input />
      </FormField>,
    );

    expect(labelFor('Email')).toBe('preset-email');
    expect(container.querySelector('input')?.getAttribute('id')).toBeNull();
    expect(idsIn(container)).toEqual([]);
  });

  it('keeps an existing child id and uses it for the label', () => {
    const { container } = render(
      <FormField label="Username">
        <Input id="keep-me" />
      </FormField>,
    );

    expect(labelFor('Username')).toBe('keep-me');
    expect(container.querySelector('input')?.getAttribute('id')).toBe('keep-me');
    expect(idsIn(container)).toEqual(['keep-me']);
  });

  it('does not inject an id for a fragment, multiple children, or a non-allow-listed component', () => {
    const { container } = render(
      <>
        <FormField label="Fragment">
          <>
            <input />
          </>
        </FormField>
        <FormField label="Pair">
          <input />
          <input />
        </FormField>
        <FormField label="Box">
          <div>
            <input />
          </div>
        </FormField>
      </>,
    );

    expect(labelFor('Fragment')).toBeNull();
    expect(labelFor('Pair')).toBeNull();
    expect(labelFor('Box')).toBeNull();
    expect(container.querySelectorAll('input, textarea, select, button').length).toBeGreaterThan(0);
    expect(idsIn(container)).toEqual([]);
  });

  it('auto-links a single Select to its trigger', () => {
    const { container } = render(
      <FormField label="Locale">
        <Select>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
      </FormField>,
    );

    const trigger = screen.getByRole('combobox');
    expect(labelFor('Locale')).toBe(trigger.id);
    expect(screen.getByLabelText('Locale')).toBe(trigger);
    expect(idsIn(container)).toEqual([trigger.id]);
  });

  it('keeps a caller htmlFor or an existing SelectTrigger id', () => {
    const { container } = render(
      <>
        <FormField label="Preset" htmlFor="preset-select">
          <Select>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Kept">
          <Select>
            <SelectTrigger id="keep-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </>,
    );

    const [presetTrigger, keptTrigger] = screen.getAllByRole('combobox');
    expect(labelFor('Preset')).toBe('preset-select');
    expect(presetTrigger.getAttribute('id')).toBeNull();
    expect(labelFor('Kept')).toBe('keep-trigger');
    expect(keptTrigger.getAttribute('id')).toBe('keep-trigger');
    expect(screen.getByLabelText('Kept')).toBe(keptTrigger);
    expect(idsIn(container)).toEqual(['keep-trigger']);
  });

  it('does not inject ids when a FormField has two Selects', () => {
    const { container } = render(
      <FormField label="Pair">
        <Select>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
        <Select>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fr">French</SelectItem>
          </SelectContent>
        </Select>
      </FormField>,
    );

    expect(labelFor('Pair')).toBeNull();
    const triggers = screen.getAllByRole('combobox');
    expect(triggers).toHaveLength(2);
    expect(triggers[0].getAttribute('id')).toBeNull();
    expect(triggers[1].getAttribute('id')).toBeNull();
    expect(idsIn(container)).toEqual([]);
  });

  it('resets the select control id context in a nested FormField', () => {
    const { container } = render(
      <FormField label="Outer">
        <Select>
          <FormField label="Inner">
            <div>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
            </div>
          </FormField>
          <SelectContent>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
      </FormField>,
    );

    expect(labelFor('Outer')).not.toBeNull();
    expect(labelFor('Inner')).toBeNull();
    expect(screen.getByRole('combobox').getAttribute('id')).toBeNull();
    expect(idsIn(container)).toEqual([]);
  });

  it('does not add an id to a SelectTrigger outside a FormField', () => {
    const { container } = render(
      <Select>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="en">English</SelectItem>
        </SelectContent>
      </Select>,
    );

    expect(screen.getByRole('combobox').getAttribute('id')).toBeNull();
    expect(idsIn(container)).toEqual([]);
  });

  it('gives two FormFields unique ids with no duplicates', () => {
    const { container } = render(
      <>
        <FormField label="First">
          <Input />
        </FormField>
        <FormField label="Second">
          <Input />
        </FormField>
      </>,
    );

    const ids = idsIn(container);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(labelFor('First')).toBe(ids[0]);
    expect(labelFor('Second')).toBe(ids[1]);
    expect(screen.getByLabelText('First')).not.toBe(screen.getByLabelText('Second'));
  });

  it('renders many FormFields without duplicate ids', () => {
    const { container } = render(
      <>
        {Array.from({ length: 25 }, (_, i) => (
          <FormField key={i} label={`Field ${i}`}>
            <Input />
          </FormField>
        ))}
      </>,
    );

    const ids = idsIn(container);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    for (let i = 0; i < 25; i += 1) {
      expect(labelFor(`Field ${i}`)).toBe(ids[i]);
      expect(screen.getByLabelText(`Field ${i}`).id).toBe(ids[i]);
    }
  });
});
