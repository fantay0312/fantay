import { useI18n, useT } from '../i18n';
import type { AgentModelOption } from '@open-design/contracts';
import type { Dict } from '../i18n/types';
import { SearchableModelSelect } from './modelOptions';

const LABELS: Record<string, keyof Dict> = {
  default: 'settings.reasoning.default',
  none: 'settings.reasoning.none', off: 'settings.reasoning.none', minimal: 'settings.reasoning.minimal',
  low: 'settings.reasoning.low', medium: 'settings.reasoning.medium',
  high: 'settings.reasoning.high', xhigh: 'settings.reasoning.xhigh',
  max: 'settings.reasoning.max',
};
/** The localized name of each effort id, for copy that names efforts outside this select. */
export const REASONING_LABEL_KEYS: Readonly<Record<string, keyof Dict>> = LABELS;

/** The agent card's second dropdown: the same control as the model picker beside it. */
export function ReasoningSelect({ value, options, onChange }: {
  value: string;
  options: readonly AgentModelOption[];
  onChange: (value: string) => void;
}) {
  const t = useT();
  const {locale}=useI18n(),zh=locale.startsWith('zh');
  const label=(option:AgentModelOption)=>{
    if(option.reasoningControlKind==='budget')return zh?option.label:`Budget ${option.reasoningBudgetTokens?.toLocaleString('en-US')??''} tokens`;
    if(option.reasoningControlKind==='fixed')return zh?option.label:'Fixed thinking';
    if(option.reasoningControlKind==='mode')return zh?option.label:`Between tools · ${option.id.replace('between_tools_','')}`;
    if(option.id==='on')return zh?'开启思考':'Thinking on';
    return LABELS[option.id]?t(LABELS[option.id]!):option.label;
  };
  return <label className="field">
    <span className="field-label">{t('settings.reasoningPicker')}</span>
    <div className="agent-model-select-wrap">
      <SearchableModelSelect
        className="inline-switcher__select settings-model-select"
        popoverClassName="settings-model-popover"
        value={value}
        aria-label={t('settings.reasoningPicker')}
        data-testid="reasoning-select"
        searchPlaceholder={t('designs.searchPlaceholder')}
        minSearchableOptions={Number.POSITIVE_INFINITY}
        models={options.map((option) => ({
          id: option.id,
          label: label(option),
        }))}
        onChange={onChange}
      />
    </div>
  </label>;
}
