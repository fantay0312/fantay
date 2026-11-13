/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay surface markers (spec 01 §2.6, plan R13). `FX` turns on the scoped preflight
 * (`@scope (.fx) to (.fx-legacy, [data-fx-legacy])`); every Fantay surface root and every
 * portaled Radix part carries it. `FX_LEGACY` wraps embedded upstream UI so the preflight stops.
 * No client directive and no `cn` import: these render in server components too.
 */
import * as React from 'react';

export const FX = 'fx';
export const FX_LEGACY = 'fx-legacy';

type FxRootTag = 'div' | 'section' | 'aside' | 'main' | 'header' | 'nav' | 'footer';

export interface FxRootProps extends React.HTMLAttributes<HTMLElement> {
  as?: FxRootTag;
}

function joinClasses(...parts: Array<string | undefined>): string {
  return parts.filter((part) => part !== undefined && part !== '').join(' ');
}

/** The root of a Fantay surface: `className = fx + className`. */
export const FxRoot = React.forwardRef<HTMLElement, FxRootProps>(function FxRoot(
  { as = 'div', className, ...props },
  ref,
) {
  return React.createElement(as, { ref, className: joinClasses(FX, className), ...props });
});

/** Wraps an upstream component rendered inside a Fantay surface (B3): `display: contents`,
 *  so layout is unaffected, and both boundary markers so the scoped preflight stops here. */
export function FxLegacy({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-fx-legacy="" className={joinClasses(FX_LEGACY, 'contents', className)} {...props} />;
}
