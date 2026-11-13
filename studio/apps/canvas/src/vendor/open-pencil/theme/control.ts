// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/theme/control.ts
// Modified by Fantay: no
export type ControlSize = 'xs' | 'sm' | 'md'

export const controlHeight = {
  xs: 'h-6',
  sm: 'h-7',
  md: 'h-8'
} satisfies Record<ControlSize, string>

export const squareControlSize = {
  xs: 'size-6',
  sm: 'size-7',
  md: 'size-8'
} satisfies Record<ControlSize, string>
