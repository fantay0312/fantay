import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, FocusEvent, KeyboardEvent, Ref } from 'react';
import { Icon } from './Icon';

export interface CustomSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface CustomSelectGroup {
  label: string;
  options: CustomSelectOption[];
}

export type CustomSelectItem = CustomSelectOption | CustomSelectGroup;

type TriggerProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className' | 'disabled' | 'onChange' | 'onClick' | 'onKeyDown' | 'title' | 'type' | 'value'
>;

interface Props {
  value: string;
  options: CustomSelectItem[];
  onChange: (value: string) => void;
  /** Omit when a wrapping <label> or aria-labelledby already names the trigger. */
  ariaLabel?: string;
  labelledBy?: string;
  triggerClassName?: string;
  menuClassName?: string;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  triggerRef?: Ref<HTMLButtonElement>;
  /** Forwarded to the trigger button: id, style, data-*, aria-*, onFocus, onBlur. */
  triggerProps?: TriggerProps;
}

interface FlatOption extends CustomSelectOption {
  group?: string;
}

interface MenuPosition {
  top?: number;
  bottom?: number;
  left: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
}

const TYPEAHEAD_RESET_MS = 500;

function setForwardedRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') ref(node);
  else if (ref) (ref as { current: T | null }).current = node;
}

function isGroup(item: CustomSelectItem): item is CustomSelectGroup {
  return 'options' in item;
}

function flattenOptions(items: CustomSelectItem[]): FlatOption[] {
  return items.flatMap((item) =>
    isGroup(item)
      ? item.options.map((option) => ({ ...option, group: item.label }))
      : [item],
  );
}

/**
 * The app's single-value dropdown. The trigger renders in place of a native <select>, with no
 * wrapper, so it stays a direct child of whatever flex or grid held the control. The list lives
 * in the browser top layer: nothing can clip it, and because it stays inside the DOM subtree of
 * its trigger, a modal dialog's focus trap and outside-click handling keep treating it as inside.
 */
