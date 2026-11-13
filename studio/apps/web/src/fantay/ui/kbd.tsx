'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/kbd.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: Fantay tokens, onInk/plain
 *   variants, platform-aware shortcut formatting (isMacPlatform, formatShortcut, KbdCombo).
 */
import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from './cn';

export type KbdVariant = 'default' | 'onInk' | 'plain';

/* A key cap: 20px tall, the key in mono micro type, edged by an inset hairline rather than a
   border so it sits flush inside a 28–32px control. */
export const kbdVariants = cva(
  'inline-flex h-5 min-w-5 flex-none items-center justify-center rounded-tag bg-transparent px-[5px] font-mono text-micro leading-none',
  {
    variants: {
      variant: {
        default: 'text-ink-faint shadow-[inset_0_0_0_1px_var(--line)]',
        onInk: 'text-paper/75 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--paper)_25%,transparent)]',
        plain: 'h-auto min-w-0 px-0 text-caption text-ink-faint shadow-none',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface KbdProps extends React.ComponentPropsWithoutRef<'kbd'> {
  variant?: KbdVariant;
}

export function Kbd({ className, variant = 'default', ...props }: KbdProps) {
  return <kbd data-slot="kbd" data-variant={variant} className={cn(kbdVariants({ variant }), className)} {...props} />;
}

interface NavigatorWithUAData extends Navigator {
  userAgentData?: { platform?: string };
}

/** macOS / iOS / iPadOS (by `navigator.userAgentData.platform`, else `navigator.platform`). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorWithUAData;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

const MAC_KEYS: Record<string, string> = {
  mod: '⌘',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  shift: '⇧',
  alt: '⌥',
  option: '⌥',
  opt: '⌥',
  ctrl: '⌃',
  control: '⌃',
  enter: '↵',
  return: '↵',
  backspace: '⌫',
  delete: '⌦',
  del: '⌦',
  esc: 'Esc',
  escape: 'Esc',
  tab: '⇥',
  space: 'Space',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

const OTHER_KEYS: Record<string, string> = {
  mod: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  meta: 'Win',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  esc: 'Esc',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

/** Splits on `+`, keeping a literal `+` key (`'mod++'`, `'+'`). */
function splitShortcut(shortcut: string): string[] {
  const keys: string[] = [];
  let current = '';
  for (const char of shortcut.trim()) {
    if (char === '+' && current !== '') {
      keys.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current !== '') keys.push(current);
  return keys;
}

/**
 * `'mod+shift+k'` → mac `['⌘', '⇧', 'K']`, other `['Ctrl', 'Shift', 'K']`. alt → ⌥/Alt,
 * ctrl → ⌃/Ctrl, enter → ↵/Enter, backspace → ⌫/Backspace, esc → Esc, up/down/left/right →
 * arrows, every other key upper-cased.
 */
export function formatShortcut(shortcut: string, platform?: 'mac' | 'other'): string[] {
  const table = (platform ?? (isMacPlatform() ? 'mac' : 'other')) === 'mac' ? MAC_KEYS : OTHER_KEYS;
  return splitShortcut(shortcut).map((key) => table[key.toLowerCase()] ?? key.toUpperCase());
}

export interface KbdComboProps {
  shortcut: string;
  variant?: KbdVariant;
  className?: string;
  platform?: 'mac' | 'other';
}

/** One key cap per key of `shortcut`, in platform order and glyphs. */
export function KbdCombo({ shortcut, variant = 'default', className, platform }: KbdComboProps) {
  const keys = formatShortcut(shortcut, platform);
  return (
    <span data-slot="kbd-combo" className={cn('inline-flex flex-none items-center gap-0.5', className)}>
      {keys.map((key, index) => (
        <Kbd key={`${index}-${key}`} variant={variant}>
          {key}
        </Kbd>
      ))}
    </span>
  );
}
