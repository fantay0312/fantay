import { useMemo } from 'react';

import { useT } from '../i18n';
import type { AgentModelOption } from '../types';
import { SearchableModelSelect } from './modelOptions';

/**
 * Which of an agent's models the pickers offer. All of them unless unchecked here:
 * the setting stores what is left out, so a model the CLI adds later shows by
 * itself. The CLI default is not listed because it cannot be turned off.
 */
export function ModelVisibilitySelect({ agentId, models, hiddenIds, onChange }: {
  agentId: string;
  models: readonly AgentModelOption[];
  hiddenIds: readonly string[] | undefined;
  onChange: (hiddenIds: string[]) => void;
}) {
  const t = useT();
  const choices = useMemo(
    () => models.filter((model) => model.id !== 'default' && model.enabled !== false),
    [models],
  );
  const hidden = useMemo(() => new Set(hiddenIds ?? []), [hiddenIds]);
  const checked = useMemo(
    () => new Set(choices.filter((model) => !hidden.has(model.id)).map((model) => model.id)),
    [choices, hidden],
  );
  if (choices.length === 0) return null;
  const total = choices.length;
  const triggerLabel = checked.size === total
    ? t('settings.modelVisibilityAll', { count: total })
    : t('settings.modelVisibilitySome', { selected: checked.size, total });
  return <label className="field">
    <span className="field-label">{t('settings.modelVisibility')}</span>
    <div className="agent-model-select-wrap">
      <SearchableModelSelect
        className="inline-switcher__select settings-model-select"
        popoverClassName="settings-model-popover"
        value=""
        aria-label={t('settings.modelVisibility')}
        data-testid={`settings-agent-model-visibility-${agentId}`}
        popoverTestId={`settings-agent-model-visibility-popover-${agentId}`}
        searchPlaceholder={t('designs.searchPlaceholder')}
        minSearchableOptions={8}
        models={choices as AgentModelOption[]}
        onChange={() => {}}
        multi={{
          checked,
          triggerLabel,
          selectAllLabel: t('settings.modelVisibilitySelectAll'),
          clearLabel: t('settings.modelVisibilityClear'),
          onToggle: (id) => {
            const next = new Set(hidden);
            if (!next.delete(id)) next.add(id);
            onChange([...next]);
          },
          onSetAll: (show) => onChange(show ? [] : choices.map((model) => model.id)),
        }}
      />
    </div>
  </label>;
}
