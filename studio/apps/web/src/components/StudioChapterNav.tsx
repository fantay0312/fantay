// Navigation of the design system studio: one section menu, learned from Claude Design's
// "Overview · 1 of 9" picker. A single button names where the reader is; its popover lists every
// section of every chapter, filters as you type and jumps on Enter.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import styles from './StudioChapterNav.module.css';

export type StudioChapterId = 'overview' | 'foundations' | 'library' | 'guidelines' | 'files';

function indicatorItem(container: HTMLElement, id: string): HTMLElement | null {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-indicator-item]')).find((node) => node.dataset.indicatorItem === id) ?? null;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Places one indicator under the child marked `data-indicator-item={active}`. It slides only when the
 * active child changes: a first paint, a resize or a late font lands in place, because a slide there
 * would announce a change that nobody made.
 */
export function useSlidingIndicator(active: string): { containerRef: RefObject<HTMLDivElement>; indicatorStyle: CSSProperties } {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<CSSProperties>({ opacity: 0 });
  const activeRef = useRef(active);
  activeRef.current = active;
  const placedRef = useRef(active);

  const place = useCallback((slide: boolean) => {
    const container = containerRef.current;
    const item = container ? indicatorItem(container, activeRef.current) : null;
    placedRef.current = activeRef.current;
    if (!item) {
      setIndicatorStyle((previous) => previous.opacity === 0 ? previous : { ...previous, opacity: 0, transition: 'none' });
      return;
    }
    const transform = 'translateX(' + item.offsetLeft + 'px)';
    const width = item.offsetWidth;
    setIndicatorStyle((previous) => previous.transform === transform && previous.width === width && previous.opacity === 1
      ? previous
      : { transform, width, opacity: 1, transition: slide && previous.opacity === 1 ? undefined : 'none' });
  }, []);

  // No dependency list: a row that gains or loses chips keeps its box, so no observer would see it.
  useLayoutEffect(() => { place(placedRef.current !== active); });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let mounted = true;
    const settle = () => { if (mounted) place(false); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(settle);
    observer?.observe(container);
    const fonts = typeof document.fonts === 'undefined' ? null : document.fonts;
    fonts?.addEventListener('loadingdone', settle);
    void fonts?.ready.then(settle);
    return () => {
      mounted = false;
      observer?.disconnect();
      fonts?.removeEventListener('loadingdone', settle);
    };
  }, [place]);

  return { containerRef, indicatorStyle };
}

export type StudioNavIcon = 'overview' | 'colors' | 'typography' | 'spacing' | 'radius' | 'shadows' | 'motion' | 'layout' | 'measure' | 'sizing' | 'layers' | 'other'
  | 'components' | 'blocks' | 'patterns' | 'templates' | 'rules' | 'content' | 'assets' | 'accessibility' | 'implementation' | 'governance' | 'files';

export interface StudioNavItem {
  /** Unique across the menu: a section id, or `overview` / `files`. */
  id: string;
  chapter: StudioChapterId;
  section?: string;
  label: string;
  /** Extra words the search matches, such as the other language's label. */
  keywords?: string;
  icon: StudioNavIcon;
  count?: number;
  /** A section the system leaves undefined: listed in its place, dimmed, with this word after it. */
  empty?: string;
}

