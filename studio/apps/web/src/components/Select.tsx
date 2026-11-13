import { Children, Fragment, forwardRef, isValidElement, useState } from 'react';
import type { ChangeEvent, ReactElement, ReactNode, SelectHTMLAttributes } from 'react';

import { CustomSelect, type CustomSelectItem, type CustomSelectOption } from './CustomSelect';

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'>;

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return '';
}

function readOption(props: {
  value?: unknown;
  label?: string;
  disabled?: boolean;
  children?: ReactNode;
}): CustomSelectOption {
  const label = props.label ?? textOf(props.children);
  return {
    value: props.value === undefined || props.value === null ? label : String(props.value),
    label,
    disabled: Boolean(props.disabled),
  };
}

function readOptions(children: ReactNode): CustomSelectItem[] {
  const items: CustomSelectItem[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const element = child as ReactElement<{
      children?: ReactNode;
      disabled?: boolean;
      hidden?: boolean;
      label?: string;
      value?: unknown;
    }>;
    if (element.type === Fragment) {
      items.push(...readOptions(element.props.children));
    } else if (element.type === 'optgroup') {
      items.push({
        label: element.props.label ?? '',
        options: readOptions(element.props.children) as CustomSelectOption[],
      });
    } else if (element.type === 'option' && !element.props.hidden) {
      items.push(readOption(element.props));
    }
  });
  return items;
}

/**
 * Drop-in for a native <select>: same props, same <option>/<optgroup> children, and an onChange
 * whose event exposes target.value. The popup is always the app's own list, never the OS menu.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    children,
    className,
    value,
    defaultValue,
    onChange,
    name,
    disabled,
    title,
    required: _required,
    autoComplete: _autoComplete,
    form: _form,
    onBlur,
    onFocus,
    'aria-label': ariaLabel,
    ...triggerProps
  },
  ref,
) {
  const [internal, setInternal] = useState(() => String(defaultValue ?? ''));
  const controlled = value !== undefined;
  const current = String(controlled ? value : internal);
  const options = readOptions(children);
  return (
    <>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      <CustomSelect
        value={current}
        options={options}
        ariaLabel={ariaLabel}
        disabled={disabled}
        title={title}
        triggerRef={ref}
        triggerClassName={className}
        triggerProps={{
          ...(triggerProps as Record<string, unknown>),
          onFocus: onFocus as never,
          onBlur: onBlur as never,
        }}
        onChange={(next) => {
          if (!controlled) setInternal(next);
          const target = { value: next, name: name ?? '' };
          onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>);
        }}
      />
    </>
  );
});
