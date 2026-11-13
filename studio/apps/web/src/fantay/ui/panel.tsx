'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/panel.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9 (Panel + resize L36-115, PanelHeader L119-130, PanelBody L132-140, PanelClose L239-258)
 *   source: src/components/ui/collapsible.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9 (Section disclosure)
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: docked surface, logical resize
 *   edge (physical side derived from dir), localized labels, collapsible Section, the one focus
 *   ring, Fantay tokens.
 */
import * as React from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { cva } from 'class-variance-authority';

import { useT } from '../../i18n';
import { cn } from './cn';
import { IconButton } from './icon-button';
import { ChevronRightIcon, XIcon } from './icons';

export type PanelSurface = 'floating' | 'inline' | 'docked';

/* Side rails: floating over a board on wide screens, filling a Sheet inline, or docked in a
   layout column. The shape is a prop, so the variants live in one place. */
export const panelVariants = cva('flex min-w-0 flex-col overflow-hidden bg-surface font-ui text-body text-ink', {
  variants: {
    surface: {
      floating: 'pointer-events-auto absolute z-[35] rounded-panel shadow-float',
      inline: 'h-full w-full rounded-none shadow-none',
      docked: 'relative h-full rounded-none shadow-none',
    },
  },
  defaultVariants: { surface: 'floating' },
});

export interface PanelResize {
  /** Default t('fantay.ui.resizePanel'). */
  label?: string;
  /** The logical edge that carries the handle; the physical side follows `dir`. */
  edge: 'start' | 'end';
  width: number;
  min: number;
  max: number;
  onResize(width: number): void;
}

export interface PanelProps extends React.ComponentPropsWithoutRef<'div'> {
  surface?: PanelSurface;
  /** A keyboard- and pointer-resizable edge (ignored for `inline`). */
  resize?: PanelResize;
}

function isRtl(element: Element): boolean {
  return element.closest('[dir]')?.getAttribute('dir') === 'rtl';
}

export const Panel = React.forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { className, surface = 'floating', resize, style, children, ...props },
  ref,
) {
  const t = useT();
  const drag = React.useRef<{ x: number; width: number; sign: 1 | -1 } | null>(null);
  /* marks the panel while its edge is dragged, so neighbours can pause their transitions */
  const [dragging, setDragging] = React.useState(false);
  const resizing = surface !== 'inline' ? resize : undefined;

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };
  const setWidth = (width: number) => {
    if (!resizing) return;
    resizing.onResize(Math.round(Math.max(resizing.min, Math.min(resizing.max, width))));
  };
  /* +1 when the handle sits on the physical right side (dragging right grows the panel). */
  const physicalSign = (element: Element): 1 | -1 => {
    const onRight = (resizing?.edge === 'end') !== isRtl(element);
    return onRight ? 1 : -1;
  };

  return (
    <div
      ref={ref}
      data-slot="panel"
      data-surface={surface}
      data-panel-resizing={dragging ? '' : undefined}
      className={cn(panelVariants({ surface }), className)}
      style={resizing ? { ...style, width: resizing.width } : style}
      {...props}
    >
      {children}
      {resizing ? (
        <div
          role="separator"
          tabIndex={0}
          data-slot="panel-resize"
          aria-label={resizing.label ?? t('fantay.ui.resizePanel')}
          aria-orientation="vertical"
          aria-valuemin={resizing.min}
          aria-valuemax={resizing.max}
          aria-valuenow={resizing.width}
          className={cn(
            'absolute inset-y-2 z-10 w-1.5 cursor-col-resize touch-none rounded-full focus-visible:bg-ink/20 focus-ring',
            resizing.edge === 'end' ? 'end-0' : 'start-0',
          )}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            drag.current = { x: event.clientX, width: resizing.width, sign: physicalSign(event.currentTarget) };
            setDragging(true);
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start) return;
            event.stopPropagation();
            setWidth(start.width + (event.clientX - start.x) * start.sign);
          }}
          onPointerUp={(event) => {
            endDrag();
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onLostPointerCapture={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={(event) => {
            const sign = physicalSign(event.currentTarget);
            let width: number;
            if (event.key === 'ArrowLeft') width = resizing.width - 10 * sign;
            else if (event.key === 'ArrowRight') width = resizing.width + 10 * sign;
            else if (event.key === 'Home') width = resizing.min;
            else if (event.key === 'End') width = resizing.max;
            else return;
            event.preventDefault();
            event.stopPropagation();
            setWidth(width);
          }}
        />
      ) : null}
    </div>
  );
});

