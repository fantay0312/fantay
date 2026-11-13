// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/theme/panel/item-row.ts
// Modified by Fantay: no
export default {
  slots: {
    root: 'group grid min-h-6 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-1.5 py-0.5',
    content: 'flex min-w-0 items-center gap-1.5',
    rail: 'flex shrink-0 items-center gap-0.5',
    details: 'col-span-2 min-w-0',
    remove: ''
  }
} as const
