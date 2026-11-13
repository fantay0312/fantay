'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/status-label.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: import paths, Fantay tokens.
 */
import * as React from 'react';

import { cn } from './cn';
import { Dot } from './dot';

export interface StatusLabelProps extends React.ComponentPropsWithoutRef<'span'> {
  /** `done`: the green dot and the softer ink; `muted`: the grey dot and faint ink. */
  tone?: 'done' | 'muted';
}

/** A dot and a caption saying whether something is live: "connected / not connected". */
export function StatusLabel({ tone = 'muted', className, children, ...props }: StatusLabelProps) {
  return (
    <span
      data-slot="status-label"
      data-tone={tone}
      className={cn(
        'inline-flex flex-none items-center gap-1.5 font-ui text-caption',
        tone === 'done' ? 'text-ink-soft' : 'text-ink-faint',
        className,
      )}
      {...props}
    >
      <Dot tone={tone} size="sm" />
      {children}
    </span>
  );
}
