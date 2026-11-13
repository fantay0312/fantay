import { useMemo, type ButtonHTMLAttributes } from 'react';

import { useT } from '../i18n';
import { SearchableModelSelect } from './modelOptions';

interface SettingsSelectProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  /** For a narrow trigger whose option labels need more room than it has. */
  popoverMinWidth?: number;
}

/**
 * The dropdown for Settings, instead of a native `<select>`: the same trigger and
 * list as the model picker, so a page never mixes two kinds of menu. Long lists
 * get the picker's search field by themselves.
 */
export function SettingsSelect({
  value,
  options,
  onChange,
  className,
  popoverMinWidth,
  ...buttonProps
}: SettingsSelectProps) {
  const t = useT();
  const models = useMemo(
    () => options.map((option) => ({ id: option.value, label: option.label })),
    [options],
  );
  return (
    <div className="agent-model-select-wrap">
      <SearchableModelSelect
        {...buttonProps}
        className={`inline-switcher__select settings-model-select${className ? ` ${className}` : ''}`}
        popoverClassName="settings-model-popover"
        popoverMatchTrigger
        {...(popoverMinWidth === undefined ? {} : { popoverMinWidth })}
        value={value}
        searchPlaceholder={t('designs.searchPlaceholder')}
        models={models}
        onChange={onChange}
      />
    </div>
  );
}
