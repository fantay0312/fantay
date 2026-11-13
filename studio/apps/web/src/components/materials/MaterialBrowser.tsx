// SPDX-License-Identifier: Apache-2.0
// Search + kind (+ category) filters and the infinite material grid, extracted from the composer's
// picker (spec 07 §7.1) so the Fantay materials drawer shows the same archive the same way.
//
//   mode "pick"   — the composer's "从素材库添加" dialog: cards are toggle buttons (multi-select); the
//                   toolbar keeps the picker's search field and kind segments, test ids `material-picker-*`.
//   mode "drawer" — the Fantay drawer: cards drag onto the board and carry the drawer's actions (insert,
//                   details); the toolbar is built from the Fantay primitives, test ids `materials-drawer-*`.
//
// Data comes from the daemon's `/api/materials/*` routes through the shared hooks; nothing is fetched
// until `enabled` is first true.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import type { MaterialSummaryItem } from '@open-design/contracts';
import { useT } from '../../i18n';
import {
  Button,
  Chip,
  InputGroupClear,
  Kbd,
  SearchField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  VisuallyHidden,
} from '../../fantay/ui';
import { Icon } from '../Icon';
import { MaterialCover } from './MaterialCover';
import { MaterialLibraryControls, useMaterialLibraryScope } from './MaterialLibraryControls';
import { MaterialKindFilter, MaterialSearchField } from './MaterialFilters';
import { MaterialRequestFailed, MaterialUnavailable } from './MaterialStates';
import {
  MATERIAL_SEARCH_DEBOUNCE_MS,
  materialCategoryOptions,
  materialKindLabel,
  materialKindOptions,
  materialResultCountLabel,
} from './material-model';
import {
  useDebouncedValue,
  useInfiniteSentinel,
  useMaterialSearch,
  useMaterialSummary,
} from './useMaterialSearch';
import styles from './MaterialBrowser.module.css';

/** Radix Select reserves "" for "nothing chosen"; "all categories" uses this value instead. */
const ALL_CATEGORIES = '__all-categories__';

/** Attribute on the element a card click hands focus back to when its detail dialog closes. */
export const MATERIAL_DETAIL_TRIGGER_ATTR = 'data-material-detail-trigger';

export interface MaterialBrowserProps {
  mode: 'pick' | 'drawer';
  /** Fetch nothing until this is first true (the drawer passes "has been opened"). */
  enabled: boolean;
  /** Keeps `material-picker-search/-kind-filter/-grid/-card/-empty` for the dialog. */
  testIdPrefix: 'material-picker' | 'materials-drawer';
  searchRef?: Ref<HTMLInputElement>;
  /** Focus the search field whenever this turns true while the library is available. */
  autoFocusSearch?: boolean;
  /** Category filter (drawer). */
  showCategory?: boolean;
  /** Fixed column count (drawer: 2); default an auto-fill grid. */
  columns?: number;
  className?: string;
  // pick mode
  selected?: ReadonlyMap<string, MaterialSummaryItem>;
  onToggle?: (item: MaterialSummaryItem) => void;
  // drawer mode
  renderCardActions?: (item: MaterialSummaryItem) => ReactNode;
  onCardDragStart?: (item: MaterialSummaryItem, event: DragEvent<HTMLElement>) => void;
  /** `trigger` = the element focus should return to after the detail dialog closes. */
  onOpenDetail?: (item: MaterialSummaryItem, trigger: HTMLElement) => void;
  /** Result count once a search settles (null while loading or unavailable), for a header count. */
  onResultsChange?: (results: { total: number } | null) => void;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as { current: T | null }).current = value;
}

