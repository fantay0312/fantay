// SPDX-License-Identifier: AGPL-3.0-only
// A captioned, collapsible sidebar group (spec 02 §11.3). The body stays mounted and folds with the
// grid-rows 0fr → 1fr pattern (AGENTS.md "UI animation philosophy"), inert while folded. A reveal request
// (07 `sidebar.focus`) scrolls the group into view, flashes its caption and focuses its first row. A section
// with `onDropProject` takes a project row dragged onto it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Folder, FolderOpen, Plus, SquarePen } from 'lucide-react';

import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import type { FantaySidebarSectionId } from '../sidebar-store';
import { DashNavItem, DashSectionLabel } from './dash';

const REVEAL_FLASH_MS = 1_200;

/** The drag payload of a project row: its id. */
export const SIDEBAR_PROJECT_DRAG_TYPE = 'application/x-fantay-project';

export interface SidebarSectionProps {
  id: FantaySidebarSectionId;
  label: string;
  /** A folder row instead of a caption: the icon opens and closes with the section, so it needs no chevron. */
  folder?: boolean;
  collapsed: boolean;
  onToggle(): void;
  /** Trailing add button (testid `fantay-sidebar-section-add-{id}`). */
  add?: { label: string; onClick(): void; disabled?: boolean };
  /** More trailing controls, before the add button; show them on hover with `SECTION_ACTION_CLASS`. */
  actions?: ReactNode;
  onDropProject?(projectId: string): void;
  /** Changes once per reveal request for this section (null = none pending). */
  revealNonce?: number | null;
  /** Called once a reveal request has been acted on, so a later remount does not replay it. */
  onRevealed?(nonce: number): void;
  children: ReactNode;
}

/** Trailing caption controls appear with the pointer or focus, and stay while their menu is open. */
export const SECTION_ACTION_CLASS =
  'mt-2 opacity-0 transition-opacity duration-enter ease-out-quint group-hover/section:opacity-100 focus-visible:opacity-100 focus-visible:-outline-offset-2 group-focus-within/section:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none';

/** The folder row's controls: over its end, with the row's own fill, on hover or focus and while their menu is open. */
const FOLDER_ACTIONS_CLASS =
  'absolute inset-y-0 end-1 my-auto flex h-fit items-center rounded-row bg-paper-deep pointer-events-none opacity-0 transition-opacity duration-micro group-hover/section:pointer-events-auto group-hover/section:opacity-100 group-focus-within/section:pointer-events-auto group-focus-within/section:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100';

function carriesProject(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(SIDEBAR_PROJECT_DRAG_TYPE);
}

export function SidebarSection({
  id,
  label,
  folder = false,
  collapsed,
  onToggle,
  add,
  actions,
  onDropProject,
  revealNonce,
  onRevealed,
  children,
}: SidebarSectionProps) {
  const bodyId = useId();
  const sectionRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const flashTimer = useRef<number | null>(null);
  const [flashing, setFlashing] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  const onRevealedRef = useRef(onRevealed);
  onRevealedRef.current = onRevealed;

  // `inert` is not in React 18's DOM typings; set it on the element (folded rows are neither focusable nor read).
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (collapsed) body.setAttribute('inert', '');
    else body.removeAttribute('inert');
  }, [collapsed]);

  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
  }, []);

  useEffect(() => {
    if (revealNonce == null) return;
    sectionRef.current?.scrollIntoView?.({ block: 'nearest' });
    setFlashing(true);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setFlashing(false);
    }, REVEAL_FLASH_MS);
    window.setTimeout(() => {
      const first = bodyRef.current?.querySelector<HTMLElement>('[data-sidebar-row]');
      first?.focus({ preventScroll: true });
    }, 0);
    onRevealedRef.current?.(revealNonce);
  }, [revealNonce]);

  const dropProps = onDropProject
    ? {
        onDragOver: (event: DragEvent<HTMLElement>) => {
          if (!carriesProject(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTarget(true);
        },
        onDragLeave: (event: DragEvent<HTMLElement>) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(false);
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          setDropTarget(false);
          const projectId = event.dataTransfer.getData(SIDEBAR_PROJECT_DRAG_TYPE);
          if (!projectId) return;
          event.preventDefault();
          onDropProject(projectId);
        },
      }
    : {};

  const addButton = add ? (
    <IconButton
      size={folder ? 'xs' : 'sm'}
      aria-label={add.label}
      tooltipSide="right"
      disabled={add.disabled}
      data-testid={`fantay-sidebar-section-add-${id}`}
      className={folder ? 'focus-visible:-outline-offset-2' : SECTION_ACTION_CLASS}
      onClick={add.onClick}
    >
      <Icon icon={folder ? SquarePen : Plus} size={14} />
    </IconButton>
  ) : null;

  return (
    <section
      ref={sectionRef}
      data-testid={`fantay-sidebar-section-${id}`}
      data-collapsed={collapsed ? '' : undefined}
      data-drop-target={dropTarget ? '' : undefined}
      className={cn('rounded-row transition-colors duration-micro', dropTarget && 'bg-brand-soft')}
      {...dropProps}
    >
      <div className={cn('group/section relative flex items-center', !folder && 'gap-1 pe-1')}>
        {folder ? (
          <DashNavItem
            icon={<Icon icon={collapsed ? Folder : FolderOpen} size={15} />}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            data-testid={`fantay-sidebar-section-toggle-${id}`}
            data-flash={flashing ? '' : undefined}
            onClick={onToggle}
            className={cn(
              'group-hover/section:bg-paper-deep group-hover/section:pe-14 group-focus-within/section:pe-14',
              flashing && 'bg-brand-soft text-ink',
            )}
          >
            {label}
          </DashNavItem>
        ) : (
          <DashSectionLabel
            expanded={!collapsed}
            aria-controls={bodyId}
            data-testid={`fantay-sidebar-section-toggle-${id}`}
            data-flash={flashing ? '' : undefined}
            onClick={onToggle}
            className={cn(flashing && 'bg-brand-soft text-ink')}
          >
            {label}
          </DashSectionLabel>
        )}
        {folder ? (
          <div className={FOLDER_ACTIONS_CLASS}>
            {actions}
            {addButton}
          </div>
        ) : (
          <>
            {actions}
            {addButton}
          </>
        )}
      </div>
      <div
        ref={bodyRef}
        id={bodyId}
        className={cn(
          'grid transition-[grid-template-rows,opacity] ease-out-quint motion-reduce:transition-none',
          collapsed ? 'grid-rows-[0fr] opacity-0 duration-exit' : 'grid-rows-[1fr] opacity-100 duration-enter',
        )}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  );
}