/** Sticky header: a title or tabs at the start, actions at the end. */
export function PanelHeader({ className, ...props }: React.ComponentPropsWithoutRef<'header'>) {
  return (
    <header
      data-slot="panel-header"
      className={cn(
        'sticky top-0 z-[2] flex h-[42px] shrink-0 items-center justify-between gap-2 border-0 border-b border-solid border-line-soft bg-surface pe-2.5 ps-3.5 text-body font-medium text-ink',
        className,
      )}
      {...props}
    />
  );
}

export function PanelBody({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="panel-body" className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)} {...props} />;
}

export interface PanelCloseProps extends Omit<React.ComponentPropsWithoutRef<'button'>, 'aria-label' | 'children'> {
  /** Default t('fantay.ui.close'). */
  label?: string;
}

/** The small × that closes a rail. */
export const PanelClose = React.forwardRef<HTMLButtonElement, PanelCloseProps>(function PanelClose(
  { label, className, ...props },
  ref,
) {
  const t = useT();
  return (
    <IconButton
      ref={ref}
      size="sm"
      variant="quiet"
      aria-label={label ?? t('fantay.ui.close')}
      tooltipSide="bottom"
      className={cn('shrink-0', className)}
      {...props}
    >
      <XIcon />
    </IconButton>
  );
});

export interface SectionProps extends Omit<React.ComponentPropsWithoutRef<'section'>, 'title'> {
  title: React.ReactNode;
  actions?: React.ReactNode;
  /** A chevron toggle (labelled Expand/Collapse) folds the body. */
  collapsible?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
}

const sectionClass = 'border-0 border-b border-solid border-line-soft px-3 pb-2.5 pt-[7px] font-ui';
const sectionHeaderClass = 'flex h-7 items-center justify-between gap-2 text-label text-ink-soft';

/** A captioned group inside a panel, optionally collapsible. */
export function Section({
  title,
  actions,
  collapsible = false,
  open,
  defaultOpen = true,
  onOpenChange,
  className,
  children,
  ...props
}: SectionProps) {
  const t = useT();
  const titleId = React.useId();
  const [innerOpen, setInnerOpen] = React.useState(defaultOpen);
  const isOpen = open ?? innerOpen;

  const actionsNode = actions ? <div className="flex flex-none items-center gap-1">{actions}</div> : null;

  if (!collapsible) {
    return (
      <section data-slot="section" aria-labelledby={titleId} className={cn(sectionClass, className)} {...props}>
        <div data-slot="section-header" className={sectionHeaderClass}>
          <span id={titleId} className="min-w-0 truncate">
            {title}
          </span>
          {actionsNode}
        </div>
        {children}
      </section>
    );
  }

  return (
    <CollapsiblePrimitive.Root
      asChild
      open={isOpen}
      onOpenChange={(next) => {
        if (open === undefined) setInnerOpen(next);
        onOpenChange?.(next);
      }}
    >
      <section data-slot="section" aria-labelledby={titleId} className={cn(sectionClass, className)} {...props}>
        <div data-slot="section-header" className={sectionHeaderClass}>
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <CollapsiblePrimitive.Trigger asChild>
              <IconButton
                size="xs"
                aria-label={isOpen ? t('fantay.ui.collapse') : t('fantay.ui.expand')}
                aria-describedby={titleId}
                className="group/section-toggle -ms-1"
              >
                <ChevronRightIcon
                  size="xs"
                  className="transition-transform duration-fast ease-out-quint motion-reduce:transition-none rtl:rotate-180 group-data-[state=open]/section-toggle:rotate-90!"
                />
              </IconButton>
            </CollapsiblePrimitive.Trigger>
            <span id={titleId} className="min-w-0 truncate">
              {title}
            </span>
          </div>
          {actionsNode}
        </div>
        <CollapsiblePrimitive.Content data-slot="section-content">{children}</CollapsiblePrimitive.Content>
      </section>
    </CollapsiblePrimitive.Root>
  );
}
