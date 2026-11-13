'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/empty-state.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   source: src/components/ui/card.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9 (default/dashed hero card shell)
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: card shell inlined, semibold
 *   instead of extrabold, optional description, Fantay tokens and type scale.
 */
import * as React from 'react';

import { cn } from './cn';

/* What a page shows before it has anything: a title, a line of why, and the one action that
   changes that. `card` is the hero card on an empty list; `dashed` the centred placeholder on a
   page whose content is a table or a board. */
const VARIANTS = {
  card: {
    card: 'max-w-[560px] rounded-modal bg-surface px-5 pb-6 pt-5 shadow-elevation-1 corner-squircle sm:px-7 sm:pb-7 sm:pt-[26px]',
    illustration: 'mb-2.5 flex items-center gap-2.5',
    title: 'text-heading font-semibold tracking-[-0.02em] text-ink',
    description: 'mb-[18px] mt-2.5 text-copy leading-[1.6] text-ink-soft',
    action: '',
  },
  dashed: {
    card: 'flex flex-col items-center gap-2.5 rounded-modal border-[1.5px] border-dashed border-line bg-transparent px-6 py-[34px] text-center',
    // Full width and centred: a mark stays in the middle, and a demo gets a real width (items-center would shrink it to 0).
    illustration: 'mb-2.5 flex w-full items-center justify-center gap-2.5',
    title: 'text-heading font-semibold tracking-[-0.015em] text-ink',
    description: 'max-w-[420px] text-copy leading-[1.5] text-ink-soft',
    action: 'mt-2.5',
  },
} as const;

export type EmptyStateVariant = keyof typeof VARIANTS;

export interface EmptyStateProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'title'> {
  variant?: EmptyStateVariant;
  /** Marks or tiles above the title, laid out in a row. */
  illustration?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The one button. */
  action?: React.ReactNode;
}

export function EmptyState({
  variant = 'card',
  illustration,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  const v = VARIANTS[variant];
  return (
    <div data-slot="empty-state" data-variant={variant} className={cn('min-w-0 font-ui', v.card, className)} {...props}>
      {illustration ? <div className={v.illustration}>{illustration}</div> : null}
      <h3 className={cn('m-0', v.title)}>{title}</h3>
      {description ? <p className={cn('m-0', v.description)}>{description}</p> : null}
      {action ? <div className={v.action}>{action}</div> : null}
    </div>
  );
}
