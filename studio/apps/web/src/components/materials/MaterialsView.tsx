// 素材库 (Materials): browse the owner's external, read-only material archive.
//
// Data comes only from the daemon's `/api/materials/*` routes (contract:
// `packages/contracts/src/api/materials.ts`). The grid has no pagination UI:
// batches of 24 append as the sentinel under the grid scrolls near view.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { MaterialSummaryItem } from '@open-design/contracts';
import { Button, VisuallyHidden } from '@open-design/components';
import { useI18n, useT, type Locale } from '../../i18n';
import { usePageNavigationReady } from '../../observability/navigation-timing';
import { MaterialCover } from './MaterialCover';
import { MaterialDetailDialog } from './MaterialDetailDialog';
import { MaterialLibraryControls, useMaterialLibraryScope } from './MaterialLibraryControls';
import {
  MaterialCategoryTabs,
  MaterialSearchField,
  MaterialSectionCapsules,
} from './MaterialFilters';
import { MaterialRequestFailed, MaterialUnavailable } from './MaterialStates';
import {
  MATERIAL_SEARCH_DEBOUNCE_MS,
  formatSkillCommand,
  getMaterialArchetype,
  getPrimaryTabOptions,
  getSecondarySectionOptions,
  isSafeCssColor,
  isWebsiteMaterial,
  materialBlurb,
  materialCategoryOptions,
  materialCoverText,
  materialKindLabel,
  materialResultCountLabel,
  materialSourceHost,
  matchesMaterialCategory,
  safeMaterialSourceUrl,
} from './material-model';
import {
  useDebouncedValue,
  useInfiniteSentinel,
  useMaterialSearch,
  useMaterialSummary,
} from './useMaterialSearch';
import { copyToClipboard } from '../../lib/copy-to-clipboard';
import { Icon } from '../Icon';
import styles from './MaterialsView.module.css';

interface Props {
  /** The entry shell keeps the view mounted; only the active one fetches and listens for `/`. */
  isActive: boolean;
  renderLayout?: (parts: {
    inventory: ReactNode;
    controls: ReactNode;
    gallery: ReactNode;
  }) => ReactNode;
}

