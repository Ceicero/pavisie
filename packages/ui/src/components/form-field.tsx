'use client';

import * as React from 'react';
import { cn } from '../lib/cn';
import { Label } from './label';
import { Input } from './input';
import { Textarea } from './textarea';
import { FormFieldControlIdContext, Select, SelectTrigger } from './select';

export interface FormFieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
}

/**
 * UI components that forward `id` to a native labelable control. `Select` is not on this list:
 * Radix `Select.Root` does not forward `id` to the focusable `SelectTrigger`. When the sole
 * child is that `Select` and neither `htmlFor` nor a child/trigger id is set, FormField instead
 * provides the generated id through `FormFieldControlIdContext` and points the label at it.
 * `SelectTrigger` reads the context and applies the id.
 */
const AUTO_LABEL_UI_COMPONENTS: ReadonlySet<unknown> = new Set([Input, Textarea]);
const AUTO_LABEL_NATIVE = new Set(['input', 'select', 'textarea']);

function isAllowListedElement(child: React.ReactElement): boolean {
  const type = child.type;
  if (typeof type === 'string') return AUTO_LABEL_NATIVE.has(type);
  return AUTO_LABEL_UI_COMPONENTS.has(type);
}

function isFragment(child: React.ReactElement): boolean {
  return child.type === React.Fragment;
}

/** Immediate children only — fragments are not flattened — ignoring blank text nodes. */
function immediateMeaningfulChildren(children: React.ReactNode): React.ReactNode[] {
  if (children == null || typeof children === 'boolean') return [];
  const list = Array.isArray(children) ? children : [children];
  return list.flatMap((child) => {
    if (child == null || typeof child === 'boolean') return [];
    if (typeof child === 'string' || typeof child === 'number') {
      return String(child).trim() === '' ? [] : [child];
    }
    return [child];
  });
}

function singleElementChild(children: React.ReactNode): React.ReactElement | null {
  const items = immediateMeaningfulChildren(children);
  if (items.length !== 1) return null;
  const only = items[0];
  if (!React.isValidElement(only) || isFragment(only)) return null;
  return only;
}

function elementId(child: React.ReactElement): string | undefined {
  const id = (child.props as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function isSelectElement(child: React.ReactElement): boolean {
  return child.type === Select;
}

/** Immediate `SelectTrigger` child of a `Select`, if it already has an id. */
function selectTriggerId(select: React.ReactElement): string | undefined {
  const items = immediateMeaningfulChildren((select.props as { children?: React.ReactNode }).children);
  for (const item of items) {
    if (React.isValidElement(item) && item.type === SelectTrigger) {
      return elementId(item);
    }
  }
  return undefined;
}

/** Label + control + hint/error slot. Pass the control as `children`. */
export const FormField = React.forwardRef<HTMLDivElement, FormFieldProps>(
  ({ className, label, htmlFor, hint, error, required, children, ...props }, ref) => {
    const generatedId = React.useId();
    const sole = singleElementChild(children);
    const childId = sole ? elementId(sole) : undefined;
    const triggerId = sole && isSelectElement(sole) ? selectTriggerId(sole) : undefined;

    let labelFor = htmlFor;
    let renderedChildren = children;
    // Only provide a Select trigger id when this field should auto-link a single Select.
    // Nested FormFields always re-provide the context so an inner field resets it.
    let selectControlId: string | undefined;
    // Never override a caller-supplied htmlFor or an existing child id. Only inject when
    // there is a single allow-listed element and neither is already set.
    if (!htmlFor && childId) {
      labelFor = childId;
    } else if (!htmlFor && triggerId) {
      labelFor = triggerId;
    } else if (!htmlFor && !childId && sole && isAllowListedElement(sole)) {
      labelFor = generatedId;
      renderedChildren = React.cloneElement(sole, { id: generatedId } as { id: string });
    } else if (!htmlFor && sole && isSelectElement(sole)) {
      labelFor = generatedId;
      selectControlId = generatedId;
    }

    return (
      <FormFieldControlIdContext.Provider value={selectControlId}>
        <div ref={ref} className={cn('space-y-1.5', className)} {...props}>
          <Label htmlFor={labelFor}>
            {label}
            {required ? <span className="ml-0.5 text-destructive">*</span> : null}
          </Label>
          {renderedChildren}
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : hint ? (
            <p className="text-xs text-muted-foreground">{hint}</p>
          ) : null}
        </div>
      </FormFieldControlIdContext.Provider>
    );
  },
);
FormField.displayName = 'FormField';
