'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/avatar.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: CJK initials, no sub-12px
 *   labels for CJK, an `icon` prop instead of the agent mark, one collar recipe for both themes,
 *   logical stacking, localized overflow label, Fantay tokens.
 */
import * as React from 'react';

import { useT } from '../../i18n';
import { cn } from './cn';

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

/** The letters a person is shown as: a CJK name → its first character; otherwise first and last
 *  initial, or the first two letters of a single name; a middle dot for no name at all. */
export function initials(name?: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '·';
  const firstChar = Array.from(trimmed)[0] ?? '';
  if (CJK.test(firstChar)) return firstChar;
  const [first = '', ...rest] = trimmed.split(/\s+/).filter(Boolean);
  const last = rest[rest.length - 1];
  const letters = last ? Array.from(first).slice(0, 1).join('') + Array.from(last).slice(0, 1).join('') : Array.from(first).slice(0, 2).join('');
  return letters.toUpperCase();
}

/* The label size follows the disc. text-micro (10px) is Latin/numeric only (D1): a CJK initial
   never drops below the 12px label step. */
function labelClass(size: number, cjk: boolean): string {
  if (size <= 30) return cjk ? 'text-label' : 'text-micro';
  if (size < 34) return 'text-label';
  return 'text-body';
}

export interface AvatarProps extends Omit<React.ComponentPropsWithoutRef<'span'>, 'color' | 'children'> {
  name: string;
  /** The person's presence colour; their disc is a 22% tint of it. */
  color?: string;
  kind?: 'user' | 'agent';
  /** `ink`: initials on an ink disc with no collar (the account's own face). */
  tone?: 'tint' | 'ink';
  /** Diameter in px (default 24). */
  size?: number;
  /** An agent at work: the silver ring and the sweeping glaze. */
  glaze?: boolean;
  /** Seconds; a second glazed face alternates with the first. */
  glazeDelay?: number;
  /** One of an overlapping row. */
  stacked?: boolean;
  /** The agent's mark (replaces the initials for `kind="agent"`). */
  icon?: React.ReactNode;
  /** Replaces the initials (e.g. the "+2" overflow disc). */
  children?: React.ReactNode;
}

/** Who is here, as one face: a disc on a 2px surface collar. */
export function Avatar({
  name,
  color = 'var(--ink)',
  kind = 'user',
  tone = 'tint',
  size = 24,
  glaze = false,
  glazeDelay = 0,
  stacked = false,
  icon,
  className,
  style,
  children,
  ...props
}: AvatarProps) {
  const content = children ?? (kind === 'agent' && icon ? icon : initials(name));
  const cjk = typeof content === 'string' && CJK.test(content);
  return (
    <span
      data-slot="avatar"
      data-kind={kind}
      role="img"
      aria-label={name}
      className={cn(
        'relative z-[1] grid flex-none select-none place-items-center overflow-hidden rounded-full bg-surface font-ui font-medium leading-none text-ink',
        labelClass(size, cjk),
        'shadow-[0_0_0_2px_var(--surface),0_0_0_3px_color-mix(in_srgb,var(--ink)_7%,transparent)]',
        glaze && 'z-[2] shadow-[0_0_0_2px_var(--surface),0_0_0_3px_var(--glaze-ring)]',
        tone === 'ink' && 'bg-ink text-paper shadow-none',
        stacked && (size <= 20 ? '-ms-[3px] first:ms-0' : '-ms-1 first:ms-0'),
        className,
      )}
      style={{
        width: size,
        height: size,
        ...(kind === 'user' && tone === 'tint' ? { background: `color-mix(in srgb, ${color} 22%, var(--surface))` } : {}),
        ...(glaze ? ({ '--glaze-delay': `${glazeDelay}s` } as React.CSSProperties) : {}),
        ...style,
      }}
      {...props}
    >
      {content}
    </span>
  );
}

export interface AvatarPerson {
  id: string;
  name: string;
  color?: string;
}

export interface AvatarStackProps extends Omit<React.ComponentPropsWithoutRef<'span'>, 'children'> {
  people: readonly AvatarPerson[];
  max?: number;
  size?: number;
}

/** A row of overlapping faces: the first `max` and a "+N" disc for the rest. */
export function AvatarStack({ people, max = 3, size = 24, className, ...props }: AvatarStackProps) {
  const t = useT();
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const moreLabel = t('fantay.ui.moreCount', { count: extra });
  return (
    <span
      data-slot="avatar-stack"
      className={cn('flex flex-none items-center', className)}
      title={people.map((person) => person.name).join(', ')}
      {...props}
    >
      {shown.map((person) => (
        <Avatar key={person.id} size={size} stacked name={person.name} color={person.color} />
      ))}
      {extra > 0 ? (
        <Avatar size={size} stacked name={moreLabel} color="var(--ink-faint)" title={moreLabel}>
          +{extra}
        </Avatar>
      ) : null}
    </span>
  );
}
