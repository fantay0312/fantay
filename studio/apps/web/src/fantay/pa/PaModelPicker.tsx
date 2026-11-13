// SPDX-License-Identifier: AGPL-3.0-only
// Interactive model switcher for PersonalAgent surfaces (Inspector hero/profile, direct chat header, composer).
import { memo, useMemo, useState } from 'react';
import { Check, Settings2 } from 'lucide-react';

import { useT } from '../../i18n';
import { navigate } from '../../router';
import {
  Button,
  ChevronDownIcon,
  Dot,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Icon,
  SearchField,
  Spinner,
  cn,
} from '../ui';
import { usePa } from './pa-context';
import { errorToast } from './PaTurnTail';
import type { PaModelOption, PersonalAgent } from './pa-types';
import { paPendingKey } from './usePaWorkspace';
import styles from './PaModelPicker.module.css';

export type PaModelPickerVariant = 'hero' | 'profile' | 'header' | 'composer';

const RUNTIME_TITLE: Record<PersonalAgent['model']['runtime'], string> = {
  claude: 'Claude Code',
  tokentosea: 'TokenToSea',
  ollama: 'Ollama',
  managed: 'Enterprise gateway',
};

function keyOf(model: { runtime: string; modelId: string }): string {
  return `${model.runtime}/${model.modelId}`;
}

/** Strips redundant runtime prefixes ("Claude Code · sonnet" -> "sonnet") for compact surfaces and grouped rows. */
export function shortPaModelLabel(label: string, fallbackId: string): string {
  const stripped = label.replace(/^[^·]+\s*·\s*/, '').trim();
  return stripped || fallbackId;
}

function fullPaModelLabel(model: PersonalAgent['model'], option?: PaModelOption): string {
  if (option?.label) return option.label;
  return `${RUNTIME_TITLE[model.runtime] ?? model.runtime} · ${model.modelId}`;
}

interface PickerChoice {
  key: string;
  runtime: PersonalAgent['model']['runtime'];
  modelId: string;
  label: string;
  shortLabel: string;
  available: boolean;
  detail?: string;
}

function buildPickerGroups(
  models: readonly PaModelOption[],
  current: PersonalAgent['model'],
): Array<{ runtime: PersonalAgent['model']['runtime']; choices: PickerChoice[] }> {
  const byRuntime = new Map<PersonalAgent['model']['runtime'], PickerChoice[]>();
  const push = (choice: PickerChoice) => {
    const list = byRuntime.get(choice.runtime) ?? [];
    list.push(choice);
    byRuntime.set(choice.runtime, list);
  };

  const currentKey = keyOf(current);
  if (!models.some((option) => keyOf(option) === currentKey)) {
    const label = fullPaModelLabel(current);
    push({
      key: currentKey,
      runtime: current.runtime,
      modelId: current.modelId,
      label,
      shortLabel: shortPaModelLabel(label, current.modelId),
      available: true,
    });
  }

  for (const option of models) {
    push({
      key: keyOf(option),
      runtime: option.runtime,
      modelId: option.modelId,
      label: option.label,
      shortLabel: shortPaModelLabel(option.label, option.modelId),
      available: option.available,
      ...(option.detail ? { detail: option.detail } : {}),
    });
  }

  return [...byRuntime.entries()]
    .map(([runtime, choices]) => ({
      runtime,
      choices,
    }))
    .sort((a, b) => Number(b.runtime === 'tokentosea') - Number(a.runtime === 'tokentosea'));
}

function runtimeTitle(runtime: string, choices: PickerChoice[]): string {
  return RUNTIME_TITLE[runtime] ?? choices[0]?.label.split(' · ')[0] ?? runtime;
}

const TEST_ID_BY_VARIANT: Record<PaModelPickerVariant, string> = {
  hero: 'pa-inspector-model-picker',
  profile: 'pa-profile-model-picker',
  header: 'pa-header-model-picker',
  composer: 'pa-composer-model-picker',
};

