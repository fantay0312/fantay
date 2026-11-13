// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/theme/paint/field.ts
// Modified by Fantay: no
export default {
  slots: {
    root: 'flex h-6 min-w-0 flex-1 items-center overflow-hidden rounded border border-transparent bg-panel-field text-[11px] transition-colors hover:bg-panel-field-hover focus-within:border-panel-focus focus-within:bg-panel-field-hover',
    preview: 'flex shrink-0 items-center pl-1',
    value: 'flex min-w-0 flex-1 items-center pl-1 pr-1',
    divider: 'h-4 w-px shrink-0 bg-muted/40',
    opacity: 'h-full w-13 flex-none shrink-0',
    binding: 'flex shrink-0 items-center pr-0.5'
  }
} as const