// 16px line icons in the spirit of Claude Design's set: one stroke weight, square caps rounded.
const ICON_PATHS: Record<StudioNavIcon, ReactNode> = {
  overview: <><path d="M8 4.2C6.6 3.2 4.6 2.8 2.5 3v9.3c2.1-.2 4.1.2 5.5 1.2 1.4-1 3.4-1.4 5.5-1.2V3c-2.1-.2-4.1.2-5.5 1.2Z" /><path d="M8 4.2v9.3" /></>,
  colors: <><path d="M8 2.5a5.5 5.5 0 1 0 0 11c.9 0 1.3-.6 1.1-1.3-.2-.9.2-1.6 1.1-1.6h1.4c1.3 0 2.4-1 2.4-2.4C14 4.9 11.3 2.5 8 2.5Z" /><circle cx="5.2" cy="7.4" r=".7" /><circle cx="7.4" cy="5" r=".7" /><circle cx="10.4" cy="5.6" r=".7" /></>,
  typography: <><path d="M2.5 6.5h5M5 6.5v6" /><path d="M8.5 3.5h5M11 3.5v9" /></>,
  spacing: <><path d="M2.5 8h11" /><path d="m4.5 6-2 2 2 2M11.5 6l2 2-2 2" /></>,
  radius: <><path d="M2.5 6V4.5a2 2 0 0 1 2-2H6M10 2.5h1.5a2 2 0 0 1 2 2V6M13.5 10v1.5a2 2 0 0 1-2 2H10M6 13.5H4.5a2 2 0 0 1-2-2V10" /></>,
  shadows: <><rect x="2.5" y="2.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5h1.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5v-1.5" /></>,
  motion: <><path d="M2.5 11.5c3.5 0 3-7 6.5-7 2 0 2.5 1.6 4.5 1.6" /><circle cx="13" cy="6.1" r=".9" /></>,
  layout: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M2.5 6.2h11M6.2 6.2v7.3" /></>,
  measure: <><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 0 0 0 11" /><path d="M5.5 3.2a5.5 5.5 0 0 0 0 9.6" /></>,
  // A square and a frame at another proportion, sharing a corner.
  sizing: <><rect x="2.5" y="7.5" width="6" height="6" rx="1" /><path d="M6 4.5V3.5a1 1 0 0 1 1-1h5.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-1" /></>,
  layers: <><path d="m8 2.5 5.5 3-5.5 3-5.5-3 5.5-3Z" /><path d="m2.5 8.5 5.5 3 5.5-3" /><path d="m2.5 11 5.5 3 5.5-3" /></>,
  other: <><circle cx="4" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12" cy="8" r=".9" /></>,
  components: <><path d="m8 2.2 5 2.9v5.8l-5 2.9-5-2.9V5.1l5-2.9Z" /><path d="m3 5.1 5 2.9 5-2.9M8 8v5.8" /></>,
  // Two components joined into one unit.
  blocks: <><rect x="2.5" y="2.5" width="11" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></>,
  patterns: <><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="2.25" /></>,
  templates: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M5 5.5h6M5 8h3.5M5 10.5h2.5" /></>,
  // A list with a check: rules to hold, then the review.
  rules: <><path d="M6.5 4h7M6.5 8h7M6.5 12h4.5" /><path d="m2.5 4 .9.9L5 3.3M2.5 8l.9.9L5 7.3" /><circle cx="3.6" cy="12" r=".7" /></>,
  content: <><path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h4.5" /></>,
  assets: <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><circle cx="6" cy="6.2" r="1.1" /><path d="m2.8 12 3.6-3.4 2.4 2.2 1.8-1.6 2.8 2.6" /></>,
  accessibility: <><circle cx="8" cy="3.4" r="1" /><path d="M3 5.6c1.6.5 3.3.7 5 .7s3.4-.2 5-.7M8 6.3v3.2M8 9.5l-2.2 4M8 9.5l2.2 4" /></>,
  implementation: <><path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3M9 3.5l-2 9" /></>,
  governance: <><path d="M8 2.5 13 4.5v3.2c0 2.9-2.1 5.1-5 5.8-2.9-.7-5-2.9-5-5.8V4.5l5-2Z" /><path d="m5.8 8 1.5 1.5 3-3" /></>,
  files: <><path d="M2.5 4.5a1.5 1.5 0 0 1 1.5-1.5h2.6l1.5 1.6H12a1.5 1.5 0 0 1 1.5 1.5v5.4A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5v-7Z" /></>,
};

export function StudioNavGlyph({ name }: { name: StudioNavIcon }) {
  return <svg className={styles.glyph} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{ICON_PATHS[name]}</svg>;
}

/** A small search glass for the menu's field. */
function SearchGlyph() {
  return <svg className={styles.glyph} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" /></svg>;
}

export interface StudioSectionMenuProps {
  /** One group per chapter, in reading order; a thin rule separates them. */
  groups: StudioNavItem[][];
  /** Shown last, below its own rule, with its count, as in Claude Design. */
  files?: StudioNavItem;
  current: string;
  label: string;
  searchLabel: string;
  emptyLabel: string;
  /** How the button states the reader's place, e.g. `3 of 12` or `3 / 12`. */
  position: (index: number, total: number) => string;
  onSelect: (item: StudioNavItem) => void;
}

/**
 * The popover stays mounted and only toggles `data-open`, so it can leave as it came. Focus moves to
 * the search field on open and back to the button on close; arrow keys walk the filtered list.
 */