export function CustomSelect({
  value,
  options,
  onChange,
  ariaLabel,
  labelledBy,
  triggerClassName,
  menuClassName,
  disabled = false,
  placeholder,
  title,
  triggerRef,
  triggerProps,
}: Props) {
  const reactId = useId();
  const idBase = reactId.replace(/:/g, '');
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);
  const activeSourceValueRef = useRef(value);
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState(value);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const typeaheadRef = useRef({ buffer: '', at: 0 });

  const flatOptions = useMemo(() => flattenOptions(options), [options]);
  const selected = flatOptions.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? placeholder ?? flatOptions.find((option) => !option.disabled)?.label ?? value;
  const enabledOptions = useMemo(
    () => flatOptions.filter((option) => !option.disabled),
    [flatOptions],
  );
  const flatOptionsRef = useRef(flatOptions);
  const enabledOptionsRef = useRef(enabledOptions);
  flatOptionsRef.current = flatOptions;
  enabledOptionsRef.current = enabledOptions;
  const optionIdByValue = useMemo(
    () => new Map(flatOptions.map((option, index) => [option.value, `${idBase}-option-${index}`])),
    [flatOptions, idBase],
  );
  const activeOptionId = open && activeValue ? optionIdByValue.get(activeValue) : undefined;

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const gap = 4;
    const viewportPad = 12;
    const below = window.innerHeight - rect.bottom - viewportPad;
    const above = rect.top - viewportPad;
    const openAbove = below < 180 && above > below;
    const maxHeight = Math.max(0, Math.min(320, (openAbove ? above : below) - gap));
    const maxWidth = Math.max(0, window.innerWidth - viewportPad * 2);
    const minWidth = Math.min(rect.width, maxWidth);
    const width = Math.min(Math.max(minWidth, menuRef.current?.offsetWidth ?? 0), maxWidth);
    setPosition({
      ...(openAbove ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
      left: Math.min(
        Math.max(viewportPad, rect.left),
        Math.max(viewportPad, window.innerWidth - width - viewportPad),
      ),
      minWidth,
      maxWidth,
      maxHeight,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) updatePosition();
    else setPosition(null);
  }, [open, updatePosition]);

  const menuMounted = open && position !== null;
  useLayoutEffect(() => {
    if (!menuMounted) return;
    const menu = menuRef.current;
    if (menu && typeof menu.showPopover === 'function') {
      menu.setAttribute('popover', 'manual');
      menu.showPopover();
    }
    // The first pass could not know the list's own width; re-clamp it against the viewport.
    updatePosition();
  }, [menuMounted, updatePosition]);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      activeSourceValueRef.current = value;
      return;
    }
    if (wasOpenRef.current && activeSourceValueRef.current === value) return;
    const selectedOption = flatOptionsRef.current.find((option) => option.value === value && !option.disabled);
    setActiveValue(selectedOption?.value ?? enabledOptionsRef.current[0]?.value ?? '');
    wasOpenRef.current = true;
    activeSourceValueRef.current = value;
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScrollOrResize = () => updatePosition();
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    if (disabled) {
      setOpen(false);
      return;
    }
    if (!enabledOptions.some(option => option.value === activeValue)) {
      setActiveValue(enabledOptions[0]?.value ?? '');
    }
  }, [activeValue, disabled, enabledOptions, open]);

  useEffect(() => {
    if (menuMounted && activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionId, menuMounted]);

  const choose = (nextValue: string) => {
    const next = flatOptions.find((option) => option.value === nextValue);
    if (!next || next.disabled) return;
    onChange(next.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const moveActive = (direction: 1 | -1) => {
    if (!enabledOptions.length) return;
    const currentIndex = enabledOptions.findIndex((option) => option.value === activeValue);
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + direction + enabledOptions.length) % enabledOptions.length;
    setActiveValue(enabledOptions[nextIndex]!.value);
  };

  /** Letters jump to the matching option, as a native select does. Returns whether it consumed the key. */
  const typeahead = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return false;
    const state = typeaheadRef.current;
    const expired = event.timeStamp - state.at > TYPEAHEAD_RESET_MS;
    if (event.key === ' ' && (expired || !state.buffer)) return false;
    state.buffer = (expired ? '' : state.buffer) + event.key.toLowerCase();
    state.at = event.timeStamp;
    const hit = enabledOptions.find((option) => option.label.toLowerCase().startsWith(state.buffer));
    if (hit) {
      setActiveValue(hit.value);
      setOpen(true);
    }
    return true;
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (open && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      setActiveValue((event.key === 'Home' ? enabledOptions[0] : enabledOptions.at(-1))?.value ?? '');
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) {
        choose(activeValue || value);
      } else {
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (typeahead(event)) event.preventDefault();
  };

  const menu = (
    <div
      ref={menuRef}
      id={`${idBase}-menu`}
      className={['od-select-menu', menuClassName].filter(Boolean).join(' ')}
      role="listbox"
      aria-label={ariaLabel}
      style={position ?? undefined}
      // Focus stays on the trigger, including when the scrollbar is dragged.
      onMouseDown={(event) => event.preventDefault()}
      // Inside a <label>, a click on the list must not re-activate the trigger.
      onClick={(event) => event.preventDefault()}
    >
      {options.map((item) => {
        if (isGroup(item)) {
          return (
            <div className="od-select-group" key={`group:${item.label}`}>
              <div className="od-select-group-label">{item.label}</div>
              {item.options.map((option) => (
                <SelectOptionButton
                  key={option.value}
                  option={option}
                  selected={option.value === value}
                  active={option.value === activeValue}
                  id={optionIdByValue.get(option.value)}
                  onChoose={choose}
                  onActive={setActiveValue}
                />
              ))}
            </div>
          );
        }
        return (
          <SelectOptionButton
            key={item.value}
            option={item}
            selected={item.value === value}
            active={item.value === activeValue}
            id={optionIdByValue.get(item.value)}
            onChoose={choose}
            onActive={setActiveValue}
          />
        );
      })}
    </div>
  );

  return (
    <>
      <button
        {...triggerProps}
        ref={(node) => {
          buttonRef.current = node;
          setForwardedRef(triggerRef, node);
        }}
        type="button"
        className={['od-select-trigger', triggerClassName].filter(Boolean).join(' ')}
        role="combobox"
        value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${idBase}-menu`}
        aria-activedescendant={activeOptionId}
        aria-describedby={labelledBy}
        aria-label={ariaLabel ? `${ariaLabel}: ${selectedLabel}` : undefined}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onButtonKeyDown}
        onBlur={(event: FocusEvent<HTMLButtonElement>) => {
          if (!menuRef.current?.contains(event.relatedTarget)) setOpen(false);
          triggerProps?.onBlur?.(event);
        }}
      >
        <span id={`${idBase}-value`} className="od-select-value">
          {selectedLabel}
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? menu : null}
    </>
  );
}

function SelectOptionButton({
  option,
  selected,
  active,
  id,
  onChoose,
  onActive,
}: {
  option: CustomSelectOption;
  selected: boolean;
  active: boolean;
  id?: string;
  onChoose: (value: string) => void;
  onActive: (value: string) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      className={[
        'od-select-option',
        selected ? 'selected' : '',
        active ? 'active' : '',
      ].filter(Boolean).join(' ')}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      disabled={option.disabled}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => { if (!option.disabled) onActive(option.value); }}
      onClick={() => onChoose(option.value)}
    >
      <span className="od-select-option-label">{option.label}</span>
      <span className="od-select-option-check" aria-hidden>
        <Icon name="check" size={14} />
      </span>
    </button>
  );
}