export function MaterialBrowser({
  mode,
  enabled,
  testIdPrefix,
  searchRef,
  autoFocusSearch = false,
  showCategory = false,
  columns,
  className,
  selected,
  onToggle,
  renderCardActions,
  onCardDragStart,
  onOpenDetail,
  onResultsChange,
}: MaterialBrowserProps) {
  const t = useT();
  const [libraryId, setLibraryId] = useMaterialLibraryScope(`fantay.materials.library.${mode}`);
  const summaryState = useMaterialSummary(enabled, libraryId);
  const summary = summaryState.summary;
  const libraryEnabled = summary?.status.enabled === true;
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [category, setCategory] = useState('');
  const debouncedQuery = useDebouncedValue(query, MATERIAL_SEARCH_DEBOUNCE_MS);
  const search = useMaterialSearch(
    { q: debouncedQuery, kind, category: showCategory ? category : '', libraryId },
    { enabled: enabled && libraryEnabled && summaryState.phase === 'ready' },
  );

  const inputRef = useRef<HTMLInputElement | null>(null);
  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      assignRef(searchRef, node);
    },
    [searchRef],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoFocusSearch && libraryEnabled) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocusSearch, libraryEnabled]);

  useInfiniteSentinel(sentinelRef, search.loadMore, {
    enabled: search.hasMore && !search.loadingMore && !search.moreError,
    revision: search.items.length,
    root: scrollRef,
    rootMargin: '320px 0px',
  });

  const onResultsChangeRef = useRef(onResultsChange);
  onResultsChangeRef.current = onResultsChange;
  const settledTotal = search.phase === 'ready' ? search.total : null;
  useEffect(() => {
    onResultsChangeRef.current?.(settledTotal === null ? null : { total: settledTotal });
  }, [settledTotal]);

  const categories = useMemo(
    () => (showCategory ? materialCategoryOptions(summary?.categories) : []),
    [showCategory, summary?.categories],
  );
  const filtered = Boolean(debouncedQuery.trim() || kind || category);
  const clearFilters = useCallback(() => {
    setQuery('');
    setKind('');
    setCategory('');
    inputRef.current?.focus();
  }, []);

  const drawer = mode === 'drawer';
  const cardTestId = `${testIdPrefix}-card`;
  const retryButton = (onRetry: () => void) => (
    <Button size="sm" onClick={onRetry}>
      {t('materials.retry')}
    </Button>
  );

  let body: ReactNode;
  if (!enabled || summaryState.phase === 'idle' || summaryState.phase === 'loading') {
    body = <p className={styles.placeholder}>{t('materials.loading')}</p>;
  } else if (summaryState.phase === 'error') {
    body = <MaterialRequestFailed compact detail={summaryState.error ?? ''} onRetry={summaryState.reload} />;
  } else if (!libraryEnabled && summary) {
    body = <MaterialUnavailable compact status={summary.status} onRetry={summaryState.reload} />;
  } else if (search.phase === 'error') {
    body = <MaterialRequestFailed compact detail={search.error ?? ''} onRetry={search.retry} />;
  } else if (search.phase === 'ready' && search.items.length === 0) {
    body = drawer ? (
      <div className={styles.drawerEmpty} data-testid={`${testIdPrefix}-empty`}>
        <p className={styles.drawerEmptyTitle}>{t('materials.empty')}</p>
        {filtered ? (
          <>
            <p className={styles.drawerEmptyHint}>{t('materials.emptyHint')}</p>
            <Button size="sm" onClick={clearFilters}>
              {t('materials.clearFilters')}
            </Button>
          </>
        ) : null}
      </div>
    ) : (
      <p className={styles.placeholder} data-testid={`${testIdPrefix}-empty`}>
        {t('materials.empty')}
      </p>
    );
  } else if (search.phase !== 'ready') {
    body = <p className={styles.placeholder}>{t('materials.loading')}</p>;
  } else {
    body = (
      <>
        <ul
          className={drawer ? styles.drawerGrid : styles.grid}
          style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
          data-testid={`${testIdPrefix}-grid`}
        >
          {search.items.map((item) =>
            drawer ? (
              <DrawerCard
                key={item.id}
                item={item}
                testId={cardTestId}
                renderActions={renderCardActions}
                onDragStart={onCardDragStart}
                onOpenDetail={onOpenDetail}
              />
            ) : (
              <PickerCard
                key={item.id}
                item={item}
                testId={cardTestId}
                selected={selected?.has(item.id) ?? false}
                onToggle={onToggle}
              />
            ),
          )}
        </ul>
        <div ref={sentinelRef} className={styles.sentinel} aria-hidden />
        {search.loadingMore ? (
          <p className={styles.more}>{t('materials.loadingMore')}</p>
        ) : search.moreError ? (
          <div className={styles.more}>
            <span>{t('materials.loadMoreFailed', { detail: search.moreError })}</span>
            {retryButton(search.retry)}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className={[drawer ? styles.drawerRoot : styles.root, className].filter(Boolean).join(' ')} data-mode={mode}>
      {enabled ? <MaterialLibraryControls libraries={summary?.libraries} libraryId={libraryId}
        resolvedLibraryId={summary?.libraryId}
        onChange={(id) => { setLibraryId(id); setCategory(''); setKind(''); }} onRefresh={summaryState.reload} /> : null}
      {libraryEnabled ? (
        drawer ? (
          <div className={styles.drawerToolbar} role="search">
            <div className={styles.drawerToolbarRow}>
              <SearchField
                ref={setInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('materials.searchPlaceholder')}
                aria-label={t('materials.searchLabel')}
                aria-keyshortcuts="/"
                autoComplete="off"
                spellCheck={false}
                className={styles.drawerSearch}
                data-testid={`${testIdPrefix}-search`}
                trailing={
                  query ? (
                    <InputGroupClear
                      onClear={() => {
                        setQuery('');
                        inputRef.current?.focus();
                      }}
                    />
                  ) : (
                    <Kbd aria-hidden>/</Kbd>
                  )
                }
              />
              {showCategory ? (
                <Select
                  value={category || ALL_CATEGORIES}
                  onValueChange={(next) => setCategory(next === ALL_CATEGORIES ? '' : next)}
                >
                  <SelectTrigger
                    aria-label={t('materials.categoryLabel')}
                    className={styles.drawerCategory}
                    data-testid={`${testIdPrefix}-category`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_CATEGORIES}>{t('materials.categoryAll')}</SelectItem>
                    {categories.map((option) => (
                      <SelectItem key={option.name} value={option.name}>
                        {`${option.name} (${option.count})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
            <MaterialKindChips
              value={kind}
              onChange={setKind}
              counts={summary?.kinds ?? null}
              total={summary?.total ?? null}
              testId={`${testIdPrefix}-kind-filter`}
            />
          </div>
        ) : (
          <div className={styles.toolbar}>
            <MaterialSearchField
              ref={setInputRef}
              value={query}
              onChange={setQuery}
              testId={`${testIdPrefix}-search`}
            />
            <MaterialKindFilter
              value={kind}
              onChange={setKind}
              counts={summary?.kinds ?? null}
              total={summary?.total ?? null}
              testId={`${testIdPrefix}-kind-filter`}
            />
          </div>
        )
      ) : null}
      <div ref={scrollRef} className={drawer ? styles.drawerScroll : styles.scroll}>
        {body}
      </div>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {search.phase === 'ready' ? materialResultCountLabel(search.total, t) : ''}
      </VisuallyHidden>
    </div>
  );
}

interface KindChipsProps {
  value: string;
  onChange: (kind: string) => void;
  counts: Record<string, number> | null;
  total: number | null;
  testId: string;
}

/** The kind filter as a scrolling row of toggle chips (drawer); "All" clears it. */
function MaterialKindChips({ value, onChange, counts, total, testId }: KindChipsProps) {
  const t = useT();
  const kinds = materialKindOptions(counts, value);
  return (
    <div className={styles.kindChips} role="group" aria-label={t('materials.kindLabel')} data-testid={testId}>
      <Chip
        size="sm"
        variant="suggestion"
        on={value === ''}
        aria-pressed={value === ''}
        onClick={() => onChange('')}
        data-kind=""
      >
        {t('materials.filterAll')}
        {typeof total === 'number' ? <span className={styles.chipCount}>{total}</span> : null}
      </Chip>
      {kinds.map((kind) => (
        <Chip
          key={kind}
          size="sm"
          variant="suggestion"
          on={value === kind}
          aria-pressed={value === kind}
          onClick={() => onChange(value === kind ? '' : kind)}
          data-kind={kind}
        >
          {materialKindLabel(kind, t)}
          {counts && typeof counts[kind] === 'number' ? <span className={styles.chipCount}>{counts[kind]}</span> : null}
        </Chip>
      ))}
    </div>
  );
}

interface PickerCardProps {
  item: MaterialSummaryItem;
  testId: string;
  selected: boolean;
  onToggle?: (item: MaterialSummaryItem) => void;
}

const PickerCard = memo(function PickerCard({ item, testId, selected, onToggle }: PickerCardProps) {
  const t = useT();
  return (
    <li className={styles.cell}>
      <button
        type="button"
        className={styles.card}
        aria-pressed={selected}
        onClick={() => onToggle?.(item)}
        data-testid={testId}
        data-material-id={item.id}
      >
        <span className={styles.coverWrap}>
          <MaterialCover item={item} />
          <span className={styles.check} aria-hidden data-checked={selected ? 'true' : 'false'}>
            <Icon name="check" size={13} />
          </span>
        </span>
        <span className={styles.cardTitle} dir="auto">{item.title}</span>
        <span className={styles.cardMeta}>
          {[item.libraryName, materialKindLabel(item.kind, t), item.collection].filter(Boolean).join(' · ')}
        </span>
      </button>
    </li>
  );
});

interface DrawerCardProps {
  item: MaterialSummaryItem;
  testId: string;
  renderActions?: (item: MaterialSummaryItem) => ReactNode;
  onDragStart?: (item: MaterialSummaryItem, event: DragEvent<HTMLElement>) => void;
  onOpenDetail?: (item: MaterialSummaryItem, trigger: HTMLElement) => void;
}

/* The whole card drags (buttons inside a draggable element do not start a drag in every browser, so the
   card itself is not a button). Clicking it opens the details as a pointer shortcut; the keyboard path is
   the card's own details action, which is also where focus returns. */
const DrawerCard = memo(function DrawerCard({ item, testId, renderActions, onDragStart, onOpenDetail }: DrawerCardProps) {
  const t = useT();
  const actions = renderActions?.(item);
  const openDetail = (event: MouseEvent<HTMLDivElement>) => {
    if (!onOpenDetail) return;
    const target = event.target as Element | null;
    if (target?.closest('[data-card-actions]')) return;
    const trigger = event.currentTarget.querySelector<HTMLElement>(`[${MATERIAL_DETAIL_TRIGGER_ATTR}]`);
    onOpenDetail(item, trigger ?? event.currentTarget);
  };
  return (
    <li className={styles.drawerCell}>
      <div
        className={styles.drawerCard}
        draggable={Boolean(onDragStart)}
        onDragStart={onDragStart ? (event) => onDragStart(item, event) : undefined}
        onClick={openDetail}
        data-testid={testId}
        data-material-id={item.id}
      >
        <span className={styles.drawerCover}>
          <MaterialCover item={item} />
        </span>
        <span className={styles.drawerTitle} dir="auto">{item.title}</span>
        <span className={styles.drawerMeta}>
          {[item.libraryName, materialKindLabel(item.kind, t), item.collection].filter(Boolean).join(' · ')}
        </span>
        {actions ? (
          <div
            className={styles.drawerActions}
            role="group"
            aria-label={t('materials.drawer.cardActions', { title: item.title })}
            data-card-actions=""
          >
            {actions}
          </div>
        ) : null}
      </div>
    </li>
  );
});
