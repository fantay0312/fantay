'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/toolbar.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: sm/md sizes (28/32),
 *   pressed state, required aria-label, key caps in ToolbarControl tooltips, toned dots,
 *   separator, Fantay tokens and the one focus ring.
 */
import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from './cn';
import { Tooltip } from './tooltip';

export type ToolbarOrientation = 'horizontal' | 'vertical';
export type ToolbarSize = 'sm' | 'md';

export interface ToolbarProps extends React.ComponentPropsWithoutRef<'div'> {
  'aria-label': string;
  /** vertical: the 40px column pinned to a canvas side */
  orientation?: ToolbarOrientation;
}

/* The floating island of quiet controls over a canvas: the tool rail, the board toolbar. */
export const Toolbar = React.forwardRef<HTMLDivElement, ToolbarProps>(function Toolbar(
  { orientation = 'horizontal', className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="toolbar"
      role="toolbar"
      aria-orientation={orientation}
      className={cn(
        'relative flex items-center gap-0.5 rounded-pill bg-[rgba(255,255,255,0.85)] dark:bg-surface/85 backdrop-blur-md p-[5px] border border-[var(--border-soft)] shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_12px_32px_rgba(28,27,26,0.12)]',
        orientation === 'vertical' && 'w-10 flex-col',
        className,
      )}
      {...props}
    />
  );
});

export const toolbarButtonVariants = cva(
  [
    'relative z-[1] grid place-items-center rounded-pill border-0 border-solid border-transparent bg-transparent p-0',
    'font-ui text-body font-semibold leading-tight text-ink-soft shadow-none transform-none cursor-pointer',
    'transition-[color,background-color,scale] duration-fast ease-out-quint motion-reduce:transition-none',
    'not-data-disabled:hover:bg-paper-deep not-data-disabled:hover:text-ink not-data-disabled:active:scale-95',
    'aria-pressed:text-ink focus-ring data-disabled:cursor-not-allowed data-disabled:opacity-45',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      size: {
        /* 28px: rails and compact chrome (default) */
        sm: 'size-7',
        /* 32px: the board's bottom toolbar */
        md: 'size-8',
      },
    },
    defaultVariants: { size: 'sm' },
  },
);

export interface ToolbarButtonProps extends React.ComponentPropsWithoutRef<'button'> {
  /** 28px (default) or 32px. */
  size?: ToolbarSize;
  /** Toggle state → aria-pressed (a ToolbarHighlight slides to the pressed button). */
  pressed?: boolean;
}

/** Forwards its ref so it can anchor a Radix popper (`DropdownMenuTrigger asChild`, Tooltip). */
export const ToolbarButton = React.forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(
  { className, size = 'sm', pressed, type, disabled, ...props },
  ref,
) {
  /* `data-disabled` follows the spread: a Radix trigger rendering this `asChild` passes
     `data-disabled: undefined`, which would otherwise erase the disabled look. */
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      data-slot="toolbar-button"
      data-size={size}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled}
      className={cn(toolbarButtonVariants({ size }), className)}
      {...props}
      data-disabled={disabled ? '' : undefined}
    />
  );
});

export interface ToolbarControlProps extends Omit<ToolbarButtonProps, 'aria-label'> {
  /** Both the tooltip and the accessible name. */
  label: string;
  /** e.g. `'v'` or `'mod+shift+k'` → key caps in the tooltip. */
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/** An icon-only toolbar button named by its tooltip. Children may include a ToolbarDot. */
export const ToolbarControl = React.forwardRef<HTMLButtonElement, ToolbarControlProps>(function ToolbarControl(
  { label, shortcut, side = 'top', ...props },
  ref,
) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={side}>
      {/* a disabled button swallows pointer events; the span keeps the tooltip alive */}
      <span data-slot="toolbar-control" className="inline-flex">
        <ToolbarButton ref={ref} aria-label={label} {...props} />
      </span>
    </Tooltip>
  );
});

export type ToolbarDotTone = 'brand' | 'success' | 'danger' | 'warning';

const DOT_TONES: Record<ToolbarDotTone, string> = {
  brand: 'bg-brand',
  success: 'bg-success',
  danger: 'bg-accent-ink',
  warning: 'bg-warning',
};

/** The small live dot on a toolbar button's corner: an agent at work, a failed run. */
export function ToolbarDot({ tone, className }: { tone: ToolbarDotTone; className?: string }) {
  return (
    <span
      aria-hidden
      data-slot="toolbar-dot"
      data-tone={tone}
      className={cn(
        'pointer-events-none absolute -top-px -end-px size-2 rounded-full border-[1.5px] border-solid border-surface',
        DOT_TONES[tone],
        className,
      )}
    />
  );
}

/**
 * The fill behind the pressed button, one element that slides and resizes to the next press
 * instead of each button lighting up on its own. It measures `[aria-pressed="true"]` in its
 * toolbar whenever `activeKey` changes and whenever the toolbar re-lays out. The first
 * measurement is applied without a transition, so it never slides in from the corner.
 * Positioned with physical `left-0`: the measurement (`offsetLeft`) is physical in RTL too.
 */
/* layout effect in the browser (measure before paint), plain effect on the server (no warning) */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

export function ToolbarHighlight({ activeKey, className }: { activeKey: string; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [armed, setArmed] = React.useState(false);

  useIsomorphicLayoutEffect(() => {
    const pill = ref.current;
    const bar = pill?.parentElement;
    if (!pill || !bar) return;
    const place = () => {
      const active = bar.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!active) {
        pill.style.opacity = '0';
        return;
      }
      pill.style.opacity = '1';
      pill.style.translate = `${active.offsetLeft}px ${active.offsetTop}px`;
      pill.style.width = `${active.offsetWidth}px`;
      pill.style.height = `${active.offsetHeight}px`;
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [activeKey]);

  /* arm the transition one frame after the first placement */
  React.useEffect(() => {
    if (typeof requestAnimationFrame === 'undefined') {
      setArmed(true);
      return;
    }
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden
      data-slot="toolbar-highlight"
      className={cn(
        'pointer-events-none absolute left-0 top-0 rounded-pill bg-paper-deep opacity-0',
        armed && 'transition-[translate,width,height,opacity] duration-enter ease-out-quint motion-reduce:transition-none',
        className,
      )}
    />
  );
}

export interface ToolbarSeparatorProps extends React.ComponentPropsWithoutRef<'div'> {
  /** The toolbar's orientation (the rule runs across it). */
  orientation?: ToolbarOrientation;
}

export function ToolbarSeparator({ orientation = 'horizontal', className, ...props }: ToolbarSeparatorProps) {
  return (
    <div
      role="separator"
      data-slot="toolbar-separator"
      aria-orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'}
      className={cn(
        'flex-none bg-line-soft',
        orientation === 'horizontal' ? 'mx-1 h-[18px] w-px' : 'my-1 h-px w-[18px]',
        className,
      )}
      {...props}
    />
  );
}
