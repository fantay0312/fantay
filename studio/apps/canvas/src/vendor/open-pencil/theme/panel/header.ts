// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/theme/panel/header.ts
// Modified by Fantay: no
const panelHeaderTheme = {
  slots: {
    root: 'grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 border-b border-border px-3 py-2 text-surface',
    icon: 'flex min-h-3.5 min-w-3.5 items-center justify-center text-muted',
    title: 'min-w-0 truncate text-xs font-semibold text-surface',
    actions:
      'flex min-w-0 items-center justify-end gap-0.5 [&_[data-slot=icon-button]]:size-6 [&_[data-slot=icon-button]]:rounded'
  },
  variants: {
    component: {
      true: {
        icon: 'text-component',
        title: 'text-component'
      },
      false: {}
    }
  },
  defaultVariants: {
    component: false
  }
}

export type PanelHeaderTheme = typeof panelHeaderTheme
export default panelHeaderTheme
