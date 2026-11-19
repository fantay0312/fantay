// SPDX-License-Identifier: AGPL-3.0-only
// The strip under a grid that says which sheet (or which table) is showing: a spreadsheet's sheet
// tabs. Quiet: names in soft ink, the current one in ink on a tone. When the names do not fit, the
// strip scrolls sideways, fades at the edge it continues past, and a list button on the left opens
// every name at once. Shared by workbooks and databases.
'use client';

import { List, type LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  IconButton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '../../../ui';
import styles from './SheetTabs.module.css';

export interface SheetTab {
  id: string;
  label: string;
  /** A quiet fact after the name: a row count. */
  detail?: string;
  /** A glyph before the name, for a tab of another kind (a database view). */
  icon?: LucideIcon;
  /** What the glyph means, for the tab's tooltip and for screen readers. */
  iconLabel?: string;
}

export interface SheetTabsProps {
  tabs: readonly SheetTab[];
  value: string;
  onChange(id: string): void;
  /** Accessible name of the tab list ("Sheets"). */
  label: string;
  /** Accessible name of the button that lists every tab ("All sheets"). */
  listLabel: string;
}

export function SheetTabs({ tabs, value, onChange, label, listLabel }: SheetTabsProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ overflow: false, start: false, end: false });

  // Which edges the strip continues past, for the fades and the list button.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = (): void => {
      const overflow = element.scrollWidth > element.clientWidth + 1;
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges((previous) =>
        previous.overflow === overflow && previous.start === start && previous.end === end ? previous : { overflow, start, end },
      );
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [tabs]);

  // The current tab is always in view, whether it was chosen from the list or restored.
  useEffect(() => {
    const element = scrollRef.current;
    const tab = element?.querySelector<HTMLElement>('[data-state="active"]');
    if (!element || !tab) return;
    const left = tab.offsetLeft - 16;
    const right = tab.offsetLeft + tab.offsetWidth + 16;
    if (left < element.scrollLeft) element.scrollLeft = left;
    else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth;
  }, [value, tabs]);

  return (
    <div className={styles.strip} data-artifact-sheet-tabs="">
      {edges.overflow ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="xs" aria-label={listLabel} tooltipSide="top" className={styles.listButton}>
              <List aria-hidden="true" strokeWidth={1.75} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" width="md">
            <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
              {tabs.map((tab) => (
                <DropdownMenuRadioItem key={tab.id} value={tab.id}>
                  <span className={styles.menuName}>{tab.label}</span>
                  {tab.detail ? <span className={styles.menuDetail}>{tab.detail}</span> : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Tabs value={value} onValueChange={onChange} className={styles.tabs}>
        <div
          ref={scrollRef}
          className={styles.scroll}
          data-fade-start={edges.start || undefined}
          data-fade-end={edges.end || undefined}
        >
          <TabsList aria-label={label} className={styles.list}>
            {tabs.map((tab) => {
              const Glyph = tab.icon;
              return (
                <TabsTrigger key={tab.id} value={tab.id} className={styles.tab} title={tab.iconLabel ? `${tab.label} · ${tab.iconLabel}` : undefined}>
                  {Glyph ? <Glyph aria-label={tab.iconLabel} strokeWidth={1.75} /> : null}
                  <span>{tab.label}</span>
                  {tab.detail ? <span className={styles.detail}>{tab.detail}</span> : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
      </Tabs>
    </div>
  );
}