export const PaModelPicker = memo(function PaModelPicker({
  agent,
  variant,
  align,
  className,
  id,
  onModelChange,
}: {
  agent: PersonalAgent;
  variant: PaModelPickerVariant;
  align?: 'start' | 'center' | 'end';
  className?: string;
  id?: string;
  onModelChange?(model: PersonalAgent['model']): void;
}) {
  const t = useT();
  const { data, index } = usePa();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [browsedRuntime, setBrowsedRuntime] = useState<string | null>(null);
  const currentKey = keyOf(agent.model);
  const currentOption = index.models.get(currentKey);
  const saving = !onModelChange && data.pending.has(paPendingKey.agent(agent.id));
  const groups = useMemo(() => buildPickerGroups(data.models, agent.model), [data.models, agent.model]);
  const activeRuntime = browsedRuntime ?? agent.model.runtime;
  const search = query.trim().toLocaleLowerCase();
  const visibleGroups = search
    ? groups.map((group) => ({
        ...group,
        choices: group.choices.filter((choice) =>
          `${runtimeTitle(group.runtime, group.choices)} ${choice.label} ${choice.modelId}`.toLocaleLowerCase().includes(search),
        ),
      })).filter((group) => group.choices.length > 0)
    : groups.filter((group) => group.runtime === activeRuntime);

  const fullLabel = fullPaModelLabel(agent.model, currentOption);
  const compactLabel = shortPaModelLabel(currentOption?.label ?? '', agent.model.modelId);
  const displayLabel = variant === 'composer' ? compactLabel : fullLabel;
  const unavailable = Boolean(currentOption && !currentOption.available);

  const menuAlign = align ?? (variant === 'hero' ? 'center' : variant === 'header' ? 'start' : 'end');

  return (
    <Popover
      open={open}
      onOpenChange={(open) => {
        setOpen(open);
        if (open) {
          setQuery('');
          setBrowsedRuntime(null);
          void data.actions.refreshModels();
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="bare"
          data-testid={TEST_ID_BY_VARIANT[variant]}
          aria-label={`${t('pa.model')}: ${fullLabel}`}
          className={cn(styles.trigger, styles[variant], className)}
        >
          {variant === 'profile' ? (
            <>
              <span className={styles.profileLead}>
                <Dot tone={unavailable ? 'failed' : 'done'} size="sm" />
                <span className={styles.label}>{displayLabel}</span>
                {unavailable ? <span className={styles.warn}>· {t('pa.status.modelUnavailable')}</span> : null}
              </span>
              {saving ? <Spinner size="sm" /> : <ChevronDownIcon size="xs" className={styles.chevron} />}
            </>
          ) : (
            <>
              {variant === 'composer' && agent.model.runtime === 'tokentosea' ? (
                <Dot tone={unavailable ? 'failed' : 'done'} size="sm" />
              ) : null}
              <span className={styles.label}>{displayLabel}</span>
              {variant === 'header' && unavailable ? (
                <span className={styles.warn}>· {t('pa.status.modelUnavailable')}</span>
              ) : null}
              {saving ? <Spinner size="sm" /> : <ChevronDownIcon size="xs" className={styles.chevron} />}
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent width={520} align={menuAlign} className={styles.menuContent}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
          const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-pa-model-choice]:not(:disabled)'));
          const current = options.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'Enter' && document.activeElement?.tagName === 'INPUT') options[0]?.click();
          else if (event.key !== 'Enter') {
            const next = event.key === 'ArrowDown' ? current + 1 : current < 0 ? options.length - 1 : current - 1;
            options[Math.max(0, Math.min(next, options.length - 1))]?.focus();
          } else return;
          event.preventDefault();
        }}
      >
        <SearchField
          variant="bar"
          value={query}
          placeholder={t('newproj.modelSearch')}
          aria-label={t('newproj.modelSearch')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className={styles.browser}>
        {!search ? (
          <div className={styles.channels}>
            {groups.map((group) => (
              <Button
                variant="bare"
                key={group.runtime}
                aria-pressed={activeRuntime === group.runtime}
                className={cn(styles.channel, activeRuntime === group.runtime && styles.activeChannel)}
                onClick={() => setBrowsedRuntime(group.runtime)}
              >
                {runtimeTitle(group.runtime, group.choices)}
              </Button>
            ))}
          </div>
        ) : null}
        <div className={styles.models}>
        <div role="listbox" aria-label={t('pa.model')}>
          {visibleGroups.map((group) => (
            <div key={group.runtime} role="group" aria-label={runtimeTitle(group.runtime, group.choices)}>
              <div className={styles.caption}>{runtimeTitle(group.runtime, group.choices)}</div>
              {group.choices.map((choice) => {
                const disabled = !choice.available && choice.key !== currentKey;
                const description = !choice.available
                  ? [t('pa.agentForm.unavailable'), choice.detail].filter(Boolean).join(' · ')
                  : undefined;
                return (
                  <Button
                    variant="bare"
                    role="option"
                    aria-selected={choice.key === currentKey}
                    data-pa-model-choice
                    className={styles.option}
                    key={choice.key}
                    disabled={disabled}
                    title={description ?? choice.label}
                    onClick={() => {
                      setOpen(false);
                      if (choice.key === currentKey) return;
                      const model = { runtime: choice.runtime, modelId: choice.modelId };
                      if (onModelChange) onModelChange(model);
                      else void data.actions.setAgentModel(agent, model).catch(errorToast);
                    }}
                  >
                    <span className={styles.itemRow}>
                      <Dot tone={choice.available ? 'done' : 'muted'} size="sm" />
                      <span className={styles.itemTitle}>{choice.shortLabel}</span>
                      {choice.key === currentKey ? <Icon icon={Check} size="sm" /> : null}
                    </span>
                  </Button>
                );
              })}
            </div>
          ))}
        </div>
        {search && visibleGroups.length === 0 ? <div className={styles.emptyHint}>{t('pa.noModels')}</div> : null}
        </div>
        </div>
        {data.models.length === 0 ? <div className={styles.emptyHint}>{t('pa.noModels')}</div> : null}
        <Button
          variant="bare"
          className={styles.settings}
          onClick={() => { setOpen(false); navigate({ kind: 'home', view: 'settings' }); }}
        >
          <Icon icon={Settings2} size="sm" />
          {t('pa.conn.openModelSettings')}
        </Button>
      </PopoverContent>
    </Popover>
  );
});