/** True when a keystroke belongs to something the user is typing into. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function MaterialsView({ isActive, renderLayout }: Props) {
  const { locale, t } = useI18n();
  // Fetch nothing until the view is first shown; keep state afterwards so a
  // tab switch keeps the loaded batches and filters. (The shared entry scroll
  // container still returns to the top on every view change.)
  const [visited, setVisited] = useState(isActive);
  useEffect(() => {
    if (isActive) setVisited(true);
  }, [isActive]);

  const [libraryId, setLibraryId] = useMaterialLibraryScope('fantay.materials.library');
  const summaryState = useMaterialSummary(visited, libraryId);
  const summary = summaryState.summary;
  const libraryEnabled = summary?.status.enabled === true;

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [category, setCategory] = useState('');
  const [section, setSection] = useState('');
  const [collection, setCollection] = useState('');

  const debouncedQuery = useDebouncedValue(query, MATERIAL_SEARCH_DEBOUNCE_MS);
  const search = useMaterialSearch(
    { q: debouncedQuery, kind, category, section, libraryId },
    { enabled: visited && libraryEnabled && summaryState.phase === 'ready' },
  );

  const [openItem, setOpenItem] = useState<MaterialSummaryItem | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  usePageNavigationReady({
    page: 'materials',
    visible: isActive && summaryState.phase !== 'idle',
    ready:
      isActive
      && (summaryState.phase === 'error'
        || (summaryState.phase === 'ready' && (!libraryEnabled || search.phase === 'ready' || search.phase === 'error'))),
  });

  // `/` jumps to search, the way most catalog pages do — unless the user is
  // already typing somewhere or the detail dialog owns the keyboard.
  useEffect(() => {
    if (!isActive || openItem) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      const input = searchRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isActive, openItem]);

  useInfiniteSentinel(sentinelRef, search.loadMore, {
    enabled: isActive && search.hasMore && !search.loadingMore && !search.moreError,
    revision: search.items.length,
  });

  const openDetail = useCallback((item: MaterialSummaryItem, trigger: HTMLElement) => {
    returnFocusRef.current = trigger;
    setOpenItem(item);
  }, []);

  const closeDetail = useCallback(() => setOpenItem(null), []);

  // Leaving the view (Back, rail, tab) closes the detail dialog: it portals to
  // <body>, so it would otherwise cover the next page. Its trigger card is
  // hidden now, so skip the focus return.
  useEffect(() => {
    if (isActive) return;
    returnFocusRef.current = null;
    setOpenItem(null);
  }, [isActive]);

  // Once the dialog has unmounted (this commit), put focus back on the card
  // that opened it — in the same commit, so nothing else can grab it first.
  useEffect(() => {
    if (openItem) return;
    const trigger = returnFocusRef.current;
    returnFocusRef.current = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, [openItem]);

  const primaryTabs = useMemo(() => getPrimaryTabOptions(summary), [summary]);
  const [categoryItems, setCategoryItems] = useState<MaterialSummaryItem[]>([]);

  useEffect(() => {
    if (!section && search.items.length > 0) {
      setCategoryItems(search.items);
    }
  }, [category, section, search.items]);

  const secondarySections = useMemo(
    () => getSecondarySectionOptions(category, categoryItems.length > 0 ? categoryItems : search.items),
    [category, categoryItems, search.items],
  );

  // Client-side filtering ensures category, section, collection and query seamlessly coordinate
  const displayedItems = useMemo(() => {
    return search.items.filter((item) => {
      if (!matchesMaterialCategory(item, category)) return false;
      if (section && item.section !== section) return false;
      if (collection && item.collection !== collection) return false;
      return true;
    });
  }, [search.items, category, section, collection]);

  const filtered = Boolean(debouncedQuery.trim() || kind || category || section || collection);
  const displayedCount = displayedItems.length;

  const handleCategoryChange = useCallback((newCategory: string) => {
    setCategory(newCategory);
    setSection('');
    setCollection('');
    setCategoryItems([]);
  }, []);

  const handleSectionChange = useCallback((newSection: string) => {
    setSection((current) => (current === newSection ? '' : newSection));
  }, []);

  function clearFilters() {
    setQuery('');
    setKind('');
    setCategory('');
    setSection('');
    setCollection('');
    searchRef.current?.focus();
  }

  const inventory = libraryEnabled && summary ? (
    <p className={styles.inventory} data-testid="materials-inventory">
      {t('materials.inventory', {
        total: summary.total,
        categories: Object.keys(summary.categories).length,
        collections: Object.keys(summary.collections).length,
      })}
      {summary.status.indexUpdatedAt ? (
        <>
          {' · '}
          {t('materials.indexUpdated', {
            date: formatIndexDate(summary.status.indexUpdatedAt, locale),
          })}
        </>
      ) : null}
    </p>
  ) : null;

  const controls = isActive ? (
    <MaterialLibraryControls
      page
      libraries={summary?.libraries}
      libraryId={libraryId}
      resolvedLibraryId={summary?.libraryId}
      onChange={(id) => {
        setLibraryId(id);
        setKind('');
        setCategory('');
        setSection('');
        setCollection('');
        setOpenItem(null);
      }}
      onRefresh={summaryState.reload}
    />
  ) : null;

  let content: ReactNode;
  if (!visited || summaryState.phase === 'idle' || summaryState.phase === 'loading') {
    content = (
      <p className={styles.placeholder} role="status">
        {t('materials.loading')}
      </p>
    );
  } else if (summaryState.phase === 'error') {
    content = (
      <MaterialRequestFailed
        detail={summaryState.error ?? ''}
        onRetry={summaryState.reload}
      />
    );
  } else if (!libraryEnabled && summary) {
    content = <MaterialUnavailable status={summary.status} onRetry={summaryState.reload} />;
  } else {
    content = (
      <>
        {/* Level 1: Primary Category Hairline Tabs (38px, Paper & Ink #202020) */}
        <div className={styles.level1Container}>
          <MaterialCategoryTabs
            category={category}
            onChange={handleCategoryChange}
            tabs={primaryTabs}
            testId="materials-category-tabs"
          />
        </div>

        {/* Level 2: Secondary Section Micro-Capsules (26px) + Search Toolbar */}
        <div className={styles.subToolbar}>
          <div className={styles.capsuleStrip}>
            <MaterialSectionCapsules
              section={section}
              onChange={handleSectionChange}
              sections={secondarySections}
              totalCount={primaryTabs.find((t) => t.category === category)?.count ?? summary?.total}
              testId="materials-section-capsules"
            />
          </div>
          <div className={styles.searchRow}>
            <MaterialSearchField
              ref={searchRef}
              value={query}
              onChange={setQuery}
              shortcutHint
              testId="materials-search"
            />
            {filtered ? (
              <span className={styles.count} aria-hidden data-testid="materials-count">
                {search.phase === 'ready' ? materialResultCountLabel(displayedCount, t) : ''}
              </span>
            ) : null}
          </div>
        </div>

        <VisuallyHidden role="status" aria-live="polite" aria-atomic="true" data-testid="materials-live">
          {search.phase === 'ready' ? materialResultCountLabel(filtered ? displayedCount : search.total, t) : ''}
        </VisuallyHidden>

        {search.phase === 'error' ? (
          <MaterialRequestFailed detail={search.error ?? ''} onRetry={search.retry} />
        ) : search.phase === 'ready' && displayedItems.length === 0 ? (
          <div className={styles.empty} data-testid="materials-empty">
            <p className={styles.emptyTitle}>{t('materials.empty')}</p>
            {filtered ? (
              <>
                <p className={styles.emptyHint}>{t('materials.emptyHint')}</p>
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  {t('materials.clearFilters')}
                </Button>
              </>
            ) : null}
            {search.hasMore ? (
              <div ref={sentinelRef} className={styles.sentinel} aria-hidden data-testid="materials-sentinel" />
            ) : null}
          </div>
        ) : search.phase !== 'ready' ? (
          <p className={styles.placeholder}>{t('materials.loading')}</p>
        ) : (
          <>
            <ul className={styles.grid} data-testid="materials-grid">
              {displayedItems.map((item) => (
                <MaterialCard key={item.id} item={item} onOpen={openDetail} />
              ))}
            </ul>
            <div ref={sentinelRef} className={styles.sentinel} aria-hidden data-testid="materials-sentinel" />
            {search.loadingMore ? (
              <p className={styles.more} role="status">
                {t('materials.loadingMore')}
              </p>
            ) : search.moreError ? (
              <div className={styles.more}>
                <span>{t('materials.loadMoreFailed', { detail: search.moreError })}</span>
                <Button variant="secondary" size="sm" onClick={search.retry}>
                  {t('materials.retry')}
                </Button>
              </div>
            ) : !search.hasMore && search.items.length > MATERIAL_END_NOTE_MIN ? (
              <p className={styles.more}>{t('materials.endOfList', { count: displayedCount })}</p>
            ) : null}
          </>
        )}
      </>
    );
  }

  const gallery = (
    <div className={styles.root} data-testid="materials-view" hidden={!isActive}>
      {renderLayout ? null : (
        <header className={styles.headingRow}>
          <div>
            <h1 className="entry-section__title">{t('materials.title')}</h1>
            {inventory}
          </div>
          {controls}
        </header>
      )}
      {content}
      {isActive && openItem ? <MaterialDetailDialog item={openItem} onClose={closeDetail} /> : null}
    </div>
  );
  return renderLayout ? renderLayout({ inventory, controls, gallery }) : gallery;
}

