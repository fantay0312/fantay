import { forwardRef } from 'react';
import { Input } from '@open-design/components';
import { useT } from '../../i18n';
import { Icon } from '../Icon';
import {
  materialKindLabel,
  materialKindOptions,
  type PrimaryTabOption,
  type SectionOption,
} from './material-model';
import styles from './MaterialFilters.module.css';

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Show the `/` shortcut hint (only where the shortcut is wired). */
  shortcutHint?: boolean;
  testId?: string;
}

export const MaterialSearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function MaterialSearchField({ value, onChange, shortcutHint = false, testId }, ref) {
    const t = useT();
    return (
      // A div, not a label: dialogs carry the legacy `.modal label { flex-direction: column }`
      // rule, and the input is already named by aria-label.
      <div className={styles.searchField}>
        <span className={styles.searchIcon} aria-hidden>
          <Icon name="search" size={15} />
        </span>
        <Input
          ref={ref}
          type="search"
          className={styles.searchInput}
          value={value}
          placeholder={t('materials.searchPlaceholder')}
          aria-label={t('materials.searchLabel')}
          {...(shortcutHint ? { 'aria-keyshortcuts': '/' } : {})}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          data-testid={testId}
        />
        {shortcutHint && !value ? (
          <kbd className={styles.shortcut} aria-hidden>
            /
          </kbd>
        ) : null}
      </div>
    );
  },
);

export interface MaterialCategoryTabsProps {
  category: string;
  onChange: (category: string) => void;
  tabs: PrimaryTabOption[];
  testId?: string;
}

export function MaterialCategoryTabs({
  category,
  onChange,
  tabs,
  testId = 'materials-category-tabs',
}: MaterialCategoryTabsProps) {
  return (
    <div
      className={styles.categoryTabs}
      role="tablist"
      aria-label="素材业务分类"
      data-testid={testId}
    >
      {tabs.map((tab) => {
        const active = category === tab.category;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            className={`${styles.categoryTab} ${active ? styles.activeTab : ''}`}
            aria-selected={active}
            onClick={() => onChange(tab.category)}
            data-testid={`materials-tab-${tab.key}`}
          >
            <span>{tab.label}</span>
            <span className={styles.tabCount}>{tab.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface MaterialSectionCapsulesProps {
  section: string;
  onChange: (section: string) => void;
  sections: SectionOption[];
  totalCount?: number;
  testId?: string;
}

export function MaterialSectionCapsules({
  section,
  onChange,
  sections,
  totalCount,
  testId = 'materials-section-capsules',
}: MaterialSectionCapsulesProps) {
  return (
    <div
      className={styles.sectionCapsules}
      role="group"
      aria-label="二级细分筛选"
      data-testid={testId}
    >
      <button
        type="button"
        className={`${styles.capsule} ${section === '' ? styles.activeCapsule : ''}`}
        aria-pressed={section === ''}
        onClick={() => onChange('')}
        data-testid="materials-section-all"
      >
        <span>全部</span>
        {typeof totalCount === 'number' ? <span className={styles.capsuleCount}>{totalCount}</span> : null}
      </button>
      {sections.map((sec) => {
        const active = section === sec.name;
        return (
          <button
            key={sec.key}
            type="button"
            className={`${styles.capsule} ${active ? styles.activeCapsule : ''}`}
            aria-pressed={active}
            onClick={() => onChange(active ? '' : sec.name)}
            data-testid={`materials-section-${sec.key}`}
          >
            <span>{sec.name}</span>
            <span className={styles.capsuleCount}>{sec.count}</span>
          </button>
        );
      })}
    </div>
  );
}

interface KindFilterProps {
  value: string;
  onChange: (kind: string) => void;
  /** `summary.kinds`; null until the summary loads (then every known kind shows). */
  counts: Record<string, number> | null;
  /** Total record count for the "All" segment. */
  total?: number | null;
  testId?: string;
}

export function MaterialKindFilter({ value, onChange, counts, total, testId }: KindFilterProps) {
  const t = useT();
  const rawKinds = materialKindOptions(counts, value);
  const kinds = rawKinds.filter((k) => k !== 'html' && k !== 'markdown' && k !== 'file');
  return (
    <div
      className={styles.segmented}
      role="group"
      aria-label={t('materials.kindLabel')}
      data-testid={testId}
    >
      <button
        type="button"
        className={styles.segment}
        aria-pressed={value === ''}
        onClick={() => onChange('')}
        data-kind=""
      >
        {t('materials.filterAll')}
        {typeof total === 'number' ? <> <span className={styles.segmentCount}>{total}</span></> : null}
      </button>
      {kinds.map((kind) => (
        <button
          key={kind}
          type="button"
          className={styles.segment}
          aria-pressed={value === kind}
          onClick={() => onChange(value === kind ? '' : kind)}
          data-kind={kind}
        >
          {materialKindLabel(kind, t)}
          {counts && typeof counts[kind] === 'number' ? (
            <> <span className={styles.segmentCount}>{counts[kind]}</span></>
          ) : null}
        </button>
      ))}
    </div>
  );
}

