// SPDX-License-Identifier: AGPL-3.0-only
// Model picker of the generator panel (spec 05 §5.5; infinite-canvas `model-picker.tsx` was a UX
// reference only, no code copied). A pill trigger, then a popover with search, a capability filter
// and the catalog groups: ready providers, the cloud group, and the providers that still need setup
// (collapsed, with a "set up media providers" deep link). Brand logos are not used.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { ChevronDown } from 'lucide-react';
import type { GenerationSurface } from '@open-design/contracts';

import { useT } from '../../../i18n';
import type { Dict } from '../../../i18n/types';
import { Button, Disclosure, Popover, PopoverContent, PopoverTrigger, SearchField, Segmented, SegmentedItem, Spinner, Tooltip } from '../../ui';
import { modelAvailability, type GenerationModelGroup, type GenerationModelOption } from '../model-catalog';
import { BOARD_CONTROL_PROPS, BOARD_INTERACTIVE_PROPS } from './board-interactive';
import styles from './ModelPicker.module.css';

type DictKey = keyof Dict;
type CapabilityFilter = 'all' | 't2' | 'i2';

export interface ModelPickerProps {
  surface: GenerationSurface;
  /** Stored id (null = auto). */
  value: string | null;
  /** What will run. */
  resolved: GenerationModelOption | null;
  groups: GenerationModelGroup[];
  loading: boolean;
  referenceCount: number;
  onChange(id: string): void;
  /** Settings ▸ media providers. */
  onOpenSettings(): void;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}

const CAP_KEYS: Record<GenerationSurface, { t2: DictKey; i2: DictKey; t2Cap: string; i2Cap: string }> = {
  image: { t2: 'fantay.gen.model.capT2i', i2: 'fantay.gen.model.capI2i', t2Cap: 't2i', i2Cap: 'i2i' },
  video: { t2: 'fantay.gen.model.capT2v', i2: 'fantay.gen.model.capI2v', t2Cap: 't2v', i2Cap: 'i2v' },
};

const REASON_KEYS: Record<'no-references' | 'needs-reference' | 'needs-setup', DictKey> = {
  'no-references': 'fantay.gen.model.noRefs',
  'needs-reference': 'fantay.gen.model.needsRef',
  'needs-setup': 'fantay.gen.model.needsSetup',
};

/**
 * Capability filter: "image to X" lists only models whose renderer really reads references
 * (`support.maxReferences > 0`, spec 05 F10), so the filter never offers a model that ignores them.
 */
function matchesCapability(option: GenerationModelOption, filter: CapabilityFilter, caps: { t2Cap: string; i2Cap: string }): boolean {
  if (filter === 't2') return option.caps.includes(caps.t2Cap);
  if (filter === 'i2') return option.caps.includes(caps.i2Cap) && option.support.maxReferences > 0;
  return true;
}

/** `provider · hint`, without repeating the provider when the hint already starts with it. */
function optionMeta(option: GenerationModelOption): string {
  const hint = option.hint.trim();
  if (!hint) return option.providerLabel;
  if (hint.toLowerCase().startsWith(option.providerLabel.toLowerCase())) return hint;
  return `${option.providerLabel} · ${hint}`;
}

