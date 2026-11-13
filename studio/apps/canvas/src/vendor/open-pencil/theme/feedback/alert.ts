// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/theme/feedback/alert.ts
// Modified by Fantay: no
const alertTheme = {
  slots: {
    root: 'flex items-start gap-2.5 rounded-lg border p-3 text-xs',
    icon: 'mt-0.5 size-4 shrink-0',
    content: 'min-w-0 flex-1',
    heading: 'font-medium leading-relaxed',
    description: 'mt-1 leading-relaxed text-surface',
    details: 'mt-2',
    actions: 'mt-2 flex flex-wrap items-center gap-2'
  },
  variants: {
    tone: {
      info: { root: 'border-border bg-panel-field text-surface', icon: 'text-muted' },
      success: { root: 'border-success/30 bg-success/5 text-surface', icon: 'text-success' },
      warning: { root: 'border-warning-border bg-warning-bg text-warning' },
      error: { root: 'border-error-border bg-error-bg text-error' }
    }
  },
  defaultVariants: { tone: 'info' as const }
} as const

export default alertTheme