/** Below one batch the end of the list is obvious; don't announce it. */
const MATERIAL_END_NOTE_MIN = 24;

/** In the app's locale, not the browser's, so the date matches the sentence around it. */
function formatIndexDate(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

interface CardProps {
  item: MaterialSummaryItem;
  onOpen: (item: MaterialSummaryItem, trigger: HTMLElement) => void;
}

const MaterialCard = memo(function MaterialCard({ item, onOpen }: CardProps) {
  const t = useT();
  const archetype = useMemo(() => getMaterialArchetype(item), [item]);
  const blurb = materialBlurb(item);
  const palette = item.palette.filter((color) => isSafeCssColor(color.value)).slice(0, 5);
  const host = isWebsiteMaterial(item) ? materialSourceHost(item.source) : null;
  const sourceUrl = safeMaterialSourceUrl(item.source);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = useCallback(async (key: string, text: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    }
  }, []);

  const handleCardClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-card-action]')) return;
    onOpen(item, event.currentTarget);
  };

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      if ((event.target as HTMLElement).closest('[data-card-action]')) return;
      event.preventDefault();
      onOpen(item, event.currentTarget);
    }
  };

  return (
    <li className={styles.cell}>
      <div
        role="button"
        tabIndex={0}
        className={`${styles.card} ${styles[`card_${archetype}`] || ''}`}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        aria-haspopup="dialog"
        data-testid="material-card"
        data-material-id={item.id}
        data-archetype={archetype}
      >
        <MaterialCover item={item} />
        <span className={styles.cardBody}>
          <div className={styles.cardHeaderRow}>
            {item.section ? (
              <span className={styles.sectionPill}>{item.section}</span>
            ) : item.category ? (
              <span className={styles.categoryPill}>{item.category}</span>
            ) : null}
            {archetype === 'website' && item.useStatus ? (
              <span className={styles.readingStatusPill}>{item.useStatus}</span>
            ) : null}
            {archetype === 'component' && item.capabilities?.designTokens ? (
              <span className={styles.tokenPill} title="包含设计 Token 规范">Tokens</span>
            ) : null}
          </div>

          <div className={styles.cardTitleRow}>
            <span className={styles.cardTitle} dir="auto">{item.title}</span>
            {archetype === 'website' && sourceUrl ? (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.externalLinkBtn}
                data-card-action
                onClick={(e) => e.stopPropagation()}
                title={`在浏览器中打开 ${item.title}`}
                aria-label={`在浏览器中打开 ${item.title}`}
              >
                <Icon name="external-link" size={12} />
              </a>
            ) : null}
          </div>

          {blurb ? <span className={styles.cardBlurb} dir="auto">{blurb}</span> : null}

          {/* Archetype Custom Presentation */}
          {archetype === 'skill' ? (
            <div className={styles.terminalBlock} data-card-action>
              <code className={styles.terminalCode}>{formatSkillCommand(item)}</code>
              <button
                type="button"
                className={styles.terminalCopyBtn}
                onClick={(e) => handleCopy('cmd', formatSkillCommand(item), e)}
                title="复制执行命令"
                aria-label="复制执行命令"
              >
                <Icon name={copiedKey === 'cmd' ? 'check' : 'copy'} size={12} />
                <span>{copiedKey === 'cmd' ? '已复制' : '复制'}</span>
              </button>
            </div>
          ) : null}

          {archetype === 'style' ? (
            <div className={styles.styleFooterRow}>
              {palette.length > 0 ? (
                <div className={styles.swatchBar} aria-label="色彩方案">
                  {palette.map((color) => (
                    <span
                      key={`${color.name}-${color.value}`}
                      className={`${styles.swatchDot} ${styles.dot}`}
                      style={{ background: color.value }}
                      data-color={color.value}
                      title={`${color.name}: ${color.value}`}
                    />
                  ))}
                </div>
              ) : <div />}
              <button
                type="button"
                className={styles.promptActionBtn}
                data-card-action
                onClick={(e) => handleCopy('prompt', item.description || item.title, e)}
                title="复制设计理念灵感"
                aria-label="复制设计理念灵感"
              >
                <Icon name={copiedKey === 'prompt' ? 'check' : 'magic'} size={12} />
                <span>{copiedKey === 'prompt' ? '已复制' : '灵感理念'}</span>
              </button>
            </div>
          ) : null}

          {archetype === 'component' ? (
            <div className={styles.componentFooterRow}>
              <span className={styles.cardMetaText}>
                {[item.libraryName, item.collection].filter(Boolean).join(' · ')}
              </span>
              <button
                type="button"
                className={styles.previewActionBtn}
                data-card-action
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(item, e.currentTarget);
                }}
                title="预览组件"
                aria-label="预览组件"
              >
                <Icon name="eye" size={12} />
                <span>体验预览</span>
              </button>
            </div>
          ) : null}

          {archetype === 'website' && host ? (
            <div className={styles.websiteFooterRow}>
              <span className={styles.domainBadge}>
                <Icon name="globe" size={11} />
                <span>{host}</span>
              </span>
            </div>
          ) : null}

          {archetype !== 'style' && archetype !== 'component' && archetype !== 'skill' ? (
            <span className={styles.cardMeta}>
              <span className={styles.cardMetaText}>
                {[item.libraryName, materialKindLabel(item.kind, t), item.collection].filter(Boolean).join(' · ')}
              </span>
              {palette.length > 0 ? (
                <span className={styles.dots} aria-hidden>
                  {palette.map((color) => (
                    <span
                      key={`${color.name}-${color.value}`}
                      className={styles.dot}
                      style={{ background: color.value }}
                      data-color={color.value}
                    />
                  ))}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
});

