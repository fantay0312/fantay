'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — 网格 (Resurf masonry with marquee selection) and 信息流 (time-grouped feed).
 * Feed grouping follows the original desk's 信息流 (dsh-media-desk client/canvas.jsx Feed, MIT,
 * Copyright (c) 2026 woniuniuniu), regrouped by day like a timeline.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import type { WorkbenchItem, WorkbenchSpace } from '@open-design/contracts';
import { useWorkbenchLang } from '../lang';
import { fmtTime } from '../shared/format';
import { useActions } from './context';
import { ItemCard, estimateCardHeight } from './ItemCard';
import { DENSITY_COLUMN, timeGroup, type Density } from './library';
import styles from './Views.module.css';

interface ViewProps {
  items: WorkbenchItem[];
  selection: ReadonlySet<string>;
  spaces: Map<string, WorkbenchSpace>;
  /** Hide the space dot (inside that space's own view). */
  hideSpace: boolean;
  /** Related-ideas highlight (search by meaning / gathering). */
  related?: ReadonlySet<string>;
  /** Rows above the cards, inside the scroller (resurface strip, inbox hints). */
  header?: ReactNode;
  /** Cards accept HTML drags toward the rail (not in Trash). */
  draggable: boolean;
}

function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.round(entry.contentRect.width)); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

interface Box { x: number; y: number; w: number; h: number }

export function GridView({ items, selection, spaces, hideSpace, related, header, draggable, density }: ViewProps & { density: Density }) {
  const actions = useActions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [innerRef, width] = useWidth<HTMLDivElement>();
  const [box, setBox] = useState<Box | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const gap = density === 's' ? 12 : density === 'm' ? 16 : 20;
  const minCol = DENSITY_COLUMN[density];
  const cols = Math.max(1, Math.floor((width + gap) / (minCol + gap)));
  const colWidth = width ? (width - gap * (cols - 1)) / cols : minCol;

  const columns = useMemo(() => {
    const heights = new Array<number>(cols).fill(0);
    const out: WorkbenchItem[][] = Array.from({ length: cols }, () => []);
    for (const item of items) {
      let target = 0;
      for (let i = 1; i < cols; i += 1) if (heights[i]! < heights[target]! - 24) target = i;
      out[target]!.push(item);
      heights[target]! += estimateCardHeight(item, colWidth) + gap;
    }
    return out;
  }, [items, cols, colWidth, gap]);

  const order = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-card],button,a,input,textarea,select,[role="menu"],[data-no-marquee]')) return;
    const el = scrollRef.current;
    if (!el) return;
    event.preventDefault();
    const frame = el.getBoundingClientRect();
    const toContent = (cx: number, cy: number) => ({ x: cx - frame.left + el.scrollLeft, y: cy - frame.top + el.scrollTop });
    const start = toContent(event.clientX, event.clientY);
    const additive = event.metaKey || event.ctrlKey || event.shiftKey;
    const base = additive ? new Set(selectionRef.current) : new Set<string>();
    const cards = [...el.querySelectorAll<HTMLElement>('[data-card]')].map((node) => {
      const r = node.getBoundingClientRect();
      const topLeft = toContent(r.left, r.top);
      return { id: node.dataset.card!, left: topLeft.x, top: topLeft.y, right: topLeft.x + r.width, bottom: topLeft.y + r.height };
    });
    let pointer = { x: event.clientX, y: event.clientY };
    let moved = false;
    let raf = 0;
    let lastKey = '';
    const update = () => {
      const cur = toContent(pointer.x, pointer.y);
      const next = { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) };
      setBox(next);
      const hits = cards.filter(c => c.right > next.x && c.left < next.x + next.w && c.bottom > next.y && c.top < next.y + next.h).map(c => c.id);
      const ids = [...new Set([...base, ...hits])];
      const key = ids.join('|');
      if (key !== lastKey) {
        lastKey = key;
        actions.setSelection(ids, hits[0] ?? null);
      }
    };
    const loop = () => {
      const edge = 44;
      let dy = 0;
      if (pointer.y < frame.top + edge) dy = -Math.ceil((frame.top + edge - pointer.y) / 3);
      else if (pointer.y > frame.bottom - edge) dy = Math.ceil((pointer.y - (frame.bottom - edge)) / 3);
      if (dy) {
        el.scrollTop += dy;
        update();
      }
      raf = requestAnimationFrame(loop);
    };
    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (!moved && Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < 4) return;
      if (!moved) {
        moved = true;
        raf = requestAnimationFrame(loop);
      }
      update();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      cancelAnimationFrame(raf);
      setBox(null);
      if (!moved && !additive) actions.clearSelection();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div ref={scrollRef} className={styles.scroll} onPointerDown={onPointerDown} data-view="grid">
      {header}
      <div ref={innerRef} className={styles.masonry} style={{ gap } as CSSProperties}>
        {width ? columns.map((column, ci) => (
          <div key={ci} className={styles.column} style={{ gap } as CSSProperties}>
            {column.map((item) => {
              const index = order.get(item.id) ?? 0;
              return (
                <div key={item.id} className={styles.cell} style={{ animationDelay: `${Math.min(index * 18, 360)}ms` } as CSSProperties}>
                  <ItemCard
                    item={item}
                    selected={selection.has(item.id)}
                    space={hideSpace ? null : spaces.get(item.spaceId ?? '') ?? null}
                    draggable={draggable}
                    related={related?.has(item.id) ?? false}
                  />
                </div>
              );
            })}
          </div>
        )) : null}
      </div>
      {box ? <div className={styles.marquee} style={{ left: box.x, top: box.y, width: box.w, height: box.h }} aria-hidden /> : null}
    </div>
  );
}

export function FeedView({ items, selection, spaces, hideSpace, related, header, draggable }: ViewProps) {
  const lang = useWorkbenchLang();
  const actions = useActions();
  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; items: WorkbenchItem[] }> = [];
    for (const item of items) {
      const group = timeGroup(item.createdAt, lang);
      const last = out[out.length - 1];
      if (last && last.key === group.key) last.items.push(item);
      else out.push({ ...group, items: [item] });
    }
    return out;
  }, [items, lang]);

  return (
    <div
      className={styles.scroll}
      data-view="feed"
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.button === 0 && !target.closest('[data-card],button,a,input,textarea,[role="menu"]') && !(event.metaKey || event.ctrlKey || event.shiftKey)) actions.clearSelection();
      }}
    >
      {header}
      <div className={styles.feed}>
        {groups.map(group => (
          <section key={`${group.key}-${group.items[0]?.id}`} className={styles.feedGroup}>
            <h2 className={styles.feedHead}>
              <span>{group.label}</span>
              <span className={styles.feedCount}>{group.items.length}</span>
            </h2>
            <ol className={styles.feedList}>
              {group.items.map((item, index) => (
                <li key={item.id} className={styles.feedRow} style={{ animationDelay: `${Math.min(index * 30, 300)}ms` } as CSSProperties}>
                  <time className={styles.feedTime} dateTime={item.createdAt}>{fmtTime(item.createdAt)}</time>
                  <span className={styles.feedRail} aria-hidden />
                  <ItemCard
                    item={item}
                    variant="feed"
                    selected={selection.has(item.id)}
                    space={hideSpace ? null : spaces.get(item.spaceId ?? '') ?? null}
                    draggable={draggable}
                    related={related?.has(item.id) ?? false}
                  />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