function matchesSearch(option: GenerationModelOption, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${option.label} ${option.providerLabel} ${option.hint} ${option.id}`.toLowerCase().includes(normalized);
}

interface VisibleGroup {
  key: string;
  label: string;
  options: GenerationModelOption[];
}

export function ModelPicker({
  surface,
  value,
  resolved,
  groups,
  loading,
  referenceCount,
  onChange,
  onOpenSettings,
  open: openProp,
  onOpenChange,
}: ModelPickerProps) {
  const t = useT();
  const listId = useId();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };
  const caps = CAP_KEYS[surface];
  const defaultFilter: CapabilityFilter = referenceCount > 0 ? 'i2' : 't2';
  const [filter, setFilter] = useState<CapabilityFilter>(defaultFilter);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setFilter(defaultFilter);
    setQuery('');
    setActiveIndex(0);
    // Reset when the picker opens; the default follows the references at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const readyGroups = groups.filter((group) => group.readiness !== 'needs-setup');
  const setupGroups = groups.filter((group) => group.readiness === 'needs-setup');
  const hasAnyReady = readyGroups.some((group) => group.options.length > 0);

  const selectedId = resolved?.id ?? value;
  const visibleGroups = useMemo<VisibleGroup[]>(() => {
    return readyGroups
      .map((group) => ({
        key: group.providerId,
        label: group.readiness === 'cloud' ? t('fantay.gen.model.cloudGroup') : group.label,
        options: group.options.filter(
          (option) => (option.id === selectedId || matchesCapability(option, filter, caps)) && matchesSearch(option, query),
        ),
      }))
      .filter((group) => group.options.length > 0);
  }, [caps.i2Cap, caps.t2Cap, filter, query, readyGroups, selectedId, t]);
  const flat = useMemo(() => visibleGroups.flatMap((group) => group.options), [visibleGroups]);
  const active = flat[Math.min(activeIndex, Math.max(0, flat.length - 1))];
  const optionDomId = (option: GenerationModelOption) => `${listId}-${option.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  useEffect(() => {
    if (!active || !listRef.current) return;
    const element = listRef.current.querySelector<HTMLElement>(`[data-option-index="${flat.indexOf(active)}"]`);
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [active, flat]);

  const choose = (option: GenerationModelOption) => {
    if (!modelAvailability(option, referenceCount).selectable) return;
    onChange(option.id);
    setOpen(false);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && flat.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % flat.length);
    } else if (event.key === 'ArrowUp' && flat.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + flat.length) % flat.length);
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      choose(active);
    }
  };

  const triggerLabel = resolved?.label ?? t('fantay.gen.model.select');
  const triggerTooltip = resolved ? optionMeta(resolved) : t('fantay.gen.model.label');

  let body: React.ReactNode;
  if (loading && groups.length === 0) {
    body = (
      <div className={styles.state}>
        <Spinner size="sm" label={t('fantay.gen.model.loading')} />
        <span aria-hidden>{t('fantay.gen.model.loading')}</span>
      </div>
    );
  } else if (!hasAnyReady) {
    body = (
      <div className={styles.state}>
        <span>{t('fantay.gen.model.noneReady')}</span>
        <Button size="sm" variant="default" onClick={() => onOpenSettings()}>
          {t('fantay.gen.model.configure')}
        </Button>
      </div>
    );
  } else if (flat.length === 0) {
    body = <div className={styles.state}>{t('fantay.gen.model.noMatch')}</div>;
  } else {
    body = visibleGroups.map((group) => (
      <div key={group.key} role="group" aria-label={group.label}>
        <div className={styles.groupLabel} aria-hidden>
          {group.label}
        </div>
        {group.options.map((option) => {
          const availability = modelAvailability(option, referenceCount);
          const capabilityLabels = [
            option.caps.includes(caps.t2Cap) ? t(caps.t2) : null,
            option.caps.includes(caps.i2Cap) && option.support.maxReferences > 0 ? t(caps.i2) : null,
          ].filter((label): label is string => Boolean(label));
          const isActive = active?.id === option.id;
          return (
            <div
              key={option.id}
              id={optionDomId(option)}
              data-option-index={flat.indexOf(option)}
              role="option"
              aria-selected={resolved?.id === option.id}
              aria-disabled={availability.selectable ? undefined : true}
              data-active={isActive ? '' : undefined}
              data-testid={`fx-gen-model-option-${option.id}`}
              className={styles.option}
              onPointerEnter={() => setActiveIndex(flat.indexOf(option))}
              onClick={() => choose(option)}
            >
              <span className={styles.optionLabel}>{option.label}</span>
              <span className={styles.optionMeta}>{optionMeta(option)}</span>
              <span className={styles.caps}>
                {capabilityLabels.map((label) => (
                  <span key={label} className={styles.cap}>
                    {label}
                  </span>
                ))}
                {option.support.maxReferences > 0 ? (
                  <span className={styles.cap}>{t('fantay.gen.model.refLimit', { n: option.support.maxReferences })}</span>
                ) : null}
              </span>
              {!availability.selectable ? <span className={styles.reason}>{t(REASON_KEYS[availability.reason], { count: setupGroups.length })}</span> : null}
            </div>
          );
        })}
      </div>
    ));
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* The tooltip wraps a span, not the Radix trigger (their data-state would collide). */}
      <Tooltip label={triggerTooltip}>
        <span className={styles.triggerWrap}>
          <PopoverTrigger asChild>
            <Button
              variant="bare"
              size="md"
              className={styles.trigger}
              data-testid="fx-gen-model-trigger"
              data-model={resolved?.id ?? ''}
              aria-label={`${t('fantay.gen.model.label')}: ${triggerLabel}`}
              {...BOARD_CONTROL_PROPS}
            >
              <span className={styles.triggerLabel}>{triggerLabel}</span>
              <ChevronDown strokeWidth={1.5} aria-hidden />
            </Button>
          </PopoverTrigger>
        </span>
      </Tooltip>
      <PopoverContent
        width={340}
        align="end"
        side="top"
        className="p-0"
        aria-label={t('fantay.gen.model.select')}
        data-testid="fx-gen-model-popover"
        {...BOARD_INTERACTIVE_PROPS}
      >
        <div className={styles.content}>
          <div className={styles.head}>
            <SearchField
              autoFocus
              value={query}
              placeholder={t('fantay.gen.model.search')}
              aria-label={t('fantay.gen.model.search')}
              aria-controls={listId}
              aria-activedescendant={active ? optionDomId(active) : undefined}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
            />
            <Segmented
              size="sm"
              aria-label={t('fantay.gen.model.label')}
              value={filter}
              onValueChange={(next) => {
                setFilter(next as CapabilityFilter);
                setActiveIndex(0);
              }}
            >
              <SegmentedItem value="all">{t('fantay.gen.model.filterAll')}</SegmentedItem>
              <SegmentedItem value="t2">{t(caps.t2)}</SegmentedItem>
              <SegmentedItem value="i2">{t(caps.i2)}</SegmentedItem>
            </Segmented>
          </div>
          <div id={listId} ref={listRef} role="listbox" aria-label={t('fantay.gen.model.label')} className={styles.list} tabIndex={-1}>
            {body}
          </div>
          {setupGroups.length > 0 ? (
            <div className={styles.setup}>
              <Disclosure label={t('fantay.gen.model.needsSetup', { count: setupGroups.length })}>
                <ul className={styles.setupList}>
                  {setupGroups.map((group) => (
                    <li key={group.providerId}>{group.label}</li>
                  ))}
                </ul>
                <Button size="sm" variant="default" onClick={() => onOpenSettings()}>
                  {t('fantay.gen.model.configure')}
                </Button>
              </Disclosure>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
