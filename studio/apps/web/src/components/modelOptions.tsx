import { createPortal } from 'react-dom';
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button } from '@open-design/components';
import type { AgentModelOption } from '../types';
import { useI18n } from '../i18n';
import { channelLabel, channelPrice, groupTokenToSeaModels, modelOffer } from './tokenToSeaOffers';
import { Icon } from './Icon';
import { modelProviderIconSrc } from './modelProviderIcon';
import { anchorSelectionInView } from './pickerSelectionAnchor';
import {
  getModelCostTier,
  getModelCapabilityTag,
  MODEL_COST_TIER_LABEL_KEYS,
  MODEL_CAPABILITY_TAG_LABEL_KEYS,
} from './modelCapabilityTags';

export function renderModelOptions(models: AgentModelOption[]) {
  const groups = new Map<string, AgentModelOption[]>();
  const flat: AgentModelOption[] = [];
  for (const m of models) {
    const slash = m.id.indexOf('/');
    if (m.id === 'default' || slash <= 0) {
      flat.push(m);
      continue;
    }
    const provider = m.id.slice(0, slash);
    const arr = groups.get(provider) ?? [];
    arr.push(m);
    groups.set(provider, arr);
  }
  flat.sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : 0));
  if (groups.size === 0) {
    return (
      <>
        {flat.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </>
    );
  }
  return (
    <>
      {flat.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
      {Array.from(groups.entries()).map(([provider, items]) => (
        <optgroup key={provider} label={provider}>
          {items.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label.startsWith(`${provider}/`)
                ? m.label.slice(provider.length + 1)
                : m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

export function orderModelOptionsByAvailability(
  models: AgentModelOption[],
): AgentModelOption[] {
  const enabled: AgentModelOption[] = [];
  const disabled: AgentModelOption[] = [];
  for (const model of models) {
    if (model.enabled === false) disabled.push(model);
    else enabled.push(model);
  }
  return [...enabled, ...disabled];
}

// Canonical company/provider display names for the two-level model picker.
// Keyed by the model id's leading token (before the first `-`, or before a
// BYOK `provider/model` slash).
const MODEL_COMPANY_NAMES: Record<string, string> = {
  claude: 'Claude',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  glm: 'GLM',
  kimi: 'Kimi',
  qwen: 'Qwen',
  openai: 'OpenAI',
  gpt: 'OpenAI',
  o1: 'OpenAI',
  o3: 'OpenAI',
  grok: 'Grok',
  llama: 'Llama',
  mistral: 'Mistral',
  doubao: 'Doubao',
  minimax: 'MiniMax',
  moonshot: 'Moonshot',
  step: 'StepFun',
  mimo: 'MiMo',
};

/** Company key + display name for a model id (deepseek-v4-flash → deepseek /
 *  "DeepSeek"; openai/gpt-5 → openai / "OpenAI"). */
export function modelCompany(id: string, label?: string): { key: string; name: string } {
  // Connect IDs carry routing information. Supplier display names come from
  // the catalog label; neither that routing prefix nor a version is a brand.
  const supplier = /^supplier:([^/]+)\//i.exec(id);
  if (supplier) {
    const separator = label?.indexOf(' · ') ?? -1;
    return {
      key: `supplier:${supplier[1]!.toLowerCase()}`,
      name: separator > 0 ? label!.slice(0, separator) : supplier[1]!,
    };
  }
  const modelId = id.replace(/^official:/i, '');
  const slash = modelId.indexOf('/');
  const token = (slash > 0 ? modelId.slice(0, slash) : modelId.split('-')[0] ?? modelId).toLowerCase();
  const key = /^(qwen\d|tongyi)/.test(token) ? 'qwen'
    : /^step(?:audio|\d)/.test(token) ? 'step' : token;
  const name = MODEL_COMPANY_NAMES[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : id);
  return { key, name };
}

/**
 * Model name with the company token dropped — what the composer's model rows
 * and chip show (`claude-fable-5` → `fable-5`, `deepseek-v4-pro` → `v4-pro`).
 * The brand mark rendered beside the name already says which company it is, so
 * repeating it in text only spends width on the shared half of every row.
 *
 * Only a recognised company token is dropped, and only when what remains still
 * starts with a letter: ids whose leading token IS the model family (`gpt-5`,
 * `o3`) would otherwise collapse to `5` / nothing. Anything else — BYOK
 * `provider/model` ids, unknown vendors, prose labels — is returned untouched.
 * A supplier catalog label drops its source prefix in rows; the picker keeps
 * that source in the trigger, browse rail, or search-result description.
 */
export function modelVersionLabel(
  id: string,
  label?: string | null,
): string {
  const text = label ?? id;
  if (/^supplier:/i.test(id) && text.includes(' · ')) {
    return text.slice(text.indexOf(' · ') + 3);
  }
  const { key } = modelCompany(id);
  if (!Object.prototype.hasOwnProperty.call(MODEL_COMPANY_NAMES, key)) return text;
  const prefix = `${key}-`;
  if (!text.toLowerCase().startsWith(prefix)) return text;
  const rest = text.slice(prefix.length);
  return /^[A-Za-z]/.test(rest) ? rest : text;
}

interface ModelCompanyGroup {
  key: string;
  name: string;
  options: AgentModelOption[];
}

/** Group model options by company, preserving first-seen order. */
export function groupModelsByCompany(options: AgentModelOption[]): ModelCompanyGroup[] {
  const groups: ModelCompanyGroup[] = [];
  const byKey = new Map<string, ModelCompanyGroup>();
  for (const option of options) {
    const { key, name } = modelCompany(option.id, option.label);
    let group = byKey.get(key);
    if (!group) {
      group = { key, name, options: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}

function matchesModelSearch(model: AgentModelOption, query: string): boolean {
  const haystack = `${model.id}\n${model.label}`.toLowerCase();
  return haystack.includes(query);
}

interface SearchableModelSelectProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  models: AgentModelOption[];
  value: string;
  onChange: (value: string) => void;
  searchPlaceholder: string;
  searchInputTestId?: string;
  popoverTestId?: string;
  popoverClassName?: string;
  additionalOptions?: Array<{ value: string; label: string }>;
  disabledOptionHint?: (option: AgentModelOption) => string | null | undefined;
  /**
   * When provided together with a `disabledOptionHint`, a disabled option
   * renders a Lock icon at its trailing edge instead of the inline hint text.
   * Hovering the lock surfaces the hint; clicking it invokes this callback
   * (e.g. open the AMR console upgrade destination). Available models are
   * unaffected. Shared by InlineModelSwitcher, SettingsDialog, and AvatarMenu.
   */
  onDisabledOptionUpgrade?: (option: AgentModelOption) => void;
  /**
   * Keeps `enabled: false` options in the list as disabled rows (with their
   * `disabledOptionHint`) instead of hiding them. For short choice lists where
   * an option exists but is off-limits right now, such as a speed tier the
   * chosen effort cannot run.
   */
  showDisabledOptions?: boolean;
  /** A one-line description under an option's name (a speed tier's cost, say). */
  optionDescription?: (option: AgentModelOption) => string | null | undefined;
  /**
   * Opts into the two-level company/model browse (companies on the left,
   * models on the right) once the list is long enough to benefit from it.
   * Explicit opt-in rather than always-on: catalog routing IDs and labels
   * identify suppliers, while bare model IDs identify model families.
   * A single provider's own raw
   * model ids (e.g. Codex's `o1`/`o3`/`o4-mini` alongside `gpt-*`) would
   * otherwise get split into misleading fake "companies". Callers pass
   * `groupByCompany={agent.id === 'tokentosea'}` or similar.
   */
  groupByCompany?: boolean;
  /** TokenToSea catalog: models on the left and purchasable channels on the right. */
  groupByModel?: boolean;
  minSearchableOptions?: number;
  popoverMinWidth?: number;
  /**
   * Lets a wide trigger's popover keep the trigger's width instead of stopping
   * at the 560px cap, for forms where the two have to share both edges.
   */
  popoverMatchTrigger?: boolean;
  getPopoverBoundary?: () => {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  } | null;
  /**
   * Checkbox mode: rows toggle membership of `checked` and the popover stays open,
   * so several can be changed in one go. The trigger shows `triggerLabel`; `value`
   * and `onChange` are unused.
   */
  multi?: {
    checked: ReadonlySet<string>;
    triggerLabel: string;
    selectAllLabel: string;
    clearLabel: string;
    onToggle: (id: string) => void;
    onSetAll: (checked: boolean) => void;
  };
}

export const SearchableModelSelect = forwardRef<
  HTMLButtonElement,
  SearchableModelSelectProps
>(function SearchableModelSelect(
  {
    models,
    value,
    onChange,
    searchPlaceholder,
    searchInputTestId,
    popoverTestId,
    popoverClassName,
    additionalOptions,
    disabledOptionHint,
    onDisabledOptionUpgrade,
    showDisabledOptions = false,
    optionDescription,
    groupByCompany = false,
    groupByModel = false,
    minSearchableOptions = 8,
    popoverMinWidth,
    popoverMatchTrigger = false,
    getPopoverBoundary,
    multi,
    className,
    ...buttonProps
  },
  ref,
) {
  const { t, locale } = useI18n();
  const zh = locale.startsWith('zh');
  const grouped = groupByCompany || groupByModel;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [popoverStyle, setPopoverStyle] = useState<{
    placement: 'above' | 'below';
    offset: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const placementRef = useRef<'above' | 'below' | null>(null);
  const valueLabelRef = useRef<HTMLSpanElement | null>(null);
  // Whether the trigger readout hides part of the name (cut off, or shortened
  // to its version), measured on hover: only then does a native title add
  // anything, otherwise it just stacks the same text over the field.
  const [valueLabelHidesName, setValueLabelHidesName] = useState(false);
  const listboxId = useMemo(
    () => `model-picker-${Math.random().toString(36).slice(2, 10)}`,
    [],
  );
  const allOptions = useMemo(() => {
    const merged = new Map<string, AgentModelOption>();
    for (const option of models) {
      if (option.enabled !== false || showDisabledOptions) merged.set(option.id, option);
    }
    for (const option of additionalOptions ?? []) {
      if (!merged.has(option.value) && !models.some(model => model.id === option.value && model.enabled === false)) {
        merged.set(option.value, { id: option.value, label: option.label });
      }
    }
    return Array.from(merged.values());
  }, [additionalOptions, models, showDisabledOptions]);
  const selectedOption = multi
    ? null
    : allOptions.find((option) => option.id === value) ??
      (value ? { id: value, label: value } : allOptions[0] ?? null);
  const selectedTag = selectedOption
    ? getModelCapabilityTag(selectedOption)
    : null;
  const selectedTagLabel = selectedTag
    ? t(MODEL_CAPABILITY_TAG_LABEL_KEYS[selectedTag])
    : null;
  const selectedTagDescriptionId = selectedTagLabel
    ? `${listboxId}-selected-tag`
    : undefined;
  const buttonDescriptionIds = [
    buttonProps['aria-describedby'],
    selectedTagDescriptionId,
  ].filter(Boolean).join(' ') || undefined;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) return allOptions;
    return allOptions.filter(
      (option) =>
        option.id === CUSTOM_MODEL_SENTINEL ||
        matchesModelSearch(option, normalizedQuery) ||
        (groupByModel && (modelOffer(option).modelName + ' ' + channelLabel(option, zh)).toLowerCase().includes(normalizedQuery)),
    );
  }, [allOptions, normalizedQuery, groupByModel, zh]);
  const shouldShowSearch = allOptions.length >= minSearchableOptions;
  /** Search, footer, and the popover's two border pixels stay outside the scroller. */
  const popoverChromeHeight = (shouldShowSearch ? 39 : 0) + (multi ? 37 : 0) + 2;
  // Two-level browse (companies left, models right) only pays off for a long
  // cross-company list — the case worth "distinguishing companies". Small
  // pickers (a couple of models, or a single provider) stay a flat list, and
  // callers that didn't opt in via `groupByCompany` always stay flat too.
  const companyGroups = useMemo(() => groupByModel ? groupTokenToSeaModels(filteredOptions) : groupModelsByCompany(filteredOptions), [groupByModel, filteredOptions]);
  const useTwoLevel =
    grouped && !normalizedQuery && (groupByModel || (allOptions.length >= minSearchableOptions && companyGroups.length >= 2)) &&
    (popoverStyle?.width ?? 480) >= 420;
  // Grouped from the (search-)filtered options.
  const selectedCompanyKey = selectedOption && groupByModel ? modelOffer(selectedOption).modelKey : value ? modelCompany(value).key : companyGroups[0]?.key ?? null;
  const [browsedCompany, setBrowsedCompany] = useState<string | null>(null);
  // Default the open list to the selected model's company (or the first),
  // and keep it valid as the filtered group set changes.
  const activeCompanyKey =
    browsedCompany && companyGroups.some((g) => g.key === browsedCompany)
      ? browsedCompany
      : companyGroups.some((g) => g.key === selectedCompanyKey)
        ? selectedCompanyKey
        : companyGroups[0]?.key ?? null;
  const activeCompany = companyGroups.find((g) => g.key === activeCompanyKey) ?? null;
  useEffect(() => {
    if (!open) setBrowsedCompany(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Consume Escape in the capture phase so an outer surface's document
      // listener (for example Settings) cannot close before this portalled
      // picker gets a chance to handle the key. This also covers short model
      // lists without a search input, where focus stays on the trigger outside
      // the popover and the React popover handler never sees the event.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const focusOption = (index: number) => {
    const options = popoverRef.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)');
    if (!options?.length) return;
    const option = options[Math.max(0, Math.min(index, options.length - 1))];
    option?.focus({ preventScroll: true });
    option?.scrollIntoView?.({ block: 'nearest' });
  };

  const handlePopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    const inSearch = target === searchRef.current;
    const inCompany = target.classList.contains('model-select-searchable__company');
    const options = Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)') ?? []);
    const index = options.indexOf(target as HTMLButtonElement);
    if (event.key === 'Tab' || event.key === 'Escape') {
      if (event.key === 'Escape') event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (inCompany) {
        const companies = Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>('.model-select-searchable__company') ?? []);
        companies[Math.max(0, Math.min(companies.indexOf(target as HTMLButtonElement) + direction, companies.length - 1))]?.focus();
      } else {
        focusOption(index < 0 ? (direction > 0 ? 0 : options.length - 1) : index + direction);
      }
    } else if (!inSearch && (event.key === 'Home' || event.key === 'End') && !inCompany) {
      event.preventDefault();
      focusOption(event.key === 'Home' ? 0 : options.length - 1);
    } else if (inCompany && event.key === 'ArrowRight') {
      event.preventDefault();
      focusOption(0);
    } else if (index >= 0 && event.key === 'ArrowLeft' && useTwoLevel) {
      event.preventDefault();
      popoverRef.current?.querySelector<HTMLButtonElement>('.model-select-searchable__company.is-active')?.focus();
    } else if (event.key === 'Enter' && (inSearch || index >= 0)) {
      event.preventDefault();
      event.stopPropagation();
      (options[index] ?? options[0])?.click();
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect =
        buttonRef.current?.getBoundingClientRect() ??
        wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportWidth = typeof window === 'undefined' ? rect.width : window.innerWidth;
      const viewportHeight = typeof window === 'undefined' ? rect.height : window.innerHeight;
      const requestedBoundary = getPopoverBoundary?.();
      const boundaryLeft = Math.min(
        viewportWidth,
        Math.max(0, requestedBoundary?.left ?? 8),
      );
      const boundaryRight = Math.max(
        boundaryLeft,
        Math.min(viewportWidth, requestedBoundary?.right ?? viewportWidth - 8),
      );
      const boundaryTop = Math.min(
        viewportHeight,
        Math.max(0, requestedBoundary?.top ?? 8),
      );
      const boundaryBottom = Math.max(
        boundaryTop,
        Math.min(
          viewportHeight,
          requestedBoundary?.bottom ?? viewportHeight - 8,
        ),
      );

      const referenceHasLayout = rect.width > 0 || rect.height > 0;
      const referenceIsOutsideBoundary =
        referenceHasLayout &&
        (rect.bottom <= boundaryTop ||
          rect.top >= boundaryBottom ||
          rect.right <= boundaryLeft ||
          rect.left >= boundaryRight);
      if (referenceIsOutsideBoundary) {
        setPopoverStyle(null);
        setOpen(false);
        return;
      }

      // Wide triggers (e.g. the settings dialog's full-width model field)
      // must not drag the popover to field width — 560px comfortably fits
      // the two-level company/model browse and the widest model rows; a
      // caller-provided popoverMinWidth beyond that still wins, and
      // popoverMatchTrigger lifts the cap for forms that align to the field.
      const POPOVER_MAX_WIDTH = 560;
      const floorWidth = Math.max(rect.width, popoverMinWidth ?? 0, grouped ? 480 : 0);
      const desiredWidth = popoverMatchTrigger
        ? floorWidth
        : Math.min(floorWidth, Math.max(POPOVER_MAX_WIDTH, popoverMinWidth ?? 0));
      const maxWidth = Math.max(0, boundaryRight - boundaryLeft);
      const width = Math.min(desiredWidth, maxWidth);
      const left = Math.min(
        Math.max(boundaryLeft, rect.left),
        Math.max(boundaryLeft, boundaryRight - width),
      );
      const gap = 6;
      const availableBelow = Math.max(0, boundaryBottom - rect.bottom - gap);
      const availableAbove = Math.max(0, rect.top - boundaryTop - gap);
      const minimumHeight = shouldShowSearch ? 96 : 52;
      let placement = placementRef.current;
      if (placement === null) {
        placement =
          availableBelow < 260 && availableAbove > availableBelow
            ? 'above'
            : 'below';
      } else {
        const currentAvailable =
          placement === 'above' ? availableAbove : availableBelow;
        const oppositeAvailable =
          placement === 'above' ? availableBelow : availableAbove;
        if (
          currentAvailable < minimumHeight &&
          oppositeAvailable >= minimumHeight
        ) {
          placement = placement === 'above' ? 'below' : 'above';
        }
      }
      const availableHeight =
        placement === 'above' ? availableAbove : availableBelow;
      if ((referenceHasLayout && width <= 0) || availableHeight < minimumHeight) {
        setPopoverStyle(null);
        setOpen(false);
        return;
      }
      placementRef.current = placement;
      const maxHeight = Math.min(360, availableHeight);
      setPopoverStyle({
        placement,
        offset:
          placement === 'above'
            ? viewportHeight - rect.top + gap
            : rect.bottom + gap,
        left,
        width,
        maxHeight,
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [getPopoverBoundary, grouped, open, popoverMatchTrigger, popoverMinWidth, shouldShowSearch]);

  const popoverReady = popoverStyle !== null;
  useEffect(() => {
    if (!open || !popoverReady) return;
    if (shouldShowSearch) searchRef.current?.focus({ preventScroll: true });
    else {
      const selected = popoverRef.current?.querySelector<HTMLButtonElement>('button[role="option"][data-selected="true"]');
      const first = popoverRef.current?.querySelector<HTMLButtonElement>('button[role="option"]');
      (selected ?? first)?.focus({ preventScroll: true });
    }
  }, [open, popoverReady, shouldShowSearch]);

  useEffect(() => {
    if (!open) {
      placementRef.current = null;
      setQuery('');
    }
  }, [open]);

  // Land the opened list on the model in effect (OPEND-2812) instead of on the
  // top of the catalog. Once per open: the popover re-measures on scroll and
  // resize, and re-anchoring there would yank the list back out from under a
  // user who is browsing it. `popoverStyle` is a dependency because the popover
  // does not mount until the first measurement lands.
  const selectionAnchoredRef = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      selectionAnchoredRef.current = false;
      return;
    }
    if (selectionAnchoredRef.current || !popoverRef.current) return;
    selectionAnchoredRef.current = true;
    anchorSelectionInView(popoverRef.current, '[data-selected="true"]');
  }, [open, popoverStyle]);

  /** One option row — shared by the flat list and the two-level browse's
   *  models pane, so cost-tier / capability-tag / upgrade-lock affordances
   *  render identically in either layout. `index` only needs to be unique
   *  within whichever list is currently mounted. */
  function renderModelOption(option: AgentModelOption, index: number) {
    const active = option.id === value;
    const disabled = option.enabled === false;
    const disabledHint = disabled ? disabledOptionHint?.(option) : null;
    const showUpgradeLock = disabled && !!disabledHint && !!onDisabledOptionUpgrade;
    const tag = getModelCapabilityTag(option);
    const tagLabel = tag ? t(MODEL_CAPABILITY_TAG_LABEL_KEYS[tag]) : null;
    const costTier = getModelCostTier(option);
    const costLabel = costTier ? t(MODEL_COST_TIER_LABEL_KEYS[costTier]) : null;
    const optionId = `${listboxId}-option-${index}`;
    const optionLabelId = `${optionId}-label`;
    const optionCostId = costLabel ? `${optionId}-cost` : undefined;
    const optionTagId = tagLabel ? `${optionId}-tag` : undefined;
    const optionDisabledId = disabledHint ? `${optionId}-disabled` : undefined;
    const description = optionDescription?.(option) || null;
    const optionNoteId = description ? `${optionId}-description` : undefined;
    const sourceLabel = groupByModel ? [!useTwoLevel && channelLabel(option, zh, allOptions), channelPrice(option, zh)].filter(Boolean).join(' · ')
      : groupByCompany && !useTwoLevel && /^supplier:/i.test(option.id)
      ? modelCompany(option.id, option.label).name : null;
    const sourceLabelId = sourceLabel ? `${optionId}-source` : undefined;
    const optionDescriptionIds = [sourceLabelId, optionNoteId, optionCostId, optionTagId, optionDisabledId]
      .filter(Boolean)
      .join(' ') || undefined;
    const optionLogoSrc = modelProviderIconSrc(option.id);
    const checked = multi?.checked.has(option.id) ?? false;
    const optionContent = (
      <span className="model-select-searchable__option-content">
        {multi ? (
          <span className="model-select-searchable__option-box" data-checked={checked ? 'true' : undefined}>
            {checked ? <Icon name="check" size={12} /> : null}
          </span>
        ) : null}
        {optionLogoSrc ? (
          <span className="model-select-searchable__option-logo" aria-hidden="true">
            <img src={optionLogoSrc} alt="" width={16} height={16} />
          </span>
        ) : null}
        <span className="model-select-searchable__option-copy">
          <span className="model-select-searchable__option-label">
            <span id={optionLabelId}>
              {groupByModel ? (useTwoLevel ? channelLabel(option, zh, activeCompany?.options) : modelOffer(option).modelName) : groupByCompany ? modelVersionLabel(option.id, option.label) : option.label}
            </span>
          </span>
          {sourceLabel ? (
            <span className="model-select-searchable__option-meta" id={sourceLabelId}>{sourceLabel}</span>
          ) : null}
          {description ? (
            <span className="model-select-searchable__option-meta model-select-searchable__option-description" id={optionNoteId}>
              {description}
            </span>
          ) : null}
          {costLabel ? (
            <span className="model-select-searchable__option-meta" id={optionCostId}>
              {costLabel}
            </span>
          ) : null}
          {disabledHint && !showUpgradeLock ? (
            <span className="model-select-searchable__option-meta" id={optionDisabledId}>
              {disabledHint}
            </span>
          ) : null}
        </span>
        {active ? (
          <Icon name="check" size={14} className="model-select-searchable__option-check" />
        ) : null}
        {showUpgradeLock || tagLabel ? (
          <span className="model-select-searchable__option-affordances">
            {showUpgradeLock ? (
              <button
                type="button"
                className="model-select-searchable__option-lock-inline od-tooltip"
                data-testid="model-option-upgrade-lock"
                id={optionDisabledId}
                data-tooltip={disabledHint ?? undefined}
                data-tooltip-placement="top"
                title={disabledHint ?? undefined}
                aria-label={disabledHint ?? undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  onDisabledOptionUpgrade?.(option);
                }}
              >
                <Icon name="lock" size={13} />
              </button>
            ) : null}
            {tagLabel ? (
              <span
                className="model-select-searchable__option-badge"
                data-tag={tag}
                id={optionTagId}
              >
                {tagLabel}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    );
    if (showUpgradeLock) {
      return (
        <div
          key={option.id}
          role="option"
          tabIndex={-1}
          aria-selected={active}
          aria-disabled="true"
          aria-labelledby={optionLabelId}
          aria-describedby={optionDescriptionIds}
          /* The row label is ellipsised, and a long catalog can share a prefix
             across many rows, so the full name must survive on hover. */
          title={option.label}
          className={`model-select-searchable__option${active ? ' is-active' : ''} is-disabled`}
          data-selected={active ? 'true' : undefined}
        >
          {optionContent}
        </div>
      );
    }
    return (
      <button
        key={option.id}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={multi ? checked : active}
        aria-disabled={disabled}
        aria-labelledby={optionLabelId}
        aria-describedby={optionDescriptionIds}
        title={option.label}
        className={`model-select-searchable__option${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
        data-selected={active ? 'true' : undefined}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (multi) {
            multi.onToggle(option.id);
            return;
          }
          onChange(option.id);
          setOpen(false);
          buttonRef.current?.focus({ preventScroll: true });
        }}
      >
        {optionContent}
      </button>
    );
  }

  return (
    <div className={`model-select-searchable${open ? ' is-open' : ''}`} ref={wrapRef}>
      <button
        {...buttonProps}
        ref={(node) => {
          buttonRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-describedby={buttonDescriptionIds}
        /* The trigger readout truncates the same way its option rows do; the
           full name stays reachable on hover whenever the readout hides part
           of it. A caller-supplied title wins. */
        title={
          buttonProps.title ??
          (valueLabelHidesName ? multi?.triggerLabel ?? selectedOption?.label : undefined) ??
          undefined
        }
        onMouseEnter={(event) => {
          buttonProps.onMouseEnter?.(event);
          const node = valueLabelRef.current;
          const fullName = multi?.triggerLabel ?? selectedOption?.label ?? '';
          setValueLabelHidesName(
            Boolean(
              node &&
                fullName &&
                (node.scrollWidth > node.clientWidth || node.textContent?.trim() !== fullName.trim()),
            ),
          );
        }}
        className={className}
        onClick={(event) => {
          buttonProps.onClick?.(event);
          if (!event.defaultPrevented) setOpen((prev) => !prev);
        }}
        onKeyDown={(event) => {
          buttonProps.onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            if (open) focusOption(event.key === 'ArrowDown' ? 0 : Number.MAX_SAFE_INTEGER);
            else setOpen(true);
          }
        }}
      >
        <span className="model-select-searchable__value">
          <span className="model-select-searchable__value-label" ref={valueLabelRef}>
            {/* Same name the option rows show, so the readout cannot say
                `deepseek-v4-pro` about a row that called itself `v4-pro`.
                Outside the company-grouped catalog the label IS the id the
                request will carry (BYOK), so it stays verbatim. */}
            {multi
              ? multi.triggerLabel
              : selectedOption
                ? groupByModel ? [modelOffer(selectedOption).modelName, modelOffer(selectedOption).channel && channelLabel(selectedOption, zh)].filter(Boolean).join(' · ')
                  : groupByCompany && !/^supplier:/i.test(selectedOption.id)
                  ? modelVersionLabel(selectedOption.id, selectedOption.label)
                  : selectedOption.label
                : ''}
          </span>
          {selectedTagLabel ? (
            <span
              className="model-select-searchable__value-badge"
              data-tag={selectedTag}
              id={selectedTagDescriptionId}
            >
              {selectedTagLabel}
            </span>
          ) : null}
        </span>
        <Icon name="chevron-down" size={14} className="model-select-searchable__chevron" />
      </button>
      {open && popoverStyle
        ? createPortal(
            <div
              ref={popoverRef}
              className={`model-select-searchable__popover${grouped ? ' model-select-searchable__popover--catalog' : ''}${groupByModel ? ' model-select-searchable__popover--offers' : ''}${popoverClassName ? ` ${popoverClassName}` : ''}`}
              role="presentation"
              data-testid={popoverTestId}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={handlePopoverKeyDown}
              style={{
                position: 'fixed',
                top:
                  popoverStyle.placement === 'below'
                    ? `${popoverStyle.offset}px`
                    : 'auto',
                right: 'auto',
                bottom:
                  popoverStyle.placement === 'above'
                    ? `${popoverStyle.offset}px`
                    : 'auto',
                left: `${popoverStyle.left}px`,
                width: `${popoverStyle.width}px`,
                maxHeight: `${popoverStyle.maxHeight}px`,
              }}
            >
              {shouldShowSearch ? (
                <div className="model-select-searchable__search-row">
                  <Icon name="search" size={14} className="model-select-searchable__search-icon" />
                  <input
                    ref={searchRef}
                    type="search"
                    className="model-select-searchable__input"
                    value={query}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                    aria-controls={listboxId}
                    data-testid={searchInputTestId}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              ) : null}
              {useTwoLevel ? (
                /* Two-level browse: companies on the left, the chosen
                   company's models on the right. Each model keeps the same
                   cost-tier / capability-tag / upgrade-lock affordances the
                   flat list below renders. */
                <div
                  className="model-select-searchable__body"
                  style={{
                    maxHeight: `${Math.max(0, popoverStyle.maxHeight - popoverChromeHeight)}px`,
                  }}
                >
                  {companyGroups.length === 0 ? (
                    <div className="model-select-searchable__empty">{t('fantay.gen.model.noMatch')}</div>
                  ) : (
                    <>
                      <div className="model-select-searchable__companies">
                        {companyGroups.map((group) => {
                          const isActive = group.key === activeCompanyKey;
                          const hasSelected = group.options.some((o) => o.id === value);
                          const companyLogoSrc = group.key.startsWith('supplier:') ? null : modelProviderIconSrc(
                            group.options[0]?.id ?? group.key,
                          );
                          return (
                            <button
                              key={group.key}
                              type="button"
                              className={`model-select-searchable__company${isActive ? ' is-active' : ''}${hasSelected ? ' has-selected' : ''}`}
                              data-testid={`model-company-${group.key}`}
                              /* The company rail scrolls too — mark the one
                                 holding the selection so opening anchors both
                                 panes on it, not just the models pane. */
                              data-selected={hasSelected ? 'true' : undefined}
                              aria-pressed={isActive}
                              title={group.name}
                              onFocus={() => setBrowsedCompany(group.key)}
                              onClick={() => setBrowsedCompany(group.key)}
                            >
                              <span className="model-select-searchable__company-name">
                                {companyLogoSrc ? (
                                  <img
                                    className="model-select-searchable__company-logo"
                                    src={companyLogoSrc}
                                    alt=""
                                    width={16}
                                    height={16}
                                  />
                                ) : null}
                                <span>{group.name}</span>
                              </span>
                              <span className="model-select-searchable__company-count" aria-hidden>{group.options.length}</span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="model-select-searchable__models" id={listboxId} role="listbox" aria-label={activeCompany?.name} aria-multiselectable={multi ? true : undefined}>
                        {(activeCompany?.options ?? []).map((option, index) =>
                          renderModelOption(option, index),
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div
                  className="model-select-searchable__list"
                  id={listboxId}
                  role="listbox"
                  aria-multiselectable={multi ? true : undefined}
                  style={{
                    maxHeight: `${Math.max(0, popoverStyle.maxHeight - popoverChromeHeight)}px`,
                  }}
                >
                  {filteredOptions.map((option, index) => renderModelOption(option, index))}
                  {filteredOptions.length === 0 ? (
                    <div className="model-select-searchable__empty" role="status">{t('fantay.gen.model.noMatch')}</div>
                  ) : null}
                </div>
              )}
              {multi ? (
                <div className="model-select-searchable__footer">
                  <Button size="sm" variant="ghost" onClick={() => multi.onSetAll(true)}>
                    {multi.selectAllLabel}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => multi.onSetAll(false)}>
                    {multi.clearLabel}
                  </Button>
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});

export function isCustomModel(
  modelId: string | null | undefined,
  models: AgentModelOption[],
): boolean {
  if (!modelId) return false;
  return !models.some((m) => m.id === modelId);
}

export const CUSTOM_MODEL_SENTINEL = '__custom__';
