'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/icons.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9 (wrapper, L123-158)
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: Lucide stroke 1.5, a
 *   five-step size table, `label` → role="img", only the glyphs the primitives need.
 */
import * as React from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  Info,
  LoaderCircle,
  Minus,
  Monitor,
  Moon,
  Plus,
  Search,
  Sun,
  TriangleAlert,
  X,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

/** The stroke every chrome glyph is drawn at, in the icon's 24-unit grid (D1). */
export const ICON_STROKE = 1.5;

/** Glyph sizes by role: 14 beside a 12.5px label or inside a 28px control, 16 inside a 32px
 *  control, 18 inside a 40px control. One table, so a screen cannot mix them by accident. */
export const ICON_SIZE = { xs: 12, sm: 14, md: 16, lg: 18, xl: 20 } as const;

export type IconSize = keyof typeof ICON_SIZE | number;

export interface IconProps extends Omit<LucideProps, 'size' | 'ref'> {
  icon: LucideIcon;
  /** Default 'md'. An explicit size is also written inline, so a parent's `[&_svg]:size-*`
   *  rule cannot override it; without one the parent's rule wins (attributes only). */
  size?: IconSize;
  /** Present → role="img" + aria-label; absent → aria-hidden (decorative). */
  label?: string;
}

function px(size: IconSize): number {
  return typeof size === 'number' ? size : ICON_SIZE[size];
}

export function Icon({ icon: Glyph, size, label, style, strokeWidth, ...props }: IconProps) {
  const side = px(size ?? 'md');
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <Glyph
      width={side}
      height={side}
      strokeWidth={strokeWidth ?? ICON_STROKE}
      {...a11y}
      {...props}
      style={size === undefined ? style : { width: side, height: side, ...style }}
    />
  );
}

/** Binds a Lucide glyph to `Icon`, so call sites write `<XIcon size="sm" />`. */
export function icon(glyph: LucideIcon): (props: Omit<IconProps, 'icon'>) => React.JSX.Element {
  function GlyphIcon(props: Omit<IconProps, 'icon'>) {
    return <Icon icon={glyph} {...props} />;
  }
  GlyphIcon.displayName = `${glyph.displayName ?? 'Glyph'}Icon`;
  return GlyphIcon;
}

export const XIcon = icon(X);
export const CheckIcon = icon(Check);
export const MinusIcon = icon(Minus);
export const PlusIcon = icon(Plus);
export const ChevronDownIcon = icon(ChevronDown);
export const ChevronUpIcon = icon(ChevronUp);
export const ChevronRightIcon = icon(ChevronRight);
export const SearchIcon = icon(Search);
export const MoreHorizontalIcon = icon(Ellipsis);
export const SunIcon = icon(Sun);
export const MoonIcon = icon(Moon);
export const MonitorIcon = icon(Monitor);
export const InfoIcon = icon(Info);
export const AlertTriangleIcon = icon(TriangleAlert);
export const LoaderIcon = icon(LoaderCircle);
