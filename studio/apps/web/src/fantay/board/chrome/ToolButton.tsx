'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// A 32 px board toolbar button (amendment B4: `ToolbarButton size="md"`) named by its tooltip, with key caps; a
// disabled one keeps a tooltip with its reason (the span keeps pointer events for the tooltip, W1 gotcha). A
// pressed tool lets the toolbar's sliding highlight carry the fill instead of a hover fill of its own.
import { forwardRef, type ComponentPropsWithoutRef } from 'react';

import { Tooltip } from '../../ui/tooltip';
import { ToolbarButton, type ToolbarSize } from '../../ui/toolbar';
import styles from './chrome.module.css';

export interface ToolButtonProps extends ComponentPropsWithoutRef<'button'> {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabledReason?: string;
  size?: ToolbarSize;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

export const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(function ToolButton(
  { label, shortcut, pressed, disabledReason, disabled, size = 'md', side = 'top', children, className, ...props },
  ref,
) {
  const off = disabled === true || disabledReason !== undefined;
  const tooltip = off && disabledReason ? `${label} · ${disabledReason}` : label;
  return (
    <Tooltip label={tooltip} shortcut={off ? undefined : shortcut} side={side}>
      <span className={styles.toolSlot}>
        <ToolbarButton
          ref={ref}
          size={size}
          aria-label={label}
          pressed={pressed}
          disabled={off}
          className={pressed === undefined ? className : ['not-data-disabled:hover:bg-transparent', className].filter(Boolean).join(' ')}
          {...props}
        >
          {children}
        </ToolbarButton>
      </span>
    </Tooltip>
  );
});