export function StudioSectionMenu({ groups, files, current, label, searchLabel, emptyLabel, position, onSelect }: StudioSectionMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const idBase = useId();

  const all = groups.flat();
  const here = (files && files.id === current ? files : all.find((item) => item.id === current)) ?? all[0] ?? files;
  const index = here ? all.findIndex((item) => item.id === here.id) : -1;
  const needle = query.trim().toLowerCase();
  const matches = (item: StudioNavItem) => !needle || (item.label + ' ' + item.id + ' ' + (item.keywords ?? '')).toLowerCase().includes(needle);
  const shownGroups = groups.map((group) => group.filter(matches)).filter((group) => group.length > 0);
  const shownFiles = files && matches(files) ? files : null;
  const flat = [...shownGroups.flat(), ...(shownFiles ? [shownFiles] : [])];
  const active = flat[Math.min(cursor, flat.length - 1)] ?? null;

  // React 18 has no `inert` prop; set by hand so a closed popover takes neither focus nor clicks.
  useLayoutEffect(() => { popoverRef.current?.toggleAttribute('inert', !open); }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', outside, true); };
  }, [open]);

  useEffect(() => {
    if (!open || !active) return;
    const option = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-nav-item]') ?? []).find((node) => node.dataset.navItem === active.id);
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active?.id]);

  function show() {
    setQuery('');
    setCursor(Math.max(0, [...all, ...(files ? [files] : [])].findIndex((item) => item.id === here?.id)));
    setOpen(true);
  }
  function hide(refocus = true) {
    setOpen(false);
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  }
  function choose(item: StudioNavItem) {
    hide();
    onSelect(item);
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); return; }
    if (!flat.length) return;
    const last = flat.length - 1;
    const at = Math.min(cursor, last);
    const next = ({ ArrowDown: at === last ? 0 : at + 1, ArrowUp: at === 0 ? last : at - 1, Home: 0, End: last } as Record<string, number>)[event.key];
    if (next !== undefined && !(event.target === inputRef.current && (event.key === 'Home' || event.key === 'End'))) { event.preventDefault(); setCursor(next); return; }
    if (event.key === 'Enter' && active) { event.preventDefault(); choose(active); }
  }

  const listId = idBase + '-list';
  const optionId = (item: StudioNavItem) => idBase + '-option-' + item.id;
  const option = (item: StudioNavItem) => <button
    key={item.id}
    id={optionId(item)}
    type="button"
    role="option"
    tabIndex={-1}
    className={styles.option}
    aria-selected={active?.id === item.id}
    aria-current={here?.id === item.id ? 'location' : undefined}
    data-nav-item={item.id}
    data-empty={item.empty ? '' : undefined}
    onPointerMove={() => { const at = flat.indexOf(item); if (at >= 0 && at !== cursor) setCursor(at); }}
    onClick={() => choose(item)}
  >
    <StudioNavGlyph name={item.icon} />
    <span className={styles.optionLabel}>{item.label}</span>
    {item.count !== undefined ? <span className={styles.count}>{item.count}</span> : item.empty ? <span className={styles.count}>{item.empty}</span> : null}
  </button>;

  return <div ref={rootRef} className={styles.menu} onKeyDown={open ? keyboard : undefined}>
    <button
      ref={buttonRef}
      type="button"
      className={styles.trigger}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listId}
      aria-label={here ? label + ': ' + here.label : label}
      data-open={open || undefined}
      onClick={() => (open ? hide() : show())}
      onKeyDown={(event) => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); show(); } }}
    >
      {here && <StudioNavGlyph name={here.icon} />}
      <span className={styles.triggerLabel}>{here?.label}</span>
      {here && (index >= 0 ? <span className={styles.position}>{position(index, all.length)}</span> : here.count !== undefined ? <span className={styles.position}>{here.count}</span> : null)}
      <svg className={styles.caret} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></svg>
    </button>
    <div ref={popoverRef} className={styles.popover} data-open={open || undefined} aria-hidden={!open}>
      <label className={styles.search}>
        <SearchGlyph />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active) : undefined}
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
        />
      </label>
      <div ref={listRef} id={listId} role="listbox" aria-label={label} className={styles.list}>
        {shownGroups.map((group, at) => <div key={group[0]!.id} role="group" className={styles.group} data-rule={at > 0 || undefined}>{group.map(option)}</div>)}
        {shownFiles && <div role="group" className={styles.group} data-rule={shownGroups.length > 0 || undefined}>{option(shownFiles)}</div>}
        {!flat.length && <p className={styles.empty}>{emptyLabel}</p>}
      </div>
    </div>
  </div>;
}

/**
 * The sticky bar every chapter opens with: the section menu on the left, the chapter's own switches
 * on the right. It sits on the canvas, above the white sheet that holds the chapter.
 */
export function StudioNavBar({ label, menu, children }: { label: string; menu: ReactNode; children?: ReactNode }) {
  return <nav className={styles.bar} aria-label={label}>
    <div className={styles.barInner}>
      {menu}
      {children ? <div className={styles.barTools}>{children}</div> : null}
    </div>
  </nav>;
}

/** Scrolls the reader back to the top of the page, gently unless motion is reduced. */
export function scrollStudioTop(scroller: HTMLElement | null) {
  scroller?.scrollTo?.({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}
